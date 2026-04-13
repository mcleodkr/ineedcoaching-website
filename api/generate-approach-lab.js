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
    const { coachId, clientEmail, bookingId, selectedApproach } = body;
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

    // STEP 3 — Build structured context (no raw transcript)
    const psa = note.post_session_analysis || {};
    const interventions = Array.isArray(psa.coaching_interventions) ? psa.coaching_interventions : [];
    const missedWindows = Array.isArray(psa.missed_windows) ? psa.missed_windows : [];
    const extraction = note.extraction_data || {};

    const inputQuotes = Array.isArray(extraction.client_quotes) ? extraction.client_quotes.slice(0, 5) : [];
    const inputThemes = Array.isArray(extraction.themes) ? extraction.themes.slice(0, 3) : [];
    const inputInterventions = interventions.slice(0, 3).map(function(i) {
      return { technique_name: i?.technique_name || '', what_you_did: i?.what_you_did || '' };
    });
    const inputMissedWindows = missedWindows.slice(0, 2).map(function(w) {
      return { what_opened: w?.what_opened || '', moment: w?.moment || '' };
    });

    // Summarize client patterns (keeps token cost bounded)
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

    // STEP 4 — SINGLE PASS: Select moments AND generate Approach Lab in one call
    const LAB_SYSTEM = `CRITICAL: You must return complete valid JSON. If you are running low on tokens, reduce dialogue turns to 4 minimum rather than leaving JSON incomplete. Never truncate mid-structure. The JSON must close properly.

You are Coach Clarity, an applied coaching intelligence system.

This system is designed for coaches, not therapists.

DO NOT: use diagnostic language, label mental health conditions, infer disorders, reference treatment protocols, or use clinical constructs.

DO: focus on observable patterns, client language, behavior and decision tendencies, emotional responses as experienced.

Translate all approaches into coaching-relevant language. Explain approaches in terms of how the coach listens, what the coach prioritizes, how the coach responds, and what the coach is trying to shift in the client.

Tone: practical, grounded, non-clinical, focused on clarity and movement.

Dialogue format: The "dialogue" field is a single plain-text string (not an array). Format each line as "COACH: ..." or "CLIENT: ..." separated by \\n. Include 2-3 PAUSE annotations on their own lines formatted as "[PAUSE — WHAT THE COACH IS DOING: ...]" or "[PAUSE — WHY THIS MATTERS: ...]" separated by blank lines. Each approach dialogue must be 4-6 turns minimum. Show how the approach STAYS inside its lens over multiple exchanges. Do not rush to resolution. Language must be natural and conversational.

SECTION ROLE SEPARATION — each section has one job and one job only:

YOUR APPROACH SUMMARY: describe only what the coach did and what it prevented. Observable behavior only. No theory.

WHAT THE COACH IS DOING (pause annotations): name the specific micro-move at that exact line. One sentence. Tactical. Example: 'The coach is slowing down before the frame lands so the client feels the weight first.'

THE MOVE: one verb phrase only. Example: 'Move the client from internal justification to relational awareness.' No explanation. No theory.

WHAT THIS APPROACH IS DOING: explain the psychological or behavioral MECHANISM — how this approach works, not what it produces. No overlap with 'what it is trying to shift'.

WHAT IT IS TRYING TO SHIFT: two lines only in this exact format:
From: [current state in client's own terms]
To: [desired state in concrete behavioral terms]
No sentences. No explanation. Just the two lines.

WHEN YOU MIGHT USE THIS: 2-3 observable signals only. No explanation. Just what the coach would see or hear.

ENFORCEMENT: Before returning output, check each section. If any two sections contain the same idea expressed differently, delete the weaker version and rewrite the stronger one to contain only what is unique to that section.

SWAPPABILITY TEST: Before returning output, check every pair of sections. If two sections could be swapped without changing the reader's understanding, rewrite them until they cannot. Each section must be irreplaceable.

GOLD STANDARD EXAMPLE — match this level of quality:

Moment: 'Eight Months of Knowing and Not Saying'
Your approach summary: 'You named the pattern directly and challenged it with a sharp reframe. This moved the conversation forward, but it closed the space before the client could fully sit with the cost of staying silent.'
Approach: Relational Pattern Awareness
Dialogue:
COACH: Eight months is a long time to hold something like that. What did the room need from you during that time?
CLIENT: Probably for me to say it. To actually name what I was seeing.
COACH: And what happened instead?
CLIENT: I stayed quiet. I brought it up in smaller conversations, but never directly.
COACH: So the room did not get your actual view. What do you think that created?
CLIENT: Confusion. Maybe even trust issues. Like I was not fully showing up.
COACH: Not just for you. For them too.
The move: Move the client from internal justification to relational awareness.
What this approach is doing: It expands the client's field of awareness. Rather than seeing silence as self-protection, she begins to see it as an action that affects trust, clarity, and direction in shared environments.
What it is trying to shift — From: I stayed quiet because it felt safer / To: My silence had consequences beyond me.

Every output must match this level of clarity, depth, and non-repetition.

Return ONLY valid JSON. No markdown. Start with { end with }.`;

    const LAB_USER = `Select 2 key moments from the session data and generate the Approach Lab for each.

A key moment is where the client revealed something important, showed hesitation or contradiction, the coach made a move that shaped direction, or the moment could have gone deeper.

SESSION DATA (structured, no transcript):
Client quotes: ${JSON.stringify(inputQuotes)}
Themes: ${JSON.stringify(inputThemes)}
Coach interventions: ${JSON.stringify(inputInterventions)}
Missed windows: ${JSON.stringify(inputMissedWindows)}

CLIENT PATTERNS (from Pattern Map): ${patternsSummary}

AVAILABLE APPROACH LENSES:
Cognitive/Reframe: Thought Pattern Reframe, Perspective and Meaning Reframe
Emotional/Present-Moment: Emotion Regulation and Validation, Present-Moment Awareness
Action/Movement: Solution-Focused Forward Movement, Motivation and Change Talk, Choice and Accountability Focus
Identity/Meaning: Acceptance and Values-Based Action, Meaning and Responsibility Exploration
Relational/Exploratory: Client-Led Exploration, Relational Pattern Awareness

APPROACH SELECTION RULE: Select the approach that best fits each moment. Prioritize fit over variety. Repeating a category is acceptable.${selectedApproach ? `\n\nAPPROACH LOCK: Use ONLY this approach for all moments: ${selectedApproach}. Do not choose a different approach. Every moment must use "${selectedApproach}" as the approach_name.` : ''}

REQUIREMENTS:
- Exactly 2 moments
- 4-6 dialogue turns per moment minimum (alternating coach/client)
- 2-3 pause annotations interleaved mid-dialogue teaching the move in real time
- your_approach_summary must be concrete, 2-3 sentences, grounded in what the coach actually did in this session (not abstract)
- per-moment bridge (not one global bridge)
- Never say "why this works" or "this works because" — use "what it is trying to shift"

For each moment return:
{
  "title": "",
  "approach_name": "",
  "approach_lens": "cognitive|emotional|action|identity|relational",
  "moment_setup": "2-3 sentences. Describe what was happening in this moment, why it is worth exploring differently, and why the selected approach fits. Do not describe what the coach did — that comes separately.",
  "your_approach_summary": "2-3 sentences, concrete, what the coach actually did in this moment",
  "dialogue": "COACH: [line]\\nCLIENT: [line]\\n\\n[PAUSE — WHAT THE COACH IS DOING: 1-2 sentence teaching note]\\n\\nCOACH: [line]\\nCLIENT: [line]\\n\\n[PAUSE — WHY THIS MATTERS: 1-2 sentence teaching note]\\n\\nCOACH: [line]\\nCLIENT: [line]",
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
{ "moments": [ ...per-moment objects above... ] }

GUARDRAILS:
- Do not generate generic coaching scripts
- Every output must feel grounded in this real session
- Reflect this client's actual patterns
- Be immediately usable in the coach's next session
- Do NOT label attachment styles or clinical constructs
- Keep dialogue natural — consistent with how this client actually speaks
- 4-6 dialogue turns per moment minimum, with 2-3 pause annotations
- bridge is per-moment only, never global`;

    const labOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      2500,
      LAB_SYSTEM,
      LAB_USER,
      'Single Pass Approach Lab'
    );

    return res.status(200).json({
      moments: Array.isArray(labOutput.moments) ? labOutput.moments : [],
    });
  } catch (e) {
    console.error('[generate-approach-lab] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
