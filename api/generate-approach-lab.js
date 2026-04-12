// POST { coachId, clientEmail, bookingId }
// Approach Lab — two-pass Claude generation that surfaces 3-4 key moments from
// a session and replays each through a different coaching lens, plus a bridge
// section connecting the new approaches to the coach's existing style.

async function callClaude(apiKey, model, maxTokens, system, userMessage, passName) {
  console.log(`[ApproachLab ${passName}] model: ${model}`);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMessage }] }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ApproachLab ${passName} API error ${res.status}: ${err.substring(0, 200)}`);
  }
  const data = await res.json();
  let raw = data.content?.[0]?.text || '';
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Try direct parse first
  try {
    return JSON.parse(raw);
  } catch (e1) {
    // Try bracket extraction (array first, then object)
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch (e2) {}
    }
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0]); } catch (e3) {}
    }
    // Progressive trim from end to find valid JSON
    for (let i = raw.length; i > raw.length * 0.5; i--) {
      const trimmed = raw.substring(0, i);
      const lastClose = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
      if (lastClose === -1) continue;
      try {
        return JSON.parse(trimmed.substring(0, lastClose + 1));
      } catch (e4) { continue; }
    }
    throw new Error(`ApproachLab ${passName} JSON parse error: ${e1.message}`);
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
  if (!SUPABASE_KEY || !ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coachId, clientEmail, bookingId } = body;
    if (!coachId || !bookingId) return res.status(400).json({ error: 'Missing required fields: coachId, bookingId' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // STEP 1 — Fetch session data
    const notesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}&select=raw_transcript,post_session_analysis,extraction_data&limit=1`,
      { headers }
    );
    const notesRows = await notesRes.json();
    const note = Array.isArray(notesRows) && notesRows.length ? notesRows[0] : null;

    if (!note || (!note.raw_transcript && !note.post_session_analysis)) {
      return res.status(200).json({ error: 'No session data available. Run Coach Clarity first.' });
    }

    // STEP 2 — Fetch client pattern map
    let clientPatterns = null;
    if (clientEmail) {
      const patternsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_client_patterns?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&select=pattern_map&limit=1`,
        { headers }
      );
      const patternsRows = await patternsRes.json();
      if (Array.isArray(patternsRows) && patternsRows.length && patternsRows[0].pattern_map) {
        clientPatterns = patternsRows[0].pattern_map;
      }
    }

    // STEP 3 — Build context
    const fullTranscript = note.raw_transcript || '';
    const transcript = fullTranscript.length > 6000 ? fullTranscript.substring(0, 6000) : fullTranscript;
    const psa = note.post_session_analysis || {};
    const interventions = Array.isArray(psa.coaching_interventions) ? psa.coaching_interventions : [];
    const missedWindows = Array.isArray(psa.missed_windows) ? psa.missed_windows : [];
    const extraction = note.extraction_data || {};
    const clientQuotes = Array.isArray(extraction.client_quotes) ? extraction.client_quotes.slice(0, 8) : [];

    // Structured-only Pass 1 inputs — no raw transcript. Trimmed to essentials.
    const pass1Quotes = Array.isArray(extraction.client_quotes) ? extraction.client_quotes.slice(0, 5) : [];
    const pass1Themes = Array.isArray(extraction.themes) ? extraction.themes.slice(0, 3) : [];
    const pass1Interventions = interventions.slice(0, 3).map(function(i) {
      return { technique_name: i?.technique_name || '', what_you_did: i?.what_you_did || '' };
    });
    const pass1MissedWindows = missedWindows.slice(0, 2).map(function(w) {
      return { what_opened: w?.what_opened || '', moment: w?.moment || '' };
    });

    // Summarize client patterns for pass 2 prompt (keeps token cost bounded)
    let patternsSummary;
    if (clientPatterns) {
      const corePatterns = Array.isArray(clientPatterns.core_patterns) ? clientPatterns.core_patterns.slice(0, 5) : [];
      const whereStuck = Array.isArray(clientPatterns.where_they_get_stuck) ? clientPatterns.where_they_get_stuck.slice(0, 3) : [];
      const likelyDrivers = Array.isArray(clientPatterns.likely_drivers) ? clientPatterns.likely_drivers.slice(0, 3) : [];
      patternsSummary = JSON.stringify({
        core_patterns: corePatterns,
        where_they_get_stuck: whereStuck,
        likely_drivers: likelyDrivers,
      });
    } else {
      patternsSummary = 'Pattern Map not yet generated';
    }

    // STEP 4a — PASS 1: Moment Selection
    const PASS1_SYSTEM = `You are Coach Clarity. Select up to 3 key moments from this session. A key moment is where the client revealed something important, showed hesitation or contradiction, the coach made a move that shaped direction, or the moment could have gone deeper. Return ONLY a JSON array. Maximum 3 items. Keep each field under 15 words. Complete the array even if brief.`;

    const PASS1_USER = `Session signals (no transcript):

Client quotes: ${JSON.stringify(pass1Quotes)}
Themes: ${JSON.stringify(pass1Themes)}
Coach interventions: ${JSON.stringify(pass1Interventions)}
Missed windows: ${JSON.stringify(pass1MissedWindows)}

Select up to 3 key moments from these signals. Maximum 3. Each field under 15 words. Return ONLY:
[{ "title": "short title", "what_happened": "one sentence", "client_quote": "short quote", "coach_move": "what coach did", "moment_type": "revelation|hesitation|contradiction|emotional_weight|coaching_move" }]`;

    const pass1Output = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      400,
      PASS1_SYSTEM,
      PASS1_USER,
      'Pass 1 Moment Selection'
    );

    // STEP 4b — PASS 2: Approach Lab Generation
    const PASS2_SYSTEM = `You are Coach Clarity, an applied coaching intelligence system.

This system is designed for coaches, not therapists.

DO NOT: use diagnostic language, label mental health conditions, infer disorders, reference treatment protocols, or use clinical constructs.

DO: focus on observable patterns, client language, behavior and decision tendencies, emotional responses as experienced.

Translate all approaches into coaching-relevant language. Explain approaches in terms of how the coach listens, what the coach prioritizes, how the coach responds, and what the coach is trying to shift in the client.

Tone: practical, grounded, non-clinical, focused on clarity and movement.

Be concise where instructed. Complete the JSON structure even if content is brief.

Dialogue requirements: Each approach dialogue must be 6-10 turns minimum. Show how the approach STAYS inside its lens over multiple exchanges. Include 2-3 PAUSE annotations inside the dialogue to teach the move in real time. Do not rush to resolution. Language must be natural and conversational.

Return ONLY valid JSON. No markdown. Start with { end with }.`;

    const PASS2_USER = `Generate an Approach Lab for this coaching session.

KEY MOMENTS SELECTED: ${JSON.stringify(pass1Output)}

CLIENT PATTERNS (from Pattern Map): ${patternsSummary}

AVAILABLE APPROACH LENSES:
Cognitive/Reframe: Thought Pattern Reframe, Perspective and Meaning Reframe
Emotional/Present-Moment: Emotion Regulation and Validation, Present-Moment Awareness
Action/Movement: Solution-Focused Forward Movement, Motivation and Change Talk, Choice and Accountability Focus
Identity/Meaning: Acceptance and Values-Based Action, Meaning and Responsibility Exploration
Relational/Exploratory: Client-Led Exploration, Relational Pattern Awareness

APPROACH SELECTION RULE: Select the approach that best fits each moment. Prioritize fit over variety. Repeating a category is acceptable.

REQUIREMENTS:
- 6-10 dialogue turns per moment (alternating coach/client)
- 2-3 pause annotations interleaved mid-dialogue teaching the move in real time
- your_approach_summary must be concrete, 2-3 sentences, grounded in what the coach actually did in this session (not abstract)
- per-moment bridge (not one global bridge)
- Never say "why this works" or "this works because" — use "what it is trying to shift"

For each moment return:
{
  "title": "",
  "approach_name": "",
  "approach_lens": "cognitive|emotional|action|identity|relational",
  "your_approach_summary": "2-3 sentences, concrete, what the coach actually did in this moment",
  "dialogue_with_teaching": [
    { "type": "line", "speaker": "coach", "text": "" },
    { "type": "line", "speaker": "client", "text": "" },
    { "type": "pause", "label": "WHAT THE COACH IS DOING", "text": "1-2 sentence teaching note" },
    { "type": "line", "speaker": "coach", "text": "" }
  ],
  "the_move": "1-2 sentences naming the specific coaching move being demonstrated",
  "what_this_approach_is_doing": "3-4 sentences plain language",
  "what_it_is_trying_to_shift": "what change it attempts — no certainty implied",
  "when_you_might_use_this": ["cue 1", "cue 2", "cue 3"],
  "bridge": {
    "aligns": ["You already do this when..."],
    "stretches": ["This approach would stretch you by..."]
  }
}

Full schema:
{
  "moments": [ ...per-moment objects above... ]
}

GUARDRAILS:
- Do not generate generic coaching scripts
- Every output must feel grounded in this real session
- Reflect this client's actual patterns
- Be immediately usable in the coach's next session
- Do NOT label attachment styles or clinical constructs
- Keep dialogue natural — consistent with how this client actually speaks
- 6-10 dialogue turns per moment minimum, with 2-3 pause annotations
- bridge is per-moment only, never global`;

    const pass2Output = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      5000,
      PASS2_SYSTEM,
      PASS2_USER,
      'Pass 2 Approach Lab'
    );

    return res.status(200).json({
      moments: Array.isArray(pass2Output.moments) ? pass2Output.moments : [],
    });
  } catch (e) {
    console.error('[generate-approach-lab] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
