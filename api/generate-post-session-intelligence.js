// POST { coachId, clientEmail, bookingId, existingGoals }
// 3-pass post-session intelligence pipeline: Extraction → Synthesis → Formatting

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {number} maxTokens
 * @param {string} system
 * @param {string} userMessage
 * @returns {Promise<object>}
 */
async function callClaude(apiKey, model, maxTokens, system, userMessage, passName) {
  console.log(`[${passName}] Using model: ${model}`);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[${passName}] Claude API error ${res.status}:`, errBody.substring(0, 1000));
    throw new Error(`${passName} Claude API error ${res.status}: ${errBody.substring(0, 200)}`);
  }

  let rawText;
  try {
    const data = await res.json();
    rawText = data.content?.[0]?.text || '';
  } catch (e) {
    const fallback = await res.text().catch(() => 'Could not read response');
    console.error(`[${passName}] Response was not valid JSON. Raw:`, fallback.substring(0, 1000));
    throw new Error(`${passName}: API response was not valid JSON`);
  }

  // Strip markdown code fences if present
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch (e) {
    console.error(`[${passName}] JSON parse failed. Raw response:`, rawText.substring(0, 2000));
    throw new Error(`${passName} JSON parse error: ${e.message}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coachId, clientEmail, bookingId, existingGoals } = body;

    if (!coachId || !bookingId) {
      return res.status(400).json({ error: 'Missing required fields: coachId, bookingId' });
    }

    const supabaseHeaders = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };

    // Fetch transcript and notes from coach_session_notes
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}&select=raw_transcript,notes`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const fetchData = await fetchRes.json();

    let sessionContent = '';
    if (fetchData && fetchData.length > 0) {
      if (fetchData[0].raw_transcript) {
        sessionContent = fetchData[0].raw_transcript;
      }
      if (fetchData[0].notes) {
        sessionContent += '\n\nSTRUCTURED NOTES:\n' + fetchData[0].notes;
      }
    }

    if (!sessionContent.trim()) {
      return res.status(400).json({ error: 'No transcript or notes found for this booking' });
    }

    // Shared constraints for all synthesis passes
    const CONCISE = 'Every string value: 1-2 sentences max, under 40 words. Surface the signal, not the essay.';
    const JSON_ONLY = 'Return ONLY raw JSON. No markdown. No explanation. No preamble. Start with { and end with }.';
    const TONE = 'Address coach as "you". Never use: should, must, ask the client, do this. Use: you might explore, this may suggest, one possible direction.';

    // ── Pass 1: Extraction ──────────────────────────────────────────────
    const extractionOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      1500,
      `You are an evidence extraction engine. Extract only what is explicitly present. Do not interpret. ${CONCISE} ${JSON_ONLY}`,
      `Extract from this session: client_quotes (max 5 verbatim), commitments, emotional_shifts [{before,after}], themes, coach_interventions, tension_points, mentioned_goals. All arrays of short strings.

${sessionContent}`,
      'Pass 1: Extraction'
    );

    // ── Pass 2a: Core Intelligence ──────────────────────────────────────
    const synthesisSystem = `You are a senior coaching intelligence system. ${TONE} ${CONCISE} ${JSON_ONLY}`;

    const coreOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      2000,
      synthesisSystem,
      `Generate CORE intelligence from this evidence. ${CONCISE}

EVIDENCE: ${JSON.stringify(extractionOutput)}

