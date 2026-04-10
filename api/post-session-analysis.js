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
        max_tokens: 3500,
        system: `You are a coaching intelligence analyst. Every field writable on a sticky note. No sentence over 20 words. No academic phrasing. Never use "suggesting," "indicating," "potentially," "it appears that." Direct behavioral language only. No em dashes. Return ONLY valid JSON:
{
  "pre_session_seed": "The single most decisive line in the entire output. The coach's north star for next session. Sharp, action-oriented, tied to active pattern and breakthrough. Under 15 words.",
  "breakthrough_moment": { "text": "The moment of greatest shift", "type_tag": "Energy Insight|Pattern Interruption|Identity Shift|Belief Reframe|Commitment Formation|Behavioral Evidence", "identity_shift": "what changed at identity level, under 15 words", "repeat_behavior": "specific behavior to reinforce, under 15 words" } | null,
  "active_pattern": { "name": "named pattern in quotes e.g. The Auditor", "trigger": "what activates it, under 15 words", "behavior": "what it produces, under 15 words", "next_session_use": "specific intervention, under 15 words", "counter_move": { "when": "observable signal the pattern is active, under 15 words", "move": "specific coaching action in that moment, under 15 words" } } | null,
  "pattern_timeline": { "past": "where rooted, under 15 words", "present": "current trigger, under 15 words", "future_risk": "future high-stakes risk, under 15 words" } | null,
  "pattern_continuity": "string or null. Connects to prior session pattern. Under 20 words.",
  "early_signals": ["exactly 2 strings. What to listen for in first 5 minutes of NEXT session. Observable, behavioral. Listening cues, not questions."],
  "next_session_strategy": { "primary_move": "single most important action, under 15 words", "watch_for": "what to notice, under 15 words", "test_this": "specific question or exercise, under 15 words", "decision_point": { "if_reflective": "under 15 words", "if_analytical": "under 15 words" } },
  "likely_breakpoint": ["2-3 strings. Most likely regression. Short, behavioral."],
  "if_stuck": { "scenario": "under 15 words", "pivot": "under 20 words", "in_session_move": "specific live exercise, under 20 words" },
  "coaching_signals": [{ "signal_type": "Forward Momentum|Resistance|Values Clarity|Goal Ambivalence|Identity Shift|Strength Recognition|Accountability Gap", "observation": "short, behavioral", "coach_move": "specific, tied to client" }],
  "client_commitments": [{ "title": string, "due_date_suggested": "YYYY-MM-DD or null", "commitment_strength": "High|Medium|Low", "risk": "under 15 words", "accountability_question": "precise, uncomfortable" }],
  "frameworks_detected": [{ "name": string, "presence_level": "Primary|Secondary|Incidental", "description": string, "evidence": string, "leverage_note": "under 15 words", "use_next_time": "under 15 words", "be_careful_of": "under 15 words" }],
  "coach_dna_update": { "patterns_observed": ["max 2 bullets, under 12 words each"], "suggestion": "under 15 words" },
  "session_in_one_line": "[Client] shifted from [X] to [Y] by [mechanism]. One sentence only."
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
