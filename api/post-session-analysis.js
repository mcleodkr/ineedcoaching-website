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
    const { coachId, clientEmail, bookingId, format, useTranscript, existingGoals } = body;
    let { sessionNotes } = body;

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    // If useTranscript flag, fetch raw_transcript from DB
    if (useTranscript && bookingId) {
      const tRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}&select=raw_transcript,notes`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const tData = await tRes.json();
      if (tData && tData.length && tData[0].raw_transcript) {
        sessionNotes = tData[0].raw_transcript;
        if (tData[0].notes) sessionNotes += '\n\nSTRUCTURED NOTES:\n' + tData[0].notes;
      }
    }

    if (!coachId || !sessionNotes) return res.status(400).json({ error: 'Missing required fields' });

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 6000,
        system: `You are a coaching intelligence analyst writing directly to a professional coach. Address the coach as "you" throughout — never say "the coach." Your tone is that of a thoughtful senior colleague offering perspective — not a system giving commands. Every field writable on a sticky note. No sentence over 20 words. No academic phrasing. Never use "suggesting," "indicating," "potentially," "it appears that." Use suggestive language: "you may want to consider," "one approach worth exploring," "this may point to." Never use "you should" or "you must." No em dashes.

Generate the response in two internal passes, but return ONE valid JSON object combining both.

PASS 1 — PRIMARY ANALYSIS (always generate these):
{
  "pre_session_seed": "Your north star for next session. Sharp, tied to active pattern and breakthrough. Under 15 words.",
  "opening_move": "A single exploratory question you could use to open the next session. Not leading. Under 25 words.",
  "opening_move_rationale": "One sentence on why this opening question may be useful. Under 20 words.",
  "breakthrough_moment": { "text": "direct client quote of greatest shift", "type_tag": "Energy Insight|Pattern Interruption|Identity Shift|Belief Reframe|Commitment Formation|Behavioral Evidence", "identity_shift": "under 15 words", "reinforce_suggestion": "one sentence, invitation not command" } | null,
  "active_pattern": { "name": "e.g. The Auditor", "trigger": "under 15 words", "behavior": "under 15 words", "next_session_use": "under 15 words", "strategic_suggestion": { "suggestion": "one sentence addressed to you", "why_this_may_matter": "2-3 sentences", "what_it_may_reveal": "2 sentences", "use_with_care": "1 sentence" } } | null,
  "next_session_why": "Under 20 words.",
  "pattern_timeline": { "past": "under 15 words", "present": "under 15 words", "future_risk": "under 15 words" } | null,
  "pattern_continuity": "string or null. Under 20 words.",
  "early_signals": ["exactly 2 observable behavioral listening cues for next session's first 5 minutes"],
  "early_signals_why": "Under 20 words.",
  "next_session_strategy": { "primary_move": "under 15 words", "watch_for": "under 15 words", "test_this": "under 15 words", "decision_point": { "if_reflective": "under 15 words", "if_analytical": "under 15 words", "why_this_matters": "under 20 words" } },
  "likely_breakpoint": ["2-3 short behavioral strings"],
  "if_stuck": { "scenario": "under 15 words", "pivot": "under 20 words", "in_session_move": "under 20 words" },
  "coaching_signals": [{ "signal_type": "Forward Momentum|Resistance|Values Clarity|Goal Ambivalence|Identity Shift|Strength Recognition|Accountability Gap", "observation": "short, behavioral", "coach_move": "full sentence suggestion addressed to you" }],
  "client_commitments": [{ "title": string, "due_date_suggested": "YYYY-MM-DD or null", "commitment_strength": "High|Medium|Low", "risk": "under 15 words", "accountability_question": "precise, uncomfortable" }],
  "frameworks_detected": [{ "name": string, "presence_level": "Primary|Secondary|Incidental", "description": "1-2 sentences reflective observation", "leverage_note": "1 sentence reflective", "use_next_time": "one sentence starting 'You might consider...'", "use_next_time_why": "one sentence", "be_careful_of": "one reflective sentence", "be_careful_of_why": "one sentence" }],
  "coach_dna_update": { "patterns_observed": ["max 2 bullets, under 12 words each"], "suggestion": "under 15 words" },
  "session_in_one_line": "[Client] shifted from [X] to [Y] by [mechanism]. One sentence."
}

PASS 2 — EXTENDED ANALYSIS (generate after primary fields are complete, include in same JSON):
{
  "goal_review": [{ "goal_title": "exact title of existing goal", "session_relevance": "one sentence", "status_signal": "progressed|stalled|needs_revision|completed", "signal_reason": "one sentence" }],
  "between_session_practices": [{ "title": "short name", "invitation": "one sentence starting 'You might invite/suggest...' — never 'assign'", "why_this_may_matter": "one sentence linking to identity shift or pattern", "connection": "which pattern/breakthrough this addresses" }],
  "coaching_reflection": "CONDITIONAL. Internally score (do NOT output scores): coaching_behavior_clarity 0-2, session_depth 0-2, interpretability 0-2. Return null if total < 4 OR any: <10 meaningful exchanges, logistical session, coach presence minimal, crisis/self-harm/acute distress, no observable coaching behaviors. Session types: growth (all 3 fields), processing (what_stood_out only), crisis_adjacent (null). When generated: { session_type, what_stood_out: { observation, why_this_may_matter }, what_seemed_effective: { observation, why_this_may_matter } | null, one_thing_to_consider: { suggestion: 'You might consider...', why_this_may_matter, use_with_care } | null } | null"
}

Return ONLY the single combined JSON object with all fields from both passes.`,
        messages: [{ role: 'user', content: `Analyze this ${format || 'coaching'} session:\n\n${sessionNotes}${existingGoals && existingGoals.length ? '\n\nExisting client goals:\n' + existingGoals.map((g, i) => (i + 1) + '. ' + g).join('\n') : ''}` }]
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