Return ONLY this JSON:
{"core_focus":{"summary":"","why_it_matters":""},"breakthrough":{"client_quote":"","what_changed":"","why_it_matters":"","reinforcement_suggestion":""},"pattern":{"name":"","description":"","trigger":"","behavior":"","timeline":{"past":"","present":"","future_risk":""},"next_session_watch":"","next_session_why":""},"strategic_direction":{"suggestion":"","why_it_matters":"","what_it_may_reveal":"","use_with_awareness":""},"early_cues":{"signals":[],"why_it_matters":""},"opening_question":{"question":"","why_start_here":""},"next_session":{"focus":"","listen_for":"","explore":"","if_shift":{"options":[],"why_it_matters":""}},"session_in_one_line":""}`,
      'Pass 2a: Core Intelligence'
    );

    // ── Pass 2b: Supporting Intelligence ────────────────────────────────
    const goalsContext = existingGoals && existingGoals.length
      ? '\nGoals: ' + existingGoals.join(', ')
      : '';

    const supportOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      2000,
      synthesisSystem,
      `Generate SUPPORTING intelligence. Stay consistent with core insights. ${CONCISE}${goalsContext}

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return ONLY this JSON:
{"friction_points":{"points":[],"why_it_matters":""},"if_stuck":{"scenario":"","explore":"","one_possible_direction":""},"goals":{"existing":[{"title":"","status":"","session_relevance":"","signal_reason":""}],"suggested":[{"title":"","description":"","suggested_target_date":""}]},"commitments":[{"text":"","priority":"","follow_up_question":""}],"between_session":[{"title":"","invitation":"","why_it_matters":"","connection":""}],"coaching_signals":[{"type":"","description":"","implication":""}],"frameworks":[{"name":"","presence_level":"","what_was_observed":"","what_it_suggests":"","build_on_this":"","mindful_of":""}],"coach_dna":{"patterns":[],"why_it_matters":""}}`,
      'Pass 2b: Supporting Intelligence'
    );

    // Merge 2a + 2b into one complete synthesis object
    const synthesisOutput = { ...coreOutput, ...supportOutput };

    // ── Pass 3: Formatting (fault-tolerant — fall back to synthesis if this fails)
    let formattedOutput;
    try {
      formattedOutput = await callClaude(
        ANTHROPIC_API_KEY,
        'claude-haiku-4-5-20251001',
        2000,
        `You are a UX writer. Fix directive language: should→you might explore, must→it may be worth, do not→one possible approach. Verify all why_it_matters fields are non-empty. ${JSON_ONLY}`,
        `Fix directive language in this JSON. Return corrected JSON with identical structure: ${JSON.stringify(synthesisOutput)}`,
        'Pass 3: Formatting'
      );
    } catch (e) {
      console.error('[Pass 3: Formatting] Failed, falling back to synthesis output:', e.message);
      formattedOutput = synthesisOutput;
    }

    // ── Pass 3b: Coaching Reflection (conditional, fault-tolerant) ──────
    try {
      const exchanges = (extractionOutput.client_quotes || []).length + (extractionOutput.coach_interventions || []).length;
      const hasCrisis = (extractionOutput.tension_points || []).some(t => /crisis|self.harm|suicid|emergenc/i.test(t));
      if (exchanges >= 10 && !hasCrisis) {
        const reflectionOutput = await callClaude(
          ANTHROPIC_API_KEY,
          'claude-sonnet-4-6',
          800,
          `You are a coaching reflection system. ${TONE} ${CONCISE} ${JSON_ONLY}`,
          `Based on this session evidence, generate a coaching reflection. ${CONCISE}

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return: {"session_type":"growth|processing|crisis_adjacent","what_stood_out":{"observation":"","why_it_matters":""},"what_seemed_effective":{"observation":"","why_it_matters":""},"one_thing_to_consider":{"suggestion":"You might consider...","why_it_matters":"","use_with_care":""}}
If session_type is processing: set what_seemed_effective and one_thing_to_consider to null.
If crisis_adjacent: return null.`,
          'Pass 3b: Coaching Reflection'
        );
        formattedOutput.coaching_reflection = reflectionOutput;
      } else {
        formattedOutput.coaching_reflection = null;
      }
    } catch (e) {
      console.error('[Pass 3b: Coaching Reflection] Failed, setting to null:', e.message);
      formattedOutput.coaching_reflection = null;
    }

    // ── Save results to Supabase ────────────────────────────────────────
    if (bookingId) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}`,
        {
          method: 'PATCH',
          headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({
            extraction_data: extractionOutput,
            synthesis_data: synthesisOutput,
            post_session_analysis: formattedOutput,
            pre_session_seed: formattedOutput.core_focus?.summary || null,
            coaching_signals: formattedOutput.coaching_signals || null,
            frameworks_detected: formattedOutput.frameworks || null,
          }),
        }
      );
    }

    // ── Auto-create action items from commitments ───────────────────────
    const commitments = formattedOutput.commitments;
    if (commitments && commitments.length > 0 && clientEmail) {
      const items = commitments.map((c) => ({
        coach_id: coachId,
        client_email: clientEmail,
        booking_id: bookingId || null,
        title: c.text,
        source: 'ai',
      }));

      await fetch(`${SUPABASE_URL}/rest/v1/coach_action_items`, {
        method: 'POST',
        headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(items),
      });
    }

    return res.status(200).json(formattedOutput);
  } catch (e) {
    console.error('[generate-post-session-intelligence] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
