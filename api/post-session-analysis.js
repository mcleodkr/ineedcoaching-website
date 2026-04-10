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
        max_tokens: 2000,
        system: `You are a coaching intelligence analyst. Analyze session notes and extract patterns, signals, and frameworks. Use strength-based, tentative language: "appears to suggest," "may indicate," "seems to reflect." Never "you should" or "you must." No em dashes. Return ONLY valid JSON:
{
  "session_summary": "2-3 sentence summary",
  "client_commitments": [{ "title": string, "due_date_suggested": "YYYY-MM-DD or null" }],
  "breakthrough_moment": "The moment of greatest shift or insight, or null if none clear",
  "coaching_signals": [{ "signal_type": "Forward Momentum|Resistance|Values Clarity|Goal Ambivalence|Identity Shift|Strength Recognition|Accountability Gap", "evidence": string, "interpretation": string }],
  "frameworks_detected": [{ "name": "GROW Model|Co-Active Coaching|Solution-Focused|Strengths-Based|Cognitive Behavioral Coaching|Positive Psychology|Motivational Interviewing|Ontological Coaching|Accountability-Based|Narrative Coaching", "presence_level": "Primary|Secondary|Incidental", "description": string, "evidence": string }],
  "between_session_assignment": ["suggestion 1", "suggestion 2"],
  "pre_session_seed": "A single sentence to anchor the next session opening"
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
