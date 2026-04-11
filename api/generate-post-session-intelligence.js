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
async function callClaude(apiKey, model, maxTokens, system, userMessage) {
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
    throw new Error(`Claude API error: ${res.status}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : JSON.parse(text);
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

    // ── Pass 1: Extraction ──────────────────────────────────────────────
    const extractionOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6-20250514',
      2000,
      'You are an evidence extraction engine. Extract only what is explicitly present. Do not interpret or infer. Return JSON only.',
      `Extract structured evidence from this coaching session transcript and notes.

Return a JSON object with these fields:
- "client_quotes": array of verbatim client quotes that are significant
- "commitments": array of explicit agreements or commitments made
- "emotional_shifts": array of objects with "before" and "after" describing emotional transitions
- "themes": array of repeated phrases, beliefs, or recurring topics
- "coach_interventions": array of notable coach questions, reframes, or techniques used
- "tension_points": array of moments of avoidance, resistance, or discomfort
- "mentioned_goals": array of any goals explicitly mentioned or discussed

TRANSCRIPT AND NOTES:
${sessionContent}`
    );

    // ── Pass 2: Synthesis ───────────────────────────────────────────────
    const goalsContext = existingGoals && existingGoals.length
      ? '\n\nExisting client goals:\n' + existingGoals.map((g, i) => `${i + 1}. ${g}`).join('\n')
      : '';

    const synthesisOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6-20250514',
      3000,
      `You are a senior coaching intelligence system. Interpret extracted session evidence into structured coaching insights. Address the coach as "you" throughout. Use only suggestive language. Never use: should, must, ask the client, do this. Always use: you might explore, this may suggest, one possible direction. Every insight must include why it matters. Return JSON only.`,
      `Using the extracted session evidence below, generate a structured coaching intelligence report.
${goalsContext}

EXTRACTED EVIDENCE:
${JSON.stringify(extractionOutput, null, 2)}

Return a JSON object with this exact structure:
{
  "core_focus": { "summary": "", "why_it_matters": "" },
  "breakthrough": { "client_quote": "", "what_changed": "", "why_it_matters": "", "reinforcement_suggestion": "" },
  "pattern": { "name": "", "description": "", "trigger": "", "behavior": "", "timeline": {"past":"","present":"","future_risk":""}, "next_session_watch": "", "next_session_why": "" },
  "strategic_direction": { "suggestion": "", "why_it_matters": "", "what_it_may_reveal": "", "use_with_awareness": "" },
  "early_cues": { "signals": [], "why_it_matters": "" },
  "opening_question": { "question": "", "why_start_here": "" },
  "next_session": { "focus": "", "listen_for": "", "explore": "", "if_shift": { "options": [], "why_it_matters": "" } },
  "friction_points": { "points": [], "why_it_matters": "" },
  "if_stuck": { "scenario": "", "explore": "", "one_possible_direction": "" },
  "goals": { "existing": [{"title":"","status":"","session_relevance":"","signal_reason":""}], "suggested": [{"title":"","description":"","suggested_target_date":""}] },
  "commitments": [{ "text": "", "priority": "", "follow_up_question": "" }],
  "between_session": [{ "title": "", "invitation": "", "why_it_matters": "", "connection": "" }],
  "coaching_signals": [{ "type": "", "description": "", "implication": "" }],
  "frameworks": [{ "name": "", "presence_level": "", "what_was_observed": "", "what_it_suggests": "", "build_on_this": "", "mindful_of": "" }],
  "coach_dna": { "patterns": [], "why_it_matters": "" },
  "coaching_reflection": null,
  "session_in_one_line": ""
}

For coaching_reflection: set to null unless ALL of these are true: session has 10+ meaningful exchanges, session is not logistical, has no crisis language, and coach presence is meaningful. When generated, use this structure:
{ "session_type": "growth"|"processing"|"crisis_adjacent", "what_stood_out": {"observation":"", "why_it_matters":""}, "what_seemed_effective": {"observation":"", "why_it_matters":""}|null, "one_thing_to_consider": {"suggestion":"", "why_it_matters":"", "use_with_care":""}|null }`
    );

    // ── Pass 3: Formatting ──────────────────────────────────────────────
    const formattedOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-haiku-4-5-20251001',
      2000,
      `You are a UX writer for a coaching intelligence platform. Review the structured JSON and correct any remaining directive language. Find every instance of: should, must, do not, don't, ask her/him/them, you need to, have to — and rewrite as suggestive alternatives (you might explore, it may be worth considering, one possible approach). Also verify every section has a non-empty why_it_matters field. Return the corrected JSON only with identical structure.`,
      `Review and correct the following coaching intelligence JSON. Replace any directive language with suggestive alternatives. Ensure all why_it_matters fields are populated. Return the corrected JSON only.

${JSON.stringify(synthesisOutput, null, 2)}`
    );

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
