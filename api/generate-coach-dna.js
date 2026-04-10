// POST { coachId }
// Generates Coach DNA profile from accumulated session analysis

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

    // Fetch all session notes with frameworks
    const notesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&frameworks_detected=not.is.null&select=frameworks_detected,coaching_signals,client_email,format,created_at&order=created_at.desc`,
      { headers }
    );
    const notes = await notesRes.json();

    if (!notes || notes.length < 5) {
      return res.status(200).json({ locked: true, session_count: notes ? notes.length : 0, needed: 5 });
    }

    // Get coach declared orientation
    const coachRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${coachId}&select=specialties,headline,bio`, { headers });
    const coaches = await coachRes.json();
    const coach = coaches?.[0] || {};

    const uniqueClients = new Set(notes.map(n => n.client_email).filter(Boolean)).size;
    const allFrameworks = notes.flatMap(n => n.frameworks_detected || []);
    const allSignals = notes.flatMap(n => n.coaching_signals || []);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: `You are a coaching pattern analyst creating a reflective Coach DNA profile. This is a mirror, not an assessment. Use affirming, tentative language: "appears to," "seems to reflect," "may suggest." Never prescriptive. Never "you should" or "you are a [X] coach." No em dashes. Return ONLY valid JSON:
{
  "session_count": number,
  "client_count": number,
  "framework_distribution": [{ "name": string, "percentage": number, "description": string, "evidence_excerpts": [string] }],
  "declared_vs_evidenced": { "declared": string, "evidenced_summary": string, "affirming_note": string } | null,
  "what_appears_to_be_working": [{ "observation": string, "evidence": string }],
  "growth_edges": [{ "framework": string, "reason": string, "icf_competency": string }]
}
Sort framework_distribution by percentage descending. Limit to top 6 frameworks. growth_edges should be 2-3 frameworks the coach uses less but may find valuable. ICF competencies from: Active Listening, Powerful Questioning, Direct Communication, Creating Awareness, Designing Actions, Planning and Goal Setting, Managing Progress and Accountability, Establishing Trust and Intimacy.`,
        messages: [{ role: 'user', content: `Analyze ${notes.length} sessions across ${uniqueClients} clients.\n\nCoach specialties: ${JSON.stringify(coach.specialties || [])}\nCoach headline: ${coach.headline || 'Not set'}\n\nAll detected frameworks across sessions:\n${JSON.stringify(allFrameworks)}\n\nAll coaching signals:\n${JSON.stringify(allSignals)}` }]
      })
    });

    if (!claudeRes.ok) return res.status(502).json({ error: 'AI analysis failed' });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '';
    let dna;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      dna = match ? JSON.parse(match[0]) : JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse DNA profile' });
    }

    // Upsert to coach_dna_profiles
    const existRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&select=id`, { headers });
    const existing = await existRes.json();

    const dnaPayload = {
      coach_id: coachId,
      framework_distribution: dna.framework_distribution,
      signal_patterns: { what_works: dna.what_appears_to_be_working },
      growth_edges: dna.growth_edges,
      last_analyzed: new Date().toISOString(),
      session_count: dna.session_count || notes.length
    };

    if (existing && existing.length) {
      await fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles?id=eq.${existing[0].id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(dnaPayload)
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(dnaPayload)
      });
    }

    return res.status(200).json(dna);
  } catch (e) {
    console.error('[generate-coach-dna] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
