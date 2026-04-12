// POST { coachId }
// Generates Coach DNA from accumulated Coaching Mirror outputs
// Pass 1: Aggregate mirror data across sessions
// Pass 2: Derive patterns with frequency + trajectory
// Pass 3: Format output

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

    // Fetch sessions with Mirror outputs
    const notesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&post_session_analysis=not.is.null&select=post_session_analysis,client_email,created_at&order=created_at.desc&limit=20`,
      { headers }
    );
    const notes = await notesRes.json();

    if (!notes || notes.length < 5) {
      return res.status(200).json({ locked: true, session_count: notes ? notes.length : 0, needed: 5 });
    }

    // Aggregate Mirror data across sessions
    const mirrorData = notes.map((n, idx) => {
      const m = n.post_session_analysis || {};
      return {
        session_index: idx + 1,
        client_email: n.client_email,
        created_at: n.created_at,
        // Techniques used
        techniques: (m.coaching_interventions || []).map(i => i.technique_name).filter(Boolean),
        // What stood out
        what_stood_out: (m.what_stood_out || []).map(w => w.title).filter(Boolean),
        // Missed windows signal types
        missed_window_signals: (m.missed_windows || []).map(w => w.signal_type).filter(Boolean),
        missed_window_moments: (m.missed_windows || []).map(w => w.moment).filter(Boolean),
        // What session revealed about coach
        coach_patterns: (m.what_this_session_revealed || []).map(p => p.coach_pattern).filter(Boolean),
        coach_tendencies: (m.what_this_session_revealed || []).map(p => p.what_you_tend_to_do).filter(Boolean),
        // Frameworks
        frameworks: (m.frameworks || []).map(f => f.name).filter(Boolean),
        // Reflection
        what_effective: m.reflection_and_growth?.what_seemed_effective || null,
        stay_curious: m.reflection_and_growth?.one_place_to_stay_curious || null,
      };
    });

    // Get coach profile
    const coachRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=specialties,headline,bio,feedback_style`, { headers });
    const coaches = await coachRes.json();
    const coach = coaches?.[0] || {};

    const SYSTEM = `You are Coach Clarity, a coaching intelligence system that builds pattern-level identity profiles for coaches.

CRITICAL RULES:
- Every insight must be traceable to at least 2 sessions
- Use frequency counts and trajectory to ground every claim
- Never use clinical language (CBT, DBT, ACT, diagnosis, treatment, pathology)
- Use coaching-safe language only: values clarification, pattern awareness, emotional regulation strategy, behavioral reframing, strategic questioning
- Trajectory: Increasing (more frequent in recent sessions), Stable (consistent), Decreasing (less recent), Emerging (appeared in last 2 sessions only), Underutilized (appeared 1-2 times total)
- Add this note at top of techniques section: "This reflects what you actually did — not what you intended to do."
- DNA must derive ONLY from Mirror outputs, not from stated intentions
- Never say "you should" — always "you tend to", "you consistently", "across sessions you"
- Return ONLY valid JSON`;

    const dnaOutput = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      3000,
      SYSTEM,
      `Analyze ${notes.length} sessions across ${new Set(notes.map(n => n.client_email).filter(Boolean)).size} clients and generate a Coach DNA profile.

Coach specialties: ${JSON.stringify(coach.specialties || [])}
Coach headline: ${coach.headline || 'Not set'}

MIRROR DATA (aggregated from ${notes.length} sessions):
${JSON.stringify(mirrorData, null, 2)}

Generate a complete Coach DNA profile. Every pattern must appear in 2+ sessions to be included.

Return ONLY this JSON:
{
  "session_count": number,
  "client_count": number,
  "framework_distribution": [
    {
      "name": string,
      "percentage": number,
      "description": string,
      "seen_when": string,
      "frequency": "X of last Y sessions",
      "trajectory": "Increasing|Stable|Decreasing|Emerging|Underutilized"
    }
  ],
  "techniques_and_strategies": {
    "note": "This reflects what you actually did — not what you intended to do.",
    "techniques": [
      {
        "name": string,
        "definition": string,
        "frequency": "X of last Y sessions",
        "trajectory": "Increasing|Stable|Decreasing|Emerging|Underutilized",
        "observed_when": string
      }
    ]
  },
  "what_is_working": [
    {
      "capability": string,
      "example": string,
      "why_it_works": string,
      "frequency": "X of last Y sessions",
      "trajectory": string
    }
  ],
  "growth_edges": [
    {
      "pattern": string,
      "what_you_tend_to_do": string,
      "what_is_missing": string,
      "example_from_sessions": string,
      "what_to_try": string,
      "frequency": "X of last Y sessions",
      "trajectory": string
    }
  ],
  "recurring_blind_spots": [
    {
      "pattern_name": string,
      "description": string,
      "where_it_shows_up": string,
      "why_it_matters": string,
      "frequency": "X of last Y sessions",
      "trajectory": string,
      "derived_from": "missed_windows"
    }
  ],
  "where_to_stay_curious": [
    {
      "tension": string,
      "not_a_correction": true
    }
  ]
}`,
      'Pattern Analysis'
    );

    // Upsert to coach_dna_profiles
    const existRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&select=id`, { headers });
    const existing = await existRes.json();

    const dnaPayload = {
      coach_id: coachId,
      framework_distribution: dnaOutput.framework_distribution,
      signal_patterns: {
        what_works: dnaOutput.what_is_working,
        techniques: dnaOutput.techniques_and_strategies,
        growth_edges: dnaOutput.growth_edges,
        recurring_blind_spots: dnaOutput.recurring_blind_spots,
        where_to_stay_curious: dnaOutput.where_to_stay_curious,
      },
      growth_edges: dnaOutput.growth_edges,
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
