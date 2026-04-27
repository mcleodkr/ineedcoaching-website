// POST { coachId }
// Identity-level Coach DNA derived from accumulated Coaching Mirror outputs.
// Produces 10 sections: decision model, intervention sequence, pattern activation map,
// technique profile, bias profile, client response signature, growth edges,
// blind spots, missed leverage moments, evolution signal.

import { logAIUsage } from '../lib/ai-usage.js';

async function callClaude(apiKey, model, maxTokens, system, userMessage, passName, meta) {
  console.log(`[DNA ${passName}] model: ${model}`);
  const startTime = Date.now();
  let res, data;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMessage }] }),
    });
    data = await res.json().catch(function() { return null; });
  } catch (err) {
    await logAIUsage({ feature: (meta && meta.feature) || 'coach_dna', coachId: meta && meta.coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    throw err;
  }
  await logAIUsage({
    feature: (meta && meta.feature) || 'coach_dna',
    coachId: meta && meta.coachId,
    model: (data && data.model) || model,
    usage: data && data.usage,
    requestId: data && data.id,
    status: res.ok ? 'success' : 'error',
    errorMessage: res.ok ? null : (data && data.error && data.error.message),
    durationMs: Date.now() - startTime,
  });
  if (!res.ok) {
    const err = data ? JSON.stringify(data).slice(0, 200) : '(no body)';
    throw new Error(`DNA ${passName} API error ${res.status}: ${err}`);
  }
  let raw = data.content?.[0]?.text || '';
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Try direct parse first
  try {
    return JSON.parse(raw);
  } catch (e1) {
    // Try extracting first complete JSON object
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) {}
    }
    // Progressive trim from end to find valid JSON
    for (let i = raw.length; i > raw.length * 0.5; i--) {
      const trimmed = raw.substring(0, i);
      const lastBrace = trimmed.lastIndexOf('}');
      if (lastBrace === -1) continue;
      try {
        return JSON.parse(trimmed.substring(0, lastBrace + 1));
      } catch (e3) { continue; }
    }
    throw new Error(`DNA ${passName} JSON parse error: ${e1.message}`);
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
    const { coachId } = body;
    if (!coachId) return res.status(400).json({ error: 'Missing coachId' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    const notesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&post_session_analysis=not.is.null&select=post_session_analysis,client_email,created_at&order=created_at.desc&limit=20`,
      { headers }
    );
    const notes = await notesRes.json();

    if (!notes || notes.length < 5) {
      return res.status(200).json({ locked: true, session_count: notes ? notes.length : 0, needed: 5 });
    }

    // Aggregate Mirror outputs into identity-relevant signals per session
    const mirrorData = notes
      .map((n, idx) => {
        const m = n.post_session_analysis || {};
        const interventions = Array.isArray(m.coaching_interventions) ? m.coaching_interventions : [];
        const missed = Array.isArray(m.missed_windows) ? m.missed_windows : [];
        const stood = Array.isArray(m.what_stood_out) ? m.what_stood_out : [];
        return {
          session_index: idx + 1,
          client_email: n.client_email,
          created_at: n.created_at,
          coach_moves: interventions
            .map((i) => ({
              move_type: i.technique_name || '',
              evidence: i.what_you_did || '',
              immediate_effect: i.immediate_effect || '',
              why_mattered: i.why_it_mattered || '',
              signal_strength: i.signal_strength || '',
            }))
            .filter((mv) => mv.move_type),
          sequence_of_moves: interventions.map((i) => i.technique_name).filter(Boolean),
          triggers: missed
            .map((w) => ({
              signal_type: w.signal_type || '',
              moment: w.moment || '',
              strength: w.signal_strength || '',
            }))
            .filter((t) => t.signal_type || t.moment),
          client_responses: stood
            .map((s) => ({
              title: s.title || '',
              client_did: s.what_happened_client || '',
              your_impact: s.your_impact || '',
            }))
            .filter((c) => c.title || c.client_did),
          missed_opportunities: missed.map((w) => ({
            signal_type: w.signal_type || '',
            signal_strength: w.signal_strength || '',
            moment: w.moment || '',
            underneath: w.what_was_underneath || '',
            what_was_possible: w.what_was_possible || '',
            why_matters: w.why_this_matters_for_your_work || '',
          })),
          what_effective: m.reflection_and_growth?.what_seemed_effective || null,
          stay_curious: m.reflection_and_growth?.one_place_to_stay_curious || null,
        };
      })
      // Filter out old-schema sessions with no usable signal
      .filter((s) => s.coach_moves.length > 0 || s.missed_opportunities.length > 0);

    // Get coach profile
    const coachRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=specialties,headline,bio,feedback_style`, { headers });
    const coaches = await coachRes.json();
    const coach = coaches?.[0] || {};

    const SYSTEM = `You are Coach Clarity, an identity-level intelligence system that builds pattern-level Coach DNA profiles.

PRONOUN DEFAULT: When referring to clients in the synthesized DNA output, use they/them/their. Never infer pronouns from names or any demographic cue. Even when source Mirror outputs use a specific pronoun, prefer they/them in the aggregated DNA narrative unless the same pronoun set is consistent across most sessions for that same client.

IDENTITY-LEVEL THINKING:
- Surface the COACH as a decision-maker, not a style label. DNA is how this coach thinks under pressure.
- Every insight must be traceable to at least 2 sessions. Use frequency counts and trajectory to ground every claim.
- Distinguish what the coach actually DID from what they intended to do. Use only Mirror outputs, never stated intentions.
- Trajectory values: "Increasing" (more frequent recently), "Stable" (consistent across sessions), "Decreasing" (less recent), "Emerging" (appeared in last 2 sessions only), "Underutilized" (appeared 1-2 times total).
- Frequency format: "X of last Y sessions".

HARD LIMITS:
- Maximum 3 items per array.
- Maximum 20 words per string value.

LANGUAGE RULES:
- Never clinical (no CBT, DBT, ACT, diagnosis, pathology).
- Use coaching-safe language only: pattern awareness, emotional regulation strategy, strategic questioning, behavioral reframing, values clarification.
- Never "you should". Use "you tend to", "across sessions you", "you consistently".
- No em dashes in JSON string values.

Return ONLY raw JSON. Start with { end with }. No markdown. No preamble.`;

    const clientCount = new Set(notes.map((n) => n.client_email).filter(Boolean)).size;
    const contextPreamble = `Analyze ${notes.length} sessions across ${clientCount} clients.

Coach specialties: ${JSON.stringify(coach.specialties || [])}
Coach headline: ${coach.headline || 'Not set'}

MIRROR DATA (aggregated from ${notes.length} sessions, most recent first):
${JSON.stringify(mirrorData)}`;

    const USER_PASS1 = `${contextPreamble}

Derive sections 1-5 of the Coach DNA profile. Every pattern must appear in 2+ sessions. MAX 3 items per array. MAX 20 words per string value.

Return ONLY this JSON:
{
  "session_count": number,
  "client_count": number,
  "coaching_decision_model": [
    {
      "trigger": "when [observable client state]",
      "default_response": "you tend to [specific coach move]",
      "rationale": "short reason",
      "frequency": "X of last Y sessions",
      "trajectory": "Increasing|Stable|Decreasing|Emerging|Underutilized"
    }
  ],
  "default_intervention_sequence": {
    "description": "one sentence summary of your typical flow",
    "typical_sequence": ["step 1", "step 2", "step 3"],
    "variations": [
      { "when": "condition", "sequence": ["alt step 1", "alt step 2"] }
    ]
  },
  "pattern_activation_map": [
    {
      "pattern_name": "short name",
      "trigger": "what activates it",
      "typical_response": "how you meet it",
      "frequency": "X of last Y sessions",
      "trajectory": "..."
    }
  ],
  "technique_profile": [
    {
      "technique": "technique name",
      "definition": "one short sentence",
      "frequency": "X of last Y sessions",
      "trajectory": "...",
      "observed_when": "situation"
    }
  ],
  "bias_profile": [
    {
      "bias": "e.g. speed over depth",
      "description": "what it does",
      "evidence": "observable pattern",
      "trajectory": "..."
    }
  ]
}

CRITICAL: Return ONLY valid JSON. No trailing commas. No comments. No markdown. Every array must be properly closed. Start with { and end with }.`;

    const USER_PASS2 = `${contextPreamble}

Derive sections 6-10 of the Coach DNA profile. Every pattern must appear in 2+ sessions. MAX 3 items per array. MAX 20 words per string value. For evolution_signal compare earliest third of sessions to most recent third.

Return ONLY this JSON:
{
  "client_response_signature": [
    {
      "response_type": "how clients tend to move",
      "description": "what this looks like",
      "frequency": "X of last Y sessions"
    }
  ],
  "growth_edges": [
    {
      "pattern": "short name",
      "what_you_tend_to_do": "observable tendency",
      "what_is_missing": "what would deepen this",
      "what_to_try": "one concrete next move",
      "frequency": "X of last Y sessions",
      "trajectory": "..."
    }
  ],
  "blind_spots": [
    {
      "pattern_name": "short name",
      "description": "what this pattern is",
      "where_it_shows_up": "situation",
      "impact": "what it costs the work",
      "frequency": "X of last Y sessions",
      "trajectory": "..."
    }
  ],
  "missed_leverage_moments": [
    {
      "moment": "what happened",
      "signal": "cue present",
      "why_high_leverage": "what was possible",
      "frequency": "X of last Y sessions"
    }
  ],
  "evolution_signal": {
    "first_third_summary": "what you did earliest",
    "last_third_summary": "what you tend to do now",
    "trajectory_summary": "one sentence naming the shift",
    "emerging_strengths": ["string"],
    "fading_habits": ["string"]
  }
}

CRITICAL: Return ONLY valid JSON. No trailing commas. No comments. No markdown. Every array must be properly closed. Start with { and end with }.`;

    const [pass1Output, pass2Output] = await Promise.all([
      callClaude(ANTHROPIC_API_KEY, 'claude-sonnet-4-6', 2000, SYSTEM, USER_PASS1, 'Pass 1 (1-5)', { feature: 'coach_dna', coachId }),
      callClaude(ANTHROPIC_API_KEY, 'claude-sonnet-4-6', 2000, SYSTEM, USER_PASS2, 'Pass 2 (6-10)', { feature: 'coach_dna', coachId }),
    ]);

    const dnaOutput = Object.assign({}, pass1Output, pass2Output);

    const existRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&select=id`, { headers });
    const existing = await existRes.json();

    const dnaPayload = {
      coach_id: coachId,
      framework_distribution: dnaOutput.pattern_activation_map || [],
      signal_patterns: {
        coaching_decision_model: dnaOutput.coaching_decision_model || [],
        default_intervention_sequence: dnaOutput.default_intervention_sequence || null,
        pattern_activation_map: dnaOutput.pattern_activation_map || [],
        technique_profile: dnaOutput.technique_profile || [],
        bias_profile: dnaOutput.bias_profile || [],
        client_response_signature: dnaOutput.client_response_signature || [],
        growth_edges: dnaOutput.growth_edges || [],
        blind_spots: dnaOutput.blind_spots || [],
        missed_leverage_moments: dnaOutput.missed_leverage_moments || [],
        evolution_signal: dnaOutput.evolution_signal || null,
      },
      growth_edges: dnaOutput.growth_edges || [],
      last_analyzed: new Date().toISOString(),
      session_count: dnaOutput.session_count || notes.length,
    };

    if (existing && existing.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles?id=eq.${existing[0].id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(dnaPayload),
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(dnaPayload),
      });
    }

    return res.status(200).json(dnaOutput);
  } catch (e) {
    console.error('[generate-coach-dna] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
