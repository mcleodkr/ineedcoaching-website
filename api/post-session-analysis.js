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
        max_tokens: 4000,
        system: `You are a coaching intelligence analyst writing directly to a professional coach. Address the coach as "you" throughout — never say "the coach." Your tone is that of a thoughtful senior colleague offering perspective — not a system giving commands. Every field writable on a sticky note. No sentence over 20 words. No academic phrasing. Never use "suggesting," "indicating," "potentially," "it appears that." Use suggestive language: "you may want to consider," "one approach worth exploring," "this may point to." Never use "you should" or "you must." No em dashes. Return ONLY valid JSON:
{
  "pre_session_seed": "The single most decisive line in the entire output. Your north star for next session. Sharp, tied to active pattern and breakthrough. Under 15 words.",
  "opening_move": "A single exploratory question you could use to open the next session. Not leading. Invites the client to surface what matters. Example: 'What did you not say in that memo that you already knew?' Under 25 words.",
  "opening_move_rationale": "One sentence on why this opening question may be a useful place to begin. Under 20 words.",
  "breakthrough_moment": { "text": "The moment of greatest shift — a direct client quote", "type_tag": "Energy Insight|Pattern Interruption|Identity Shift|Belief Reframe|Commitment Formation|Behavioral Evidence", "identity_shift": "what changed at identity level, under 15 words", "reinforce_suggestion": "one sentence suggesting how you might reinforce this shift, phrased as an invitation not a command" } | null,
  "active_pattern": { "name": "named pattern in quotes e.g. The Auditor", "trigger": "what activates it, under 15 words", "behavior": "what it produces, under 15 words", "next_session_use": "one direction you may want to consider, under 15 words", "strategic_suggestion": { "suggestion": "one sentence addressed to you (the coach), suggestive tone — what you may want to try when this pattern surfaces", "why_this_may_matter": "2-3 sentences on the psychological logic behind this suggestion", "what_it_may_reveal": "2 sentences on what the client's response to this approach will tell you", "use_with_care": "1 sentence caution about when this approach could backfire" } } | null,
  "next_session_why": "One sentence explaining why paying attention to the suggested next session focus may matter. Under 20 words.",
  "pattern_timeline": { "past": "where rooted, under 15 words", "present": "current trigger, under 15 words", "future_risk": "future high-stakes risk, under 15 words" } | null,
  "pattern_continuity": "string or null. Connects to prior session pattern. Under 20 words.",
  "early_signals": ["exactly 2 strings. What to listen for in first 5 minutes of NEXT session. Observable, behavioral. Listening cues, not questions."],
  "early_signals_why": "One sentence explaining why these early cues are worth noticing. Under 20 words.",
  "next_session_strategy": { "primary_move": "one direction worth exploring as the primary approach, under 15 words", "watch_for": "what to notice, under 15 words", "test_this": "specific question or exercise worth exploring, under 15 words", "decision_point": { "if_reflective": "under 15 words", "if_analytical": "under 15 words", "why_this_matters": "one sentence on why this matters, under 20 words" } },
  "likely_breakpoint": ["2-3 strings. Most likely regression. Short, behavioral."],
  "if_stuck": { "scenario": "under 15 words", "pivot": "under 20 words", "in_session_move": "specific live exercise worth trying, under 20 words" },
  "coaching_signals": [{ "signal_type": "Forward Momentum|Resistance|Values Clarity|Goal Ambivalence|Identity Shift|Strength Recognition|Accountability Gap", "observation": "short, behavioral", "coach_move": "a specific approach you may want to explore, written as a full sentence suggestion addressed to you" }],
  "client_commitments": [{ "title": string, "due_date_suggested": "YYYY-MM-DD or null", "commitment_strength": "High|Medium|Low", "risk": "under 15 words", "accountability_question": "precise, uncomfortable" }],
  "frameworks_detected": [{ "name": string, "presence_level": "Primary|Secondary|Incidental", "description": "what you noticed about how this framework appeared in the session, 1-2 sentences as a reflective observation", "leverage_note": "what this may suggest about the client or your approach, 1 sentence reflective observation", "use_next_time": "one reflective sentence starting with 'You might consider...' on how to build on this framework", "use_next_time_why": "one sentence on why building on this may matter", "be_careful_of": "one reflective sentence on something to be mindful of with this framework", "be_careful_of_why": "one sentence on why this caution is worth considering" }],
  "goal_review": [{ "goal_title": "exact title of the existing goal", "session_relevance": "one sentence on how this goal connected to what was discussed", "status_signal": "progressed|stalled|needs_revision|completed", "signal_reason": "one sentence explaining why you see this status" }],
  "between_session_practices": [{ "title": "short name for the practice", "invitation": "one sentence starting with 'You might invite...' or 'You might suggest...' — never 'assign' or 'give'", "why_this_may_matter": "one sentence connecting this practice to the session's identity shift or pattern", "connection": "which breakthrough or pattern this practice addresses, e.g. 'The Relief Seeker' or 'Breakthrough Moment'" }],
  "coach_dna_update": { "patterns_observed": ["max 2 bullets, under 12 words each"], "suggestion": "under 15 words" },
  "session_in_one_line": "[Client] shifted from [X] to [Y] by [mechanism]. One sentence only.",
  "coaching_reflection": "CONDITIONAL — follow this logic precisely before generating. First, internally score (do NOT include scores in output): coaching_behavior_clarity 0-2 (can you identify at least one clear observable coaching behavior?), session_depth 0-2 (was this substantive with meaningful exchanges?), interpretability 0-2 (can you interpret the impact of coaching behavior on the client?). Return null if total < 4. Also return null if ANY suppression condition is true: fewer than 10 meaningful exchanges, primarily logistical/scheduling, coach presence minimal (client talking 90%+), crisis language/self-harm ideation/relapse events/acute distress present, no observable coaching behaviors identifiable. Determine session_type: growth (standard coaching toward goals), processing (emotional unpacking, grieving, identity work), crisis_adjacent (safety concerns, acute distress). If crisis_adjacent: return null. If processing: include what_stood_out only. If growth: include all three fields. Never use 'should', 'must', 'needs to', 'have to'. Frame suggestions as 'you might consider' or 'it may be worth exploring'. Never introduce concepts not in the session. Never generalize. Max 2-3 sentences per subsection. If evidence is weak, return null. When generated: { session_type: 'growth'|'processing'|'crisis_adjacent', what_stood_out: { observation: 'one sentence describing an observable coaching behavior grounded in the transcript', why_this_may_matter: 'one sentence' }, what_seemed_effective: { observation: 'one sentence on what appeared to support movement or insight', why_this_may_matter: 'one sentence' } | null (only if growth), one_thing_to_consider: { suggestion: 'one sentence starting with You might consider...', why_this_may_matter: 'one sentence connecting to a real moment', use_with_care: 'one sentence on when not to apply this' } | null (only if growth) } | null"
}`,
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
