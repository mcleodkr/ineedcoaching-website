// POST { coachId, clientEmail, bookingId }
// Generates a premium pre-session brief from client history

import { logAIUsage } from '../lib/ai-usage.js';

// Server-injected disclaimer surfaced at the top of every brief. Kept out of
// the model prompt because (a) the wording is fixed product copy, not model
// judgement, (b) it would burn cache-budget tokens to regenerate verbatim
// each call, and (c) it is the single source of truth — change here, ships
// to every brief immediately.
const ABOUT_THIS_BRIEF = {
  purpose: 'Coach Clarity is designed to support your decision-making, not direct it.',
  accuracy: 'Coach Clarity learns as more sessions are uploaded. It may suggest approaches that do not fit your actual coaching style, misidentify nuance, or overgeneralize from limited data.',
  your_role: 'You are the driver. Coach Clarity is a passenger offering suggestions. If something in this brief does not sound like you, does not fit the moment, or feels off, ignore it. Your instinct and judgment are the final call.',
  improves_with_scale: 'As more sessions are uploaded, Coach Clarity will get better at identifying patterns for both this client and your coaching DNA.',
};

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

  const invokeId = Math.random().toString(36).slice(2, 10);
  const invokeStart = Date.now();
  console.log('[pre-session-brief] invoked', { invokeId });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coachId, clientEmail, bookingId } = body;
    if (!coachId || !clientEmail) return res.status(400).json({ error: 'Missing coachId or clientEmail' });
    console.log('[pre-session-brief] inputs', { invokeId, bookingId, coachId, clientEmail });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // Stage 1: resolve the current session's scheduled_at so we can filter
    // historical data to "prior sessions only". Without this, the brief would
    // describe the session it is supposed to predict — a coach prepping for
    // session N would see patterns extracted from session N itself.
    let currentScheduledAt = null;
    if (bookingId) {
      const currentBookingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}&select=scheduled_at&limit=1`,
        { headers }
      );
      const currentBookingData = currentBookingRes.ok ? await currentBookingRes.json() : [];
      if (!Array.isArray(currentBookingData) || !currentBookingData.length) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      currentScheduledAt = currentBookingData[0].scheduled_at;
    }
    console.log('[pre-session-brief] stage 1 done', { invokeId, currentScheduledAt, ms: Date.now() - invokeStart });

    // Stage 2: fetch supporting data in parallel. When we have a current
    // scheduled_at, scope notes + bookings to strictly-before; otherwise fall
    // back to recent-N (older callers without a bookingId).
    const notesUrl = currentScheduledAt
      ? `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&coach_bookings.scheduled_at=lt.${encodeURIComponent(currentScheduledAt)}&order=created_at.desc&limit=10&select=notes,format,structured_notes,post_session_analysis,created_at,coach_bookings!inner(scheduled_at)`
      : `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=created_at.desc&limit=3&select=notes,format,structured_notes,post_session_analysis,created_at`;

    const bookingsUrl = currentScheduledAt
      ? `${SUPABASE_URL}/rest/v1/coach_bookings?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&status=eq.confirmed&scheduled_at=lt.${encodeURIComponent(currentScheduledAt)}&order=scheduled_at.desc&limit=10&select=id,scheduled_at,notes`
      : `${SUPABASE_URL}/rest/v1/coach_bookings?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&status=eq.confirmed&order=scheduled_at.desc&limit=5&select=id,scheduled_at,notes`;

    const goalsUrl = currentScheduledAt
      ? `${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&created_at=lt.${encodeURIComponent(currentScheduledAt)}&order=created_at.desc&select=title,status,target_date`
      : `${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=created_at.desc&select=title,status,target_date`;

    console.log('[pre-session-brief] stage 2 fetching', { invokeId, ms: Date.now() - invokeStart });
    const [notesRes, goalsRes, bookingsRes, checkinRes, intakeRes] = await Promise.all([
      fetch(notesUrl, { headers }),
      fetch(goalsUrl, { headers }),
      fetch(bookingsUrl, { headers }),
      bookingId ? fetch(`${SUPABASE_URL}/rest/v1/coach_checkin_responses?booking_id=eq.${bookingId}&submitted_at=not.is.null&select=responses&limit=1`, { headers }) : Promise.resolve({ json: () => [] }),
      fetch(`${SUPABASE_URL}/rest/v1/coach_intake_responses?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=created_at.desc&limit=1&select=responses`, { headers })
    ]);

    const [notes, goals, bookings, checkins, intakeData] = await Promise.all([notesRes.json(), goalsRes.json(), bookingsRes.json(), checkinRes.json ? checkinRes.json() : [], intakeRes.json()]);
    console.log('[pre-session-brief] stage 3 fetched', {
      invokeId,
      notesCount: Array.isArray(notes) ? notes.length : null,
      goalsCount: Array.isArray(goals) ? goals.length : null,
      bookingsCount: Array.isArray(bookings) ? bookings.length : null,
      checkinsCount: Array.isArray(checkins) ? checkins.length : null,
      intakeCount: Array.isArray(intakeData) ? intakeData.length : null,
      ms: Date.now() - invokeStart,
    });

    // Backstop: PostgREST embedded filters are easy to break with a typo or a
    // schema change. Confirm nothing scheduled at or after the current session
    // slipped through before we feed the data to the model.
    if (currentScheduledAt) {
      const currentTs = new Date(currentScheduledAt).getTime();
      const futureNotes = (notes || []).filter(n => {
        const sa = n && n.coach_bookings && n.coach_bookings.scheduled_at;
        return sa && new Date(sa).getTime() >= currentTs;
      });
      const futureBookings = (bookings || []).filter(b => b && b.scheduled_at && new Date(b.scheduled_at).getTime() >= currentTs);
      if (futureNotes.length > 0 || futureBookings.length > 0) {
        console.error('[pre-session-brief] Data integrity: prior-session filter leaked current/future data', {
          bookingId,
          currentScheduledAt,
          futureNotes: futureNotes.length,
          futureBookings: futureBookings.length,
        });
        return res.status(500).json({ error: 'Data integrity error: prior-session filter did not exclude current/future sessions' });
      }
    }

    const clientName = (() => {
      for (const b of (bookings || [])) {
        const m = (b.notes || '').match(/^Name:\s*(.+)/m);
        if (m) return m[1].trim();
      }
      return clientEmail.split('@')[0];
    })();

    const sessionCount = (bookings || []).length;

    // Prefer structured post_session_analysis JSON from prior sessions
    const priorAnalyses = (notes || []).filter(n => n.post_session_analysis).map(n => n.post_session_analysis);
    let sessionContext = '';
    if (priorAnalyses.length > 0) {
      const latest = priorAnalyses[0];
      const parts = [];
      if (latest.core_focus) parts.push('Core focus: ' + (latest.core_focus.summary || ''));
      if (latest.breakthrough) parts.push('Last breakthrough: ' + (latest.breakthrough.what_changed || latest.breakthrough.client_quote || ''));
      if (latest.pattern) parts.push('Active pattern: ' + (latest.pattern.name || '') + ' — ' + (latest.pattern.description || latest.pattern.trigger || ''));
      if (latest.goals && latest.goals.suggested) parts.push('Suggested goals: ' + latest.goals.suggested.map(g => g.title).join(', '));
      if (latest.commitments) parts.push('Commitments: ' + latest.commitments.map(c => c.text || c.title || '').join(', '));
      if (latest.session_in_one_line) parts.push('Session summary: ' + latest.session_in_one_line);
      // Compat with old schema
      if (latest.pre_session_seed) parts.push('North star: ' + latest.pre_session_seed);
      sessionContext = parts.join('\n');
    }

    const lastNotes = sessionContext || (notes || []).map(n => {
      if (n.structured_notes) return Object.entries(n.structured_notes).map(([k, v]) => `${k}: ${v}`).join('\n');
      return n.notes || '';
    }).join('\n---\n');
    const goalsSummary = (goals || []).map(g => `${g.title} (${g.status})`).join(', ');
    const checkinText = (checkins || []).length ? JSON.stringify(checkins[0].responses) : 'No pre-session check-in submitted';
    const intakeBaseline = (intakeData || []).length ? JSON.stringify(intakeData[0].responses) : '';

    const model = 'claude-sonnet-4-6';
    const startTime = Date.now();
    const systemText = `You are a coaching intelligence assistant preparing a pre-session brief for a professional coach. The session you are preparing for has NOT happened yet — you are PREDICTING what may come up based on PRIOR sessions only. Every observation, pattern, and recommendation must be sourced from sessions that occurred before the upcoming one. Never describe what "happened in this session" or what the client "said today" — those events are still in the future. If the input data is empty or thin, say so plainly rather than inventing material. Your tone is that of a thoughtful senior colleague offering perspective — not a system giving commands. Write in strength-based, forward-focused language. ALWAYS frame guidance as options the coach may consider, not as directives. Preferred phrasings: "consider," "one option," "you might," "your choice," "if this fits," "one approach worth considering," "appears to," "may suggest." Banned phrasings: "you must," "you should," "do this," "always," "never," "the only way," "tell the coach to." The coach is the driver; Coach Clarity is a passenger offering suggestions the coach is free to ignore. No em dashes.

Evidence rules: each entry in patterns_noticed.evidence must be an ACTUAL CLIENT QUOTE drawn from the prior session data, paired with the session it came from and what happened next. Format each string as: \`Session N (date if known): client said "<verbatim quote>" → <what the coach or client did next>\`. If no real quote is available in the source data for a pattern, output fewer evidence entries (or an empty array) rather than inventing one. Honest sparsity beats fabricated specificity. Do not paraphrase quotes into clinical summaries — show the actual phrase the client used.

Confidence rules: assign a qualitative tier per pattern based on how consistently it appears across priorAnalyses. CRITICAL = appears in almost every recent session, will almost certainly come up today. HIGH = appears frequently, watch for it. MODERATE = appears occasionally, stay aware. LOW = appears once, note but do not overweight. Do not compute percentages — there is no pattern-occurrence table, so qualitative judgment is the honest answer. confidence_note is one short sentence explaining the basis for the tier. Keep last_session_summary.recap to 2 sentences maximum. opening_questions must be specific, slightly uncomfortable, and movement-oriented. Not "What are you noticing..." but "What did you actually do differently in that moment vs what you usually do?" Create productive tension that opens the session with direction. For every entry in patterns_noticed you MUST include a pattern_explanation object teaching the coach how to work with the pattern. Write the explanation for a coach who may not have formal psychology training — define the term in plain language without clinical jargon. The "how_to_work_with_it" moves must be concrete, in-session actions the coach can use today, not abstract principles. Return ONLY valid JSON with these exact keys:
{
  "session_header": { "client_name": string, "session_number": number, "date": string },
  "orientation_snapshot": { "readiness_level": string, "primary_focus": string, "open_commitments": [{"title": string, "is_complete": boolean}] },
  "last_session_summary": { "recap": "2 sentences max", "key_insight": string, "between_session_plan": string },
  "patterns_noticed": [{ "title": string, "confidence": "CRITICAL | HIGH | MODERATE | LOW — qualitative tier per the confidence rules above", "confidence_note": "one short sentence on the basis for the tier, referencing how often the pattern appears across priorAnalyses", "evidence": ["array of 2-3 strings (or fewer if real quotes are scarce — do not invent). Each string is a verbatim client quote with its session and what happened next, in the format: Session N (date if known): client said \"<verbatim quote>\" → <what happened next>"], "what_it_enables": "what this strength makes possible in coaching, 1 sentence", "risk_if_ignored": "what happens if coach overlooks this, 1 sentence", "possibility_flag": "string or null — a possibility the coach may want to hold lightly, tentative language only. null if no meaningful possibility exists", "pattern_explanation": { "what_it_is": "plain language definition of the pattern for a coach who may not have formal psychology training, 2-3 sentences. Avoid clinical labels (no \"dysregulation,\" \"maladaptive,\" diagnostic terms).", "in_this_client": "how this pattern shows up specifically in this client's data, 2-3 sentences. Reference real signals — phrases they've used, who they name, what they avoid.", "how_to_work_with_it": ["3 to 5 concrete coaching moves the coach can use today. Each move is one sentence, an observable action — what to notice, what to ask, what to reflect back, what to acknowledge. No abstract principles like \"build awareness\" — give the move."] } }],
  "trajectory": ["2-3 strings showing direction of change over time. Start each with arrow: ↑ improving, → stable/stuck, ↓ declining. Pull from patterns across all sessions. 1 sentence each."],
  "opening_move": "A single exploratory question the coach could use to open the session. Not leading. Invites the client to surface what matters. Example: 'What did you not say in that memo that you already knew?' Under 25 words.",
  "session_strategy": { "primary_move": "one direction worth considering as the primary approach, 1 sentence — this is the anchor", "notice_in_session": "something specific to observe in real-time, 1 sentence", "leverage": "a specific strength or recent win to build on, 1 sentence", "avoid": "what the coach may want to be cautious of, 1 sentence", "decision_point": { "if_reflective": "one approach worth considering if client moves into reflection, 1 sentence", "if_analytical": "one approach worth considering if client stays analytical, 1 sentence" } },
  "realtime_signals": [{ "signal": "an observable in-session cue to watch for", "micro_intervention": "a specific gentle response the coach may want to consider in the moment, 1 sentence" }],
  "confidence_misread_risk": "string or null — generate ONLY when evidence suggests client may intellectually understand a concept without embodying it yet. Tentative language. null if no evidence.",
  "opening_questions": ["specific, slightly uncomfortable, movement-oriented. At least one must address the gap between intellectual understanding and embodied change — body awareness, actual behavior vs. thought about behavior", "another", "another"],
  "focus_this_session": "one sentence starting with an action verb: If nothing else this session, [action]",
  "this_session_is": [string, string, string],
  "this_session_is_not": [string, string, string]
}`;
    const userText = `Prepare a pre-session brief for session #${sessionCount + 1} with ${clientName}.\n\nThis session has NOT happened yet. All context below is drawn exclusively from PRIOR sessions (${priorAnalyses.length} prior session analyses available${currentScheduledAt ? `, all scheduled before ${currentScheduledAt}` : ''}). Predict patterns and risks; do not narrate the upcoming session as if it has already occurred.\n\nPrior session context:\n${lastNotes || 'No previous notes'}\n\nActive goals: ${goalsSummary || 'None set'}\n\nPre-session check-in (submitted by the client before this session): ${checkinText}${intakeBaseline ? '\n\nIntake baseline:\n' + intakeBaseline : ''}\n\nToday's date: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

    console.log('[pre-session-brief] stage 4 calling claude', {
      invokeId,
      systemPromptLength: systemText.length,
      userMessageLength: userText.length,
      priorSessionsCount: priorAnalyses.length,
      model,
      ms: Date.now() - invokeStart,
    });

    // 110s race wrapper sits inside the 120s Vercel function timeout, leaving
    // ~10s of headroom to log the timeout, persist failure to ai-usage, and
    // return a 500. Without it a hung upstream just produces a silent 502.
    const CLAUDE_TIMEOUT_MS = 110000;
    let claudeRes;
    try {
      claudeRes = await Promise.race([
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            // 3500 truncated the JSON mid-output once pattern_explanation
            // (3-5 moves per pattern) landed. Pattern Map and Coaching Strategy
            // both run at 7500; matching that ceiling here to leave headroom.
            max_tokens: 7500,
            system: [{ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' }, text: systemText }],
            messages: [{ role: 'user', content: userText }],
          }),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Claude API timeout after 110s')), CLAUDE_TIMEOUT_MS)),
      ]);
    } catch (fetchErr) {
      console.error('[pre-session-brief] claude fetch failed', {
        invokeId,
        message: fetchErr.message,
        stack: fetchErr.stack ? fetchErr.stack.substring(0, 500) : null,
        durationMs: Date.now() - startTime,
      });
      await logAIUsage({
        feature: 'pre_session_brief',
        coachId,
        model,
        status: 'error',
        errorMessage: fetchErr.message,
        durationMs: Date.now() - startTime,
      });
      return res.status(500).json({ error: 'AI processing failed', details: fetchErr.message });
    }

    const claudeData = await claudeRes.json().catch(function() { return null; });
    console.log('[pre-session-brief] claude returned', {
      invokeId,
      status: claudeRes.status,
      ok: claudeRes.ok,
      stopReason: claudeData && claudeData.stop_reason,
      usage: claudeData && claudeData.usage,
      contentLength: claudeData && claudeData.content && claudeData.content[0] && claudeData.content[0].text ? claudeData.content[0].text.length : 0,
      durationMs: Date.now() - startTime,
    });
    await logAIUsage({
      feature: 'pre_session_brief',
      coachId,
      model: (claudeData && claudeData.model) || model,
      usage: claudeData && claudeData.usage,
      requestId: claudeData && claudeData.id,
      status: claudeRes.ok ? 'success' : 'error',
      errorMessage: claudeRes.ok ? null : (claudeData && claudeData.error && claudeData.error.message),
      durationMs: Date.now() - startTime,
    });
    if (!claudeRes.ok) {
      console.error('[pre-session-brief] claude not ok', {
        invokeId,
        status: claudeRes.status,
        error: claudeData && claudeData.error,
      });
      return res.status(502).json({ error: 'AI processing failed' });
    }

    const text = (claudeData && claudeData.content?.[0]?.text) || '';
    let brief;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      brief = match ? JSON.parse(match[0]) : JSON.parse(text);
    } catch (e) {
      // Surface enough context to diagnose silent truncation / refusal
      // without dumping the whole transcript into logs. stop_reason tells us
      // if Claude hit max_tokens; the head + tail of the text reveals
      // whether output is valid-looking JSON cut off mid-string vs. a
      // refusal vs. wrapped in markdown.
      const stopReason = claudeData && (claudeData.stop_reason || (claudeData.content && claudeData.content[0] && claudeData.content[0].stop_reason));
      console.error('[pre-session-brief] Parse failed', {
        parseError: e.message,
        stopReason,
        textLen: text.length,
        head: text.slice(0, 200),
        tail: text.slice(-200),
      });
      return res.status(500).json({ error: 'Failed to parse brief', stop_reason: stopReason });
    }

    // Inject the static disclaimer at the top of the brief. Done server-side
    // (not via the model) so wording is fixed and tokens are not spent
    // regenerating product copy. Lands in both the response payload and the
    // persisted coach_session_notes.pre_session_intelligence row. Object.assign
    // with about_this_brief first puts the disclaimer at the top of the
    // JSON output for the frontend renderer.
    brief = Object.assign({ about_this_brief: ABOUT_THIS_BRIEF }, brief);

    // Persist the brief to coach_session_notes.pre_session_intelligence so
    // coaches can reopen it later without regenerating. Only runs when a
    // bookingId was supplied (older callers without one still get the
    // ephemeral brief back). Follows the same select-then-update-or-insert
    // pattern used elsewhere in this codebase (save-session-notes.js,
    // post-session-analysis.js) because coach_session_notes has no unique
    // constraint on booking_id — postgrest UPSERT would fail. Persistence
    // failure is non-fatal; the coach still gets the brief in the response.
    console.log('[pre-session-brief] stage 5 persisting', {
      invokeId,
      briefBytes: JSON.stringify(brief).length,
      hasBookingId: !!bookingId,
      ms: Date.now() - invokeStart,
    });
    let persisted = false;
    if (bookingId) {
      try {
        const nowIso = new Date().toISOString();
        const lookupRes = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${encodeURIComponent(bookingId)}&select=id&limit=1`,
          { headers }
        );
        const existing = lookupRes.ok ? await lookupRes.json() : [];
        const writeHeaders = { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
        let writeRes;
        if (Array.isArray(existing) && existing.length && existing[0].id) {
          writeRes = await fetch(
            `${SUPABASE_URL}/rest/v1/coach_session_notes?id=eq.${encodeURIComponent(existing[0].id)}`,
            {
              method: 'PATCH',
              headers: writeHeaders,
              body: JSON.stringify({ pre_session_intelligence: brief, updated_at: nowIso }),
            }
          );
        } else {
          writeRes = await fetch(
            `${SUPABASE_URL}/rest/v1/coach_session_notes`,
            {
              method: 'POST',
              headers: writeHeaders,
              body: JSON.stringify({
                booking_id: bookingId,
                coach_id: coachId,
                client_email: clientEmail,
                pre_session_intelligence: brief,
              }),
            }
          );
        }
        persisted = !!(writeRes && writeRes.ok);
        if (!persisted) {
          const errText = writeRes ? await writeRes.text().catch(function() { return ''; }) : '';
          console.warn('[pre-session-brief] persist failed (non-fatal):', writeRes && writeRes.status, errText.substring(0, 200));
        }
      } catch (persistErr) {
        console.warn('[pre-session-brief] persist threw (non-fatal):', persistErr.message);
      }
    }

    console.log('[pre-session-brief] complete', { invokeId, persisted, totalMs: Date.now() - invokeStart });
    return res.status(200).json(Object.assign({}, brief, { _persisted: persisted }));
  } catch (e) {
    console.error('[pre-session-brief] FATAL', {
      invokeId,
      message: e && e.message,
      stack: e && e.stack ? e.stack.substring(0, 1000) : null,
      totalMs: Date.now() - invokeStart,
    });
    return res.status(500).json({ error: e && e.message ? e.message : 'Internal server error' });
  }
}
