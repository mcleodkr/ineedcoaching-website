// POST { coachId }
// Identity-level Coach DNA derived from accumulated Coaching Mirror outputs.
// Produces 10 sections: decision model, intervention sequence, pattern activation map,
// technique profile, bias profile, client response signature, growth edges,
// blind spots, missed leverage moments, evolution signal.

async function callClaude(apiKey, model, maxTokens, system, userMessage, passName) {
  console.log(`[DNA ${passName}] model: ${model}`);
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
    throw new Error(`DNA ${passName} API error ${res.status}: ${err.substring(0, 200)}`);
  }
  const data = await res.json();
  let raw = data.content?.[0]?.text || '';
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const match = raw.match(/\{[\s\S]*\}/);
  try { return match ? JSON.parse(match[0]) : JSON.parse(raw); }
  catch (e) { throw new Error(`DNA ${passName} JSON parse error: ${e.message}`); }
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
    const mirrorData = notes.map((n, idx) => {
      const m = n.post_session_analysis || {};
      const interventions = Array.isArray(m.coaching_interventions) ? m.coaching_interventions : [];
      const missed = Array.isArray(m.missed_windows) ? m.missed_windows : [];
      const stood = Array.isArray(m.what_stood_out) ? m.what_stood_out : [];
      const revealed = Array.isArray(m.what_this_session_revealed) ? m.what_this_session_revealed : [];
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
        coach_patterns: revealed.map((p) => p.coach_pattern).filter(Boolean),
        coach_tendencies: revealed.map((p) => p.what_you_tend_to_do).filter(Boolean),
        what_effective: m.reflection_and_growth?.what_seemed_effective || null,
        stay_curious: m.reflection_and_growth?.one_place_to_stay_curious || null,
      };
    });

    // Get coach profile
    const coachRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=specialties,headline,bio,feedback_style`, { headers });
    const coaches = await coachRes.json();
    const coach = coaches?.[0] || {};

    const SYSTEM = `You are Coach Clarity, an identity-level intelligence system that builds pattern-level Coach DNA profiles.

IDENTITY-LEVEL THINKING:
- Surface the COACH as a decision-maker, not a style label. DNA is how this coach thinks under pressure.
- Every insight must be traceable to at least 2 sessions. Use frequency counts and trajectory to ground every claim.
- Distinguish what the coach actually DID from what they intended to do. Use only Mirror outputs, never stated intentions.
- Trajectory values: "Increasing" (more frequent recently), "Stable" (consistent across sessions), "Decreasing" (less recent), "Emerging" (appeared in last 2 sessions only), "Underutilized" (appeared 1-2 times total).
- Frequency format: "X of last Y sessions".

LANGUAGE RULES:
- Never clinical (no CBT, DBT, ACT, diagnosis, pathology).
- Use coaching-safe language only: pattern awareness, emotional regulation strategy, strategic questioning, behavioral reframing, values clarification.
- Never "you should". Use "you tend to", "across sessions you", "you consistently".
- No em dashes in JSON string values.

Return ONLY raw JSON. Start with { end with }. No markdown. No preamble.`;

    const USER = `Analyze ${notes.length} sessions across ${new Set(notes.map((n) => n.client_email).filter(Boolean)).size} clients and generate a full Coach DNA profile.

Coach specialties: ${JSON.stringify(coach.specialties || [])}
Coach headline: ${coach.headline || 'Not set'}

MIRROR DATA (aggregated from ${notes.length} sessions, most recent first):
${JSON.stringify(mirrorData)}

Derive these 10 sections. Every pattern must appear in 2+ sessions. For evolution_signal compare earliest third of sessions to most recent third.

Return ONLY this JSON:
{
  "session_count": number,
  "client_count": number,
  "coaching_decision_model": [
    {
      "trigger": "when [observable client state or moment]",
      "default_response": "you tend to [specific coach move]",
      "rationale": "why this pairing appears recurrent",
      "frequency": "X of last Y sessions",
      "trajectory": "Increasing|Stable|Decreasing|Emerging|Underutilized"
    }
  ],
  "default_intervention_sequence": {
    "description": "one sentence summary of your typical flow",
    "typical_sequence": ["step 1 move", "step 2 move", "step 3 move"],
    "variations": [
      { "when": "condition", "sequence": ["alt step 1", "alt step 2"] }
    ]
  },
  "pattern_activation_map": [
    {
      "pattern_name": "short name",
      "trigger": "what activates this pattern in clients you work with",
      "typical_response": "how you tend to meet it",
      "frequency": "X of last Y sessions",
      "trajectory": "..."
    }
  ],
  "technique_profile": [
    {
      "technique": "technique name",
      "definition": "one sentence plain language",
      "frequency": "X of last Y sessions",
      "trajectory": "...",
      "observed_when": "the situation where it tends to show up"
    }
  ],
  "bias_profile": [
    {
      "bias": "e.g. speed over depth, cognition over emotion, action over staying",
      "description": "what this bias does in your coaching",
      "evidence": "observable pattern from sessions",
      "trajectory": "..."
    }
  ],
  "client_response_signature": [
    {
      "response_type": "how clients tend to move when you coach",
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
      "signal": "emotional or behavioral cue present",
      "why_high_leverage": "what was possible that did not happen",
      "frequency": "X of last Y sessions"
    }
  ],
  "evolution_signal": {
    "first_third_summary": "what you did in the earliest sessions",
    "last_third_summary": "what you tend to do now",
    "trajectory_summary": "one sentence naming the shift",
    "emerging_strengths": ["string"],
    "fading_habits": ["string"]
  }
}`;

    const dnaOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      4000,
      SYSTEM,
      USER,
      'Identity Analysis'
    );

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
