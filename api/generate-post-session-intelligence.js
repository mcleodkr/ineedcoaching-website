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
    const IDENTITY = 'You are Coach Clarity, a reflective thinking partner for coaches. Your role is to surface patterns and possibilities, not to instruct. Think WITH the coach, not FOR them. All language must be suggestive, not prescriptive.';

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
    const synthesisSystem = `${IDENTITY} ${TONE} ${CONCISE} ${JSON_ONLY}`;

    const coreOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      2000,
      synthesisSystem,
      `Generate CORE intelligence from this evidence. ${CONCISE}

For these fields, add an optional transition_context string — one sentence max, under 20 words, connecting this section to what came before. Return null if no natural connection exists. Use these starters: strategic_direction: "Because this pattern showed up..." or "Given what emerged..."; early_cues: "If this pattern is still active..."; next_session: "Given what shifted and what remains fragile..."; friction_points: "The most likely place this progress could stall..."; if_stuck: "If that stalling happens...".

Also generate emotional_anchor — one sentence under 20 words capturing the human stakes of this session. Not clinical. Not mechanical. The real weight of what this client is carrying. Return null if nothing meaningful. Examples: "This is not a skill gap — it is a permission shift that has not fully stabilized yet." "Eight months of private certainty is now a public test."

EVIDENCE: ${JSON.stringify(extractionOutput)}

Return ONLY this JSON:
{"key_insights":["what client is doing or avoiding, max 20 words","what shifted this session if anything, max 20 words","what matters most to watch next session, max 20 words"],"core_focus":{"summary":"","why_it_matters":"","transition_context":""},"breakthrough":{"client_quote":"","what_changed":"","why_it_matters":"","reinforcement_suggestion":"","transition_context":""},"pattern":{"name":"","description":"","trigger":"","behavior":"","timeline":{"past":"","present":"","future_risk":""},"next_session_watch":"","next_session_why":"","transition_context":""},"emotional_anchor":"one sentence — the human stakes, not clinical","strategic_direction":{"suggestion":"","why_it_matters":"","what_it_may_reveal":"","use_with_awareness":"","transition_context":""},"early_cues":{"signals":[],"why_it_matters":"","transition_context":""},"opening_question":{"question":"","why_start_here":"","transition_context":""},"next_session":{"focus":"","listen_for":"","explore":"","if_shift":{"options":[],"why_it_matters":""},"transition_context":""},"session_in_one_line":""}`,
      'Pass 2a: Core Intelligence'
    );

    // ── Pass 2b: Coaching Interventions (isolated to prevent truncation) ─
    const goalsContext = existingGoals && existingGoals.length
      ? '\nGoals: ' + existingGoals.join(', ')
      : '';

    const MIRROR_RULES = `You are Coach Clarity. HARD LIMIT: Maximum 2 items per array. Maximum 15 words per string value. If you exceed these limits the output will be rejected. Return incomplete items as null rather than truncating mid-string. Return ONLY raw JSON starting with { and ending with }. ${TONE}`;

    // ── Pass 2b: Interventions + Reflection ─────────────────────────────
    const pass2bOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      1800,
      MIRROR_RULES,
      `Generate max 2 coaching interventions and reflection. Max 15 words per value.

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return ONLY:
{"coaching_interventions":[{"technique_used":"","what_you_did":"You said: [quote]","immediate_effect":"","why_it_mattered":"","signal_strength":"high|medium|low","evidence_anchor":"","dna_tag":[],"consideration":null}],"reflection_and_growth":{"what_stood_out_in_your_approach":"","what_seemed_effective":"","one_place_to_stay_curious":""},"what_stood_out":[{"signal_label":"","what_happened_client":"","where_you_were":"","why_it_matters":""}],"friction_points":{"points":[],"why_it_matters":"","transition_context":null},"if_stuck":{"scenario":"","explore":"","one_possible_direction":"","transition_context":null},"commitments":[{"text":"","priority":"","follow_up_question":""}]}`,
      'Pass 2b: Interventions'
    );

    // ── Pass 2c: Curiosity Edges only ───────────────────────────────────
    const pass2cOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      800,
      MIRROR_RULES,
      `Generate max 2 curiosity edges. Max 15 words per value.

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return ONLY:
{"curiosity_edges":[{"curiosity_note":"","what_to_notice":"","why_this_stands_out":""}]}`,
      'Pass 2c: Curiosity'
    );

    // ── Pass 2d: Patterns + Goals + Frameworks + Between-session ────────
    const pass2dOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      800,
      MIRROR_RULES,
      `Generate max 2 patterns and supporting fields. Max 15 words per value.
${goalsContext}

EVIDENCE: ${JSON.stringify(extractionOutput)}
CORE: ${JSON.stringify(coreOutput)}

Return ONLY:
{"patterns_and_your_role":[{"pattern_name":"","what_client_did":"","your_role":"interrupted|reinforced|allowed","how_you_influenced_it":"","current_status":"emerging|disrupted|stabilizing|unchanged"}],"goals":{"existing":[{"title":"","status":"","session_relevance":"","signal_reason":""}],"suggested":[{"title":"","description":"","suggested_target_date":""}]},"between_session":[{"title":"","invitation":"","why_it_matters":"","connection":""}],"frameworks":[{"name":"","presence_level":"","what_was_observed":"","what_it_suggests":"","build_on_this":"","mindful_of":""}]}`,
      'Pass 2d: Patterns'
    );

    // Merge 2a + 2b + 2c + 2d into one complete synthesis object
    const synthesisOutput = { ...coreOutput, ...pass2bOutput, ...pass2cOutput, ...pass2dOutput };

    // ── Pass 3: Formatting (fault-tolerant — fall back to synthesis if this fails)
    // Pre-clean directive language via string replacement before AI pass
    let preCleaned = JSON.stringify(synthesisOutput);
    const replacements = [
      [/\bDon't\b/g, 'You might consider not'], [/\bdon't\b/g, 'you might consider not'],
      [/\bDo not\b/g, 'It may be worth avoiding'], [/\bdo not\b/g, 'it may be worth avoiding'],
      [/\bmust\b/gi, 'may want to'], [/\byou should\b/gi, 'you might'],
      [/\bask her\b/gi, 'you might explore with them'], [/\bask him\b/gi, 'you might explore with them'],
      [/\bask them\b/gi, 'you might explore with them'],
      [/\btell her\b/gi, 'you might share with them'], [/\btell him\b/gi, 'you might share with them'],
    ];
    for (const [pat, rep] of replacements) { preCleaned = preCleaned.replace(pat, rep); }

    let formattedOutput;
    try {
      formattedOutput = await callClaude(
        ANTHROPIC_API_KEY,
        'claude-haiku-4-5-20251001',
        2000,
        `You are a UX writer for Coach Clarity. Scan every string value. Any directive language — commands, instructions, statements that remove the coach's choice — must be rewritten as a suggestive alternative. Fix: should→you might explore, must→it may be worth, do not→one possible approach. Verify all why_it_matters fields are non-empty. ${JSON_ONLY}`,
        `Fix directive language in this JSON. Return corrected JSON with identical structure: ${preCleaned}`,
        'Pass 3: Formatting'
      );
    } catch (e) {
      console.error('[Pass 3: Formatting] Failed, falling back to pre-cleaned synthesis:', e.message);
      try { formattedOutput = JSON.parse(preCleaned); } catch (_) { formattedOutput = synthesisOutput; }
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
