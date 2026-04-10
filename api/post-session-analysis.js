// POST { coachId, clientEmail, bookingId, sessionNotes, format }
// Runs post-session analysis, detects frameworks and coaching signals

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
    const { coachId, clientEmail, bookingId, sessionNotes, format } = body;
    if (!coachId || !sessionNotes) return res.status(400).json({ error: 'Missing required fields' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: `You are a coaching intelligence analyst. Analyze session notes and extract actionable patterns, signals, and frameworks. Use strength-based, tentative language: "appears to suggest," "may indicate," "seems to reflect." Never "you should" or "you must." No em dashes. Return ONLY valid JSON:
{
  "breakthrough_moment": { "text": "The moment of greatest shift or insight, or null", "type_tag": "Energy Insight|Pattern Interruption|Identity Shift|Belief Reframe|Commitment Formation|Behavioral Evidence" } | null,
  "active_pattern": { "name": "a named client pattern in quotes, e.g. The Auditor", "trigger": "what activates it, 1 sentence", "behavior": "what it produces, 1 sentence", "next_session_use": "specific coach question or intervention to use with this pattern next session" } | null,
  "next_session_strategy": { "primary_move": "single most important coaching action for next session", "watch_for": "what to notice", "test_this": "a specific question or exercise to try", "decision_point": { "if_reflective": "what to do if client reflects", "if_analytical": "what to do if client stays analytical" } },
  "coaching_signals": [{ "signal_type": "Forward Momentum|Resistance|Values Clarity|Goal Ambivalence|Identity Shift|Strength Recognition|Accountability Gap", "observation": "what was seen, specific and behavioral", "coach_move": "specific action the coach can take when this signal appears, tied to this client" }],
  "client_commitments": [{ "title": string, "due_date_suggested": "YYYY-MM-DD or null", "commitment_strength": "High|Medium|Low", "risk": "what could undermine it, 1 sentence", "accountability_question": "precise, slightly uncomfortable question to ask next session" }],
  "frameworks_detected": [{ "name": "GROW Model|Co-Active Coaching|Solution-Focused|Strengths-Based|Cognitive Behavioral Coaching|Positive Psychology|Motivational Interviewing|Ontological Coaching|Accountability-Based|Narrative Coaching", "presence_level": "Primary|Secondary|Incidental", "description": string, "evidence": string, "leverage_note": "how to use this framework more intentionally next session based on what worked, 1 sentence" }],
  "session_summary": "2-3 sentence summary",
  "pre_session_seed": "A sharp, slightly disruptive opening question for next session. Movement-oriented, tied to the breakthrough moment. Not 'how has your week been' but specific and uncomfortable."
}`,
        messages: [{ role: 'user', content: `Analyze this ${format || 'coaching'} session:\n\n${sessionNotes}` }]
      })
    });

    if (!claudeRes.ok) return res.status(502).json({ error: 'AI analysis failed' });

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '';
    let analysis;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      analysis = match ? JSON.parse(match[0]) : JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse analysis' });
    }

    // Save analysis to session notes if bookingId provided
    if (bookingId) {
      await fetch(`${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}`, {
        method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          coaching_signals: analysis.coaching_signals || null,
          frameworks_detected: analysis.frameworks_detected || null,
          pre_session_seed: analysis.pre_session_seed || null,
          post_session_analysis: analysis
        })
      });
    }

    // Auto-create action items from commitments
    if (analysis.client_commitments && analysis.client_commitments.length && clientEmail) {
      const items = analysis.client_commitments.map(c => ({
        coach_id: coachId, client_email: clientEmail, booking_id: bookingId || null,
        title: c.title, due_date: c.due_date_suggested || null, source: 'ai'
      }));
      await fetch(`${SUPABASE_URL}/rest/v1/coach_action_items`, {
        method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify(items)
      });
    }

    return res.status(200).json(analysis);
  } catch (e) {
    console.error('[post-session-analysis] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
