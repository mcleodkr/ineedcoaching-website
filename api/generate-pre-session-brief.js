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
  // Phase 2.9.3 SSE: stream progress updates so the dashboard can render a
  // real-time checklist instead of a generic spinner. wantsSSE, sendProgress,
  // respondError, and heartbeatInterval are hoisted above the try so the
  // outer catch can branch on wantsSSE and clear the heartbeat on unexpected
  // throws. respondError defaults to JSON; the SSE branch reassigns it after
  // headers are flushed. Once flushHeaders() commits a 2xx, all subsequent
  // errors MUST flow through SSE 'error' events (an HTTP error response is
  // no longer possible).
  let wantsSSE = false;
  let sendProgress = function() {};
  let respondError = function(status, body) { res.status(status).json(body); };
  let heartbeatInterval = null;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { coachId, clientEmail, bookingId } = body;
    if (!coachId || !clientEmail) return res.status(400).json({ error: 'Missing coachId or clientEmail' });
    console.log('[pre-session-brief] inputs', { invokeId, bookingId, coachId, clientEmail });

    // SSE setup AFTER body validation so a 400 on bad input can still be
    // returned as JSON. After flushHeaders() the response is committed to
    // text/event-stream; subsequent errors must be SSE error events.
    wantsSSE = (req.headers.accept || '').includes('text/event-stream');
    if (wantsSSE) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      sendProgress = function(step, status) {
        try { res.write('data: ' + JSON.stringify({ type: 'progress', step: step, status: status }) + '\n\n'); } catch (_) {}
      };
      respondError = function(status, errBody) {
        try {
          res.write('data: ' + JSON.stringify({ type: 'error', message: (errBody && errBody.error) || 'Generation failed', details: errBody && errBody.details }) + '\n\n');
          res.end();
        } catch (_) {}
      };
    }

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    sendProgress('loading_history', 'in_progress');

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
        return respondError(404, { error: 'Booking not found' });
      }
      currentScheduledAt = currentBookingData[0].scheduled_at;
    }
    console.log('[pre-session-brief] stage 1 done', { invokeId, currentScheduledAt, ms: Date.now() - invokeStart });

    // Stage 2: fetch supporting data in parallel. When we have a current
    // scheduled_at, scope notes + bookings to strictly-before; otherwise fall
    // back to recent-N (older callers without a bookingId).
    const notesUrl = currentScheduledAt
      ? `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&coach_bookings.scheduled_at=lt.${encodeURIComponent(currentScheduledAt)}&order=created_at.desc&limit=10&select=notes,format,structured_notes,post_session_analysis,dna_manifestations,created_at,coach_bookings!inner(scheduled_at)`
      : `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=created_at.desc&limit=3&select=notes,format,structured_notes,post_session_analysis,dna_manifestations,created_at`;

    const bookingsUrl = currentScheduledAt
      ? `${SUPABASE_URL}/rest/v1/coach_bookings?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&status=eq.confirmed&scheduled_at=lt.${encodeURIComponent(currentScheduledAt)}&order=scheduled_at.desc&limit=10&select=id,scheduled_at,notes`
      : `${SUPABASE_URL}/rest/v1/coach_bookings?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&status=eq.confirmed&order=scheduled_at.desc&limit=5&select=id,scheduled_at,notes`;

    const goalsUrl = currentScheduledAt
      ? `${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&created_at=lt.${encodeURIComponent(currentScheduledAt)}&order=created_at.desc&select=title,status,target_date`
      : `${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=created_at.desc&select=title,status,target_date`;

    // Phase 2 aggregates. coach_client_patterns and coach_client_strategies
    // are derived rollups built from prior post_session_analysis blobs — by
    // construction they can only describe sessions that have already
    // happened, so no scheduled_at filter is needed here (the upcoming
    // session has not contributed any data yet). Single most-recent row.
    const patternMapUrl = `${SUPABASE_URL}/rest/v1/coach_client_patterns?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=last_analyzed.desc&limit=1&select=pattern_map,last_analyzed`;
    const strategyUrl = `${SUPABASE_URL}/rest/v1/coach_client_strategies?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=last_analyzed.desc&limit=1&select=strategy,last_analyzed`;

    // Phase 2.6 Coach DNA — TWO real sources, replacing the dead lookup at
    // post_session_analysis.coach_dna_timeline that 2.1 assumed (no
    // populated rows anywhere in prod). coach_dna_profiles is the coach-
    // level rollup (one row per coach: declared orientation, framework mix,
    // growth edges, signal patterns). coach_session_notes.dna_manifestations
    // is the per-session evidence of how those patterns showed up — pulled
    // coach-wide here so a sparse this-client manifestation set can fall
    // back to evidence from this coach's other sessions. Client emails on
    // the coach-wide path are redacted in-process before they reach the
    // model (cross-client privacy).
    const coachDnaProfileUrl = `${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&order=last_analyzed.desc&limit=1&select=declared_orientation,framework_distribution,growth_edges,signal_patterns,session_count,last_analyzed`;
    const coachWideManifestationsUrl = currentScheduledAt
      ? `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&dna_manifestations=not.is.null&coach_bookings.scheduled_at=lt.${encodeURIComponent(currentScheduledAt)}&order=created_at.desc&limit=10&select=created_at,client_email,dna_manifestations,coach_bookings!inner(scheduled_at)`
      : `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${coachId}&dna_manifestations=not.is.null&order=created_at.desc&limit=10&select=created_at,client_email,dna_manifestations`;

    console.log('[pre-session-brief] stage 2 fetching', { invokeId, ms: Date.now() - invokeStart });
    const [notesRes, goalsRes, bookingsRes, checkinRes, intakeRes, patternMapRes, strategyRes, dnaProfileRes, coachWideManifestationsRes] = await Promise.all([
      fetch(notesUrl, { headers }),
      fetch(goalsUrl, { headers }),
      fetch(bookingsUrl, { headers }),
      bookingId ? fetch(`${SUPABASE_URL}/rest/v1/coach_checkin_responses?booking_id=eq.${bookingId}&submitted_at=not.is.null&select=responses&limit=1`, { headers }) : Promise.resolve({ json: () => [] }),
      fetch(`${SUPABASE_URL}/rest/v1/coach_intake_responses?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=created_at.desc&limit=1&select=responses`, { headers }),
      fetch(patternMapUrl, { headers }),
      fetch(strategyUrl, { headers }),
      fetch(coachDnaProfileUrl, { headers }),
      fetch(coachWideManifestationsUrl, { headers })
    ]);

    const [notes, goals, bookings, checkins, intakeData, patternMapRows, strategyRows, dnaProfileRows, coachWideManifestationsRaw] = await Promise.all([
      notesRes.json(),
      goalsRes.json(),
      bookingsRes.json(),
      checkinRes.json ? checkinRes.json() : [],
      intakeRes.json(),
      patternMapRes.json().catch(function() { return null; }),
      strategyRes.json().catch(function() { return null; }),
      dnaProfileRes.json().catch(function() { return null; }),
      coachWideManifestationsRes.json().catch(function() { return null; })
    ]);
    console.log('[pre-session-brief] stage 3 fetched', {
      invokeId,
      notesCount: Array.isArray(notes) ? notes.length : null,
      goalsCount: Array.isArray(goals) ? goals.length : null,
      bookingsCount: Array.isArray(bookings) ? bookings.length : null,
      checkinsCount: Array.isArray(checkins) ? checkins.length : null,
      intakeCount: Array.isArray(intakeData) ? intakeData.length : null,
      patternMapStatus: patternMapRes && patternMapRes.status,
      strategyStatus: strategyRes && strategyRes.status,
      dnaProfileStatus: dnaProfileRes && dnaProfileRes.status,
      coachWideManifestationsStatus: coachWideManifestationsRes && coachWideManifestationsRes.status,
      coachWideManifestationsCount: Array.isArray(coachWideManifestationsRaw) ? coachWideManifestationsRaw.length : null,
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
        return respondError(500, { error: 'Data integrity error: prior-session filter did not exclude current/future sessions' });
      }
    }

    sendProgress('loading_history', 'complete');
    sendProgress('pattern_analysis', 'in_progress');

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

    sendProgress('pattern_analysis', 'complete');
    sendProgress('strategic_context', 'in_progress');

    // Phase 2 — pull the three new sources into shape for the model. Each
    // is optional; missing data is treated as "not yet aggregated for this
    // client" rather than an error. Empty array, PostgREST error object, or
    // missing nested field all collapse to null and the corresponding
    // top-level field is set to null in the output.
    const patternMap = Array.isArray(patternMapRows) && patternMapRows.length && patternMapRows[0] && patternMapRows[0].pattern_map
      ? patternMapRows[0].pattern_map
      : null;
    const coachingStrategy = Array.isArray(strategyRows) && strategyRows.length && strategyRows[0] && strategyRows[0].strategy
      ? strategyRows[0].strategy
      : null;
    // Phase 2.6 Coach DNA — two-source extraction. Profile is the
    // coach-level rollup (single row); manifestations are per-session
    // evidence. Client-specific manifestations come from the existing
    // notes fetch (already prior-only + client-scoped); coach-wide
    // manifestations are the separate dnaWide fetch above. Merge with a
    // sparsity-fallback: if we have >=2 client-specific manifestations
    // that's enough specificity, use them alone; otherwise supplement
    // with up to 5 coach-wide entries from this coach's OTHER clients
    // (with client_email stripped — the model never sees other clients'
    // identities). The "substantive" gate at the bottom decides whether
    // the COACH DNA blocks reach the prompt at all — if either source is
    // empty/sparse the field stays null per c94b486's hard rule.
    const coachDnaProfile = Array.isArray(dnaProfileRows) && dnaProfileRows.length && dnaProfileRows[0] ? dnaProfileRows[0] : null;
    function profileIsSubstantive(p) {
      if (!p) return false;
      function hasContent(v) {
        if (!v) return false;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'object') return Object.keys(v).length > 0;
        if (typeof v === 'string') return v.trim().length > 0;
        return false;
      }
      return hasContent(p.signal_patterns) || hasContent(p.growth_edges);
    }
    const coachDnaProfileSubstantive = profileIsSubstantive(coachDnaProfile);

    const clientSpecificManifestations = (notes || [])
      .filter(function(n) { return n && n.dna_manifestations; })
      .map(function(n) {
        return {
          session_date: (n.coach_bookings && n.coach_bookings.scheduled_at) || n.created_at,
          scope: 'this_client',
          manifestation: n.dna_manifestations,
        };
      });
    const clientSessionTimestamps = new Set(clientSpecificManifestations.map(function(m) { return String(m.session_date); }));
    const coachWideManifestations = (Array.isArray(coachWideManifestationsRaw) ? coachWideManifestationsRaw : [])
      .filter(function(n) {
        const ts = (n && n.coach_bookings && n.coach_bookings.scheduled_at) || (n && n.created_at);
        return n && n.dna_manifestations && ts && !clientSessionTimestamps.has(String(ts));
      })
      .map(function(n) {
        return {
          session_date: (n.coach_bookings && n.coach_bookings.scheduled_at) || n.created_at,
          scope: 'other_client',
          manifestation: n.dna_manifestations,
        };
      });
    const mergedManifestations = clientSpecificManifestations.length >= 2
      ? clientSpecificManifestations
      : clientSpecificManifestations.concat(coachWideManifestations.slice(0, 5));
    const emitCoachDnaBlocks = coachDnaProfileSubstantive && mergedManifestations.length > 0;

    // Rollup staleness math. patternMap and coachingStrategy reflect their
    // rollup as-of last_analyzed; any priorAnalyses session that postdates
    // that timestamp is authoritative over the rollup. Compute how many
    // sessions have occurred since each rollup so the model can label the
    // rollup view as historical when sessions_since > 0 instead of silently
    // retrofitting fresh session data into the rollup output.
    const patternMapLastAnalyzed = (Array.isArray(patternMapRows) && patternMapRows[0] && patternMapRows[0].last_analyzed) || null;
    const strategyLastAnalyzed = (Array.isArray(strategyRows) && strategyRows[0] && strategyRows[0].last_analyzed) || null;
    function countSessionsAfter(rollupTs) {
      if (!rollupTs) return 0;
      const rollupMs = new Date(rollupTs).getTime();
      return (notes || []).filter(function(n) {
        const sa = (n && n.coach_bookings && n.coach_bookings.scheduled_at) || (n && n.created_at);
        return sa && new Date(sa).getTime() > rollupMs;
      }).length;
    }
    const sessionsSincePatternMap = countSessionsAfter(patternMapLastAnalyzed);
    const sessionsSinceStrategy = countSessionsAfter(strategyLastAnalyzed);

    console.log('[pre-session-brief] stage 3.5 phase2 sources', {
      invokeId,
      hasPatternMap: !!patternMap,
      patternMapBytes: patternMap ? JSON.stringify(patternMap).length : 0,
      patternMapLastAnalyzed,
      sessionsSincePatternMap,
      hasCoachingStrategy: !!coachingStrategy,
      strategyBytes: coachingStrategy ? JSON.stringify(coachingStrategy).length : 0,
      strategyLastAnalyzed,
      sessionsSinceStrategy,
      hasCoachDnaProfile: !!coachDnaProfile,
      coachDnaProfileSubstantive,
      coachDnaProfileLastAnalyzed: coachDnaProfile ? coachDnaProfile.last_analyzed : null,
      coachDnaProfileSessionCount: coachDnaProfile ? coachDnaProfile.session_count : null,
      clientSpecificManifestationsCount: clientSpecificManifestations.length,
      coachWideManifestationsCount: coachWideManifestations.length,
      mergedManifestationsCount: mergedManifestations.length,
      emitCoachDnaBlocks,
    });

    // SPRIXLE PORT NOTE — rollup_as_of cross-talk observed on c94b486
    // verification: both pattern_map_insights.rollup_as_of and
    // strategic_context.rollup_as_of came back with the strategy
    // timestamp. The two rollups were generated equally fresh today so
    // their last_analyzed values happened to be identical, masking the
    // ambiguity. In clinical port where rollups regenerate on
    // independent cadences (Pattern Map weekly, Strategy after every
    // session, Coach DNA monthly, etc.), the model may copy from the
    // wrong block header and the values will visibly diverge. Open
    // decision: (a) tighten the prompt to force each section's
    // rollup_as_of to copy from its own block header verbatim, or
    // (b) precompute and inject the timestamps server-side as named
    // fields instead of asking the model to extract them. (b) is
    // strictly more reliable. Revisit when rollup cadences diverge.
    const phase2Sections = [];
    if (patternMap) {
      phase2Sections.push('\n\n## PATTERN MAP (last_analyzed: ' + (patternMapLastAnalyzed || 'unknown') + ' — ' + sessionsSincePatternMap + ' prior session(s) have occurred since this rollup)\n' + JSON.stringify(patternMap, null, 2));
    }
    if (coachingStrategy) {
      phase2Sections.push('\n\n## COACHING STRATEGY (last_analyzed: ' + (strategyLastAnalyzed || 'unknown') + ' — ' + sessionsSinceStrategy + ' prior session(s) have occurred since this rollup)\n' + JSON.stringify(coachingStrategy, null, 2));
    }
    if (emitCoachDnaBlocks) {
      const profilePayload = {
        declared_orientation: coachDnaProfile.declared_orientation || null,
        framework_distribution: coachDnaProfile.framework_distribution || null,
        growth_edges: coachDnaProfile.growth_edges || null,
        signal_patterns: coachDnaProfile.signal_patterns || null,
      };
      phase2Sections.push('\n\n## COACH DNA PROFILE (last_analyzed: ' + (coachDnaProfile.last_analyzed || 'unknown') + ', built from ' + (coachDnaProfile.session_count || 'unknown') + ' sessions)\n' + JSON.stringify(profilePayload, null, 2));
      phase2Sections.push('\n\n## COACH DNA MANIFESTATIONS (' + mergedManifestations.length + ' entries: ' + clientSpecificManifestations.length + ' from this client, ' + (mergedManifestations.length - clientSpecificManifestations.length) + ' from this coach\'s other clients with identifying info redacted)\n' + JSON.stringify(mergedManifestations, null, 2));
    }
    const phase2Block = phase2Sections.join('');

    sendProgress('strategic_context', 'complete');
    sendProgress('session_prep', 'in_progress');

    const model = 'claude-sonnet-4-6';
    const startTime = Date.now();
    const systemText = `You are a coaching intelligence system preparing a coach for their next session with a recurring client. Your purpose is operational: deliver the moves, questions, and strategies the coach will actually use in the next 50 minutes. This is COACHING, not therapy — every output must work for an executive coach, life coach, wellness coach, recovery coach, or career coach without clinical training in named therapeutic modalities. The session has NOT happened yet — you are PREDICTING what may come up based on PRIOR sessions only.

CORE REWARD STRUCTURE — read this before generating anything: You are NOT rewarded for elegant prose, sophisticated psychological framing, or nuanced clinical insight. You are rewarded for SPEED-TO-USEFULNESS: every observation must convert to a coaching move within the same sentence, or be cut. If the coach cannot act on it before the next breath, it does not belong in this brief.

THE TEST FOR EVERY SENTENCE before you include it: would a coach with 10 minutes before their session benefit from reading this? If the sentence requires the coach to mentally translate clinical language into a coaching action, REWRITE IT to be the action directly. If the sentence describes a pattern without telling the coach what to listen for or what to say, REWRITE IT to deliver the listening cue or the language. If the sentence cannot survive the test, cut it.

BANNED CLINICAL LANGUAGE — never use these or any phrase that requires therapy training to interpret:
- "dysregulation", "maladaptive", "attachment style", "trauma response", "emotional flooding"
- "fear updating", "evidence-based" anything, "embodiment gap", "cognitive substitution"
- "process detection", "relational positioning", "emotional residency", "managed insight"
- "perceptual shift", "identity-level movement", "integration", "consolidation"
- "manifesting", "metabolizing emotional material", "interoception"
- diagnostic terminology (PTSD, ADHD, BPD, anxiety disorder, etc.) — never label conditions
- named therapeutic protocols (DBT, ACT, IFS, EMDR, CBT) — never reference frameworks by name in this brief

PREFERRED COACHING LANGUAGE — use these instead:
- Instead of "dysregulation" → "intensity", "activation", "going from 0 to 100"
- Instead of "embodiment gap" → "she knows it but hasn't lived it yet"
- Instead of "fear updating" → "checking whether what she expected actually happened"
- Instead of "integration" → "carrying it into how she actually acts"
- Instead of "identity-level movement" → "how she sees herself is changing"
- Use the client's OWN WORDS from prior sessions whenever possible. If she said "I felt the chill", the brief should reference "the chill" — not "the somatic signal".

TONE: thoughtful senior coaching colleague handing over a client brief. Practical, direct, grounded. Frame guidance as options the coach may consider, not directives. Preferred phrasings: "consider", "one option", "you might", "your choice", "if this fits". Banned phrasings: "you must", "you should", "do this", "always", "never", "the only way". The coach is the driver; the system is offering specific moves the coach is free to use or ignore. No em dashes.

EVIDENCE RULES: Every entry in patterns_noticed.what_it_sounds_like_in_her_words MUST be a verbatim client quote with the session it came from. Format: \`Session N (date if known): "<exact words>"\`. If no real quote is available, output fewer entries rather than inventing one. Honest sparsity beats fabricated specificity. Do NOT paraphrase quotes into clinical summaries. Do NOT translate the client's natural language into psychological terminology.

CONFIDENCE RULES: assign a qualitative tier per pattern based on how consistently it appears across priorAnalyses. CRITICAL = appears in almost every recent session. HIGH = appears frequently. MODERATE = appears occasionally. LOW = appears once. The confidence field MUST contain EXACTLY one bare word: "CRITICAL", "HIGH", "MODERATE", or "LOW". No surrounding text. Put explanation in confidence_note (one short sentence).

GLANCE CARD — this is the most important section of the brief. It is what the coach reads in the 60 seconds before the session. Every field must be IMMEDIATELY USABLE without translation:

- listen_for: 3 to 5 cues. Each cue is a short observable signal in client's own language or behavior. Maximum 12 words per cue. Concrete, not abstract.
- intervene_when: 3 to 5 moments. Each item names the OBSERVABLE TRIGGER and the INTERVENTION. Maximum 20 words per item. Complete actions.
- one_move: THE single most important move. One sentence. If the coach can only do one thing today, this is it. Action verb. Specific to this client.
- do_not_miss: the ONE signal that, if it appears, must not slip past. One sentence. Concrete and observable.
- likely_escape_hatch: the specific behavioral move this client uses to avoid the work. One sentence. Grounded in their actual prior-session pattern.
- body_signal_to_watch: one physical signal to watch for. Drawn from prior sessions. Set to null if no body signal is available in prior data.
- best_opening_question: the SINGLE best opening question. Under 25 words. Specific. Slightly uncomfortable. Movement-oriented.

PATTERNS_NOTICED — each entry must include these four sub-elements in this order:

1. what_it_sounds_like_in_her_words: array of 2-3 verbatim client quotes from prior sessions with session number and date. Format: \`Session N (date if known): "<exact quote>"\`. NOT a paraphrase. NOT a summary. The actual phrase she used. If only one real quote exists, return one; if none, return empty array.

2. what_to_listen_for: array of 2-3 specific signals to listen for in THIS session that would indicate this pattern is active. Each item is one short observable phrase. Maximum 15 words.

3. what_to_say_back: array of 2-3 literal coaching prompts the coach could speak when this pattern appears. Each is a complete sentence the coach could say verbatim. Calibrated to this client. Example: "You explained his position clearly. What happened emotionally for you when the invitation never came?" NOT "Reflect the emotional content back to her" (that's a description, not a prompt).

4. coaching_opportunity: one sentence in plain language explaining what this pattern is and what working with it makes possible. No theory. No jargon. No clinical labels.

Phase 2 fields — sourced exclusively from explicit blocks in the user message.

pattern_map_insights — populate from the "## PATTERN MAP" block when present. If the block is absent, MUST be null. When populating: 2-3 core_patterns most relevant today, each with: pattern_name (verbatim from rollup), why_it_matters_today (one sentence), what_to_listen_for (one sentence, observable signal), what_to_say_back (one literal coaching prompt). Inference from priorAnalyses is a violation. Copy rollup_as_of from the block header but the renderer will hide it from the coach UI.

strategic_context — populate from the "## COACHING STRATEGY" block when present. If absent, MUST be null. When populating: what_is_working (1 sentence), what_is_not_working (1 sentence), strategic_direction (one-sentence north star), approaches_to_explore (2-3 concrete next moves as strings, each one usable in a session), when_to_refer (string or null — null unless rollup explicitly flags referral need). Copy rollup_as_of from block header.

coach_dna_alert — populate ONLY when BOTH "## COACH DNA PROFILE" and "## COACH DNA MANIFESTATIONS" blocks are present and substantive. If either absent or sparse, MUST be null. When populating: your_pattern_to_watch (pattern name from profile, sharpened by manifestation evidence), why_it_matters_with_this_client (one sentence connecting coach pattern to client pattern), physical_interrupt (a body-based cue the coach can use to catch themselves in the moment, grounded in a specific manifestation when concrete). Inferring a coach pattern from priorAnalyses, session content, or any source other than these two blocks is a violation.

questions_to_explore — generate 5-8 strategic open-ended questions the coach can use during the session. Each starts with What / How / When / Where (rarely Why). References specific moments, body sensations, or real between-session experiences drawn from priorAnalyses. Avoids hypotheticals. Grounded in what actually happened. Strong example: "What actually happened the last time you felt the urge to escape — and what did you do with the pause?" Weak examples: "How are you feeling about the work?" (too vague), "Did you practice the pause?" (yes/no), "Why do you think you react that way?" (cognitive, not experiential). Populate even when coach_dna_alert and strategic_context are null. Set to null only when priorAnalyses is empty.

SOURCE BINDING (HARD RULE):

| Output field          | Source block (ONLY)         | If source absent / empty |
| --------------------- | --------------------------- | ------------------------ |
| glance_card           | priorAnalyses               | minimal population — best_opening_question only |
| patterns_noticed      | priorAnalyses               | omit that pattern        |
| pattern_map_insights  | "## PATTERN MAP"            | null                     |
| strategic_context     | "## COACHING STRATEGY"      | null                     |
| coach_dna_alert       | "## COACH DNA PROFILE" + "## COACH DNA MANIFESTATIONS" (BOTH required) | null |

Do not infer a field's content from any source other than the row's listed block(s). Do not borrow rollup phrasing into patterns_noticed. Do not borrow patterns_noticed phrasing into glance_card — glance_card must be the synthesized action layer, not a copy.

ROLLUP STALENESS: PATTERN MAP and COACHING STRATEGY reflect their rollup as-of the last_analyzed timestamp. For sessions in priorAnalyses that POSTDATE the rollup, priorAnalyses is authoritative. pattern_map_insights and strategic_context render the rollup view as-of its timestamp. If sessions_since_rollup > 0, note staleness in strategic_direction or the relevant field rather than producing a hybrid view.

PRE-FLIGHT CHECK before returning JSON — perform mentally on every field:

1. GLANCE CARD CHECK: read every field of glance_card. Could a coach with 10 minutes before their session deploy each field WITHOUT mentally translating clinical or abstract language into a coaching action? If any field fails, rewrite it.

2. CLINICAL LANGUAGE CHECK: scan the entire output for any phrase in the banned list. If found, replace with preferred coaching language or the client's own words.

3. EVIDENCE CHECK: every entry in patterns_noticed.what_it_sounds_like_in_her_words contains a real verbatim client quote, or the array is empty.

4. SOURCE BINDING CHECK: pattern_map_insights, strategic_context, coach_dna_alert are null when their source blocks are absent or sparse.

5. WHAT-TO-SAY-BACK CHECK: every patterns_noticed entry's what_to_say_back array contains literal coaching prompts the coach could speak verbatim. No descriptions. No "reflect this" or "validate that". Actual sentences.

PRIORITY (read after the pre-flight check): The dashboard renders glance_card FIRST and may derive missing glance_card fields from your other output. Therefore: write listen_for, intervene_when, one_move, do_not_miss, likely_escape_hatch, body_signal_to_watch, and best_opening_question as immediately deployable coaching intelligence the coach can read in 60 seconds and use without translation. Also write patterns_noticed.what_to_listen_for and patterns_noticed.what_to_say_back as immediately deployable items, since the dashboard's fallback chain may surface them in the Glance Card if glance_card.listen_for or glance_card.intervene_when is sparse. Every coaching prompt in what_to_say_back must be a complete sentence the coach could speak verbatim. Every listen-for cue must be observable in the room.

Return ONLY valid JSON with these exact keys (in this order):

{
  "session_header": { "client_name": string, "session_number": number, "date": string },
  "glance_card": { "listen_for": ["3 to 5 short observable cues, max 12 words each"], "intervene_when": ["3 to 5 complete coaching actions, max 20 words each"], "one_move": "the single most important move, one action-oriented sentence", "do_not_miss": "the one signal that must not slip past, one concrete sentence", "likely_escape_hatch": "the client's specific avoidance move, one grounded sentence", "body_signal_to_watch": "one physical signal to watch in real time, or null if none in prior data", "best_opening_question": "the single best opening question, under 25 words" },
  "orientation_snapshot": { "readiness_level": string, "primary_focus": string, "open_commitments": [{"title": string, "is_complete": boolean}] },
  "last_session_summary": { "recap": "2 sentences max", "key_insight": string, "between_session_plan": string },
  "patterns_noticed": [{
    "title": string,
    "confidence": "<exactly one of: CRITICAL or HIGH or MODERATE or LOW. Bare word only, no other text>",
    "confidence_note": "one short sentence on the basis for the tier",
    "what_it_sounds_like_in_her_words": ["array of 2-3 verbatim client quotes with session and date, in the format: Session N (date if known): (exact quote) — or an empty array if no real quote is available"],
    "what_to_listen_for": ["array of 2-3 short observable signals, max 15 words each"],
    "what_to_say_back": ["array of 2-3 literal coaching prompts the coach could speak verbatim"],
    "coaching_opportunity": "one sentence, plain language, no theory, no jargon, no clinical labels"
  }],
  "trajectory": ["2-3 strings showing direction of change over time. Start each with arrow: ↑ improving, → stable/stuck, ↓ declining. 1 sentence each."],
  "session_strategy": { "primary_move": "one direction worth considering as the primary approach, 1 sentence", "notice_in_session": "something specific to observe in real-time, 1 sentence", "leverage": "a specific strength or recent win to build on, 1 sentence", "avoid": "what the coach may want to be cautious of, 1 sentence", "decision_point": { "if_reflective": "one approach worth considering if client moves into reflection, 1 sentence", "if_analytical": "one approach worth considering if client stays analytical, 1 sentence" } },
  "questions_to_explore": ["array of 5-8 open-ended questions starting with What/How/When/Where (rarely Why), grounded in specific between-session moments or body sensations from priorAnalyses, avoiding yes/no or cognitive framings. Set to null only when priorAnalyses is empty."],
  "pattern_map_insights": { "core_patterns": [{ "pattern_name": string, "why_it_matters_today": "1 sentence", "what_to_listen_for": "1 sentence, observable signal from the rollup", "what_to_say_back": "1 literal coaching prompt the coach could speak verbatim" }], "rollup_as_of": "ISO timestamp string copied verbatim from the PATTERN MAP block header, used internally — renderer will hide", "sessions_since_rollup": number },
  "strategic_context": { "what_is_working": "1 sentence from the rollup", "what_is_not_working": "1 sentence from the rollup", "strategic_direction": "one-sentence north star from the rollup", "approaches_to_explore": ["2-3 concrete next moves, one per string"], "when_to_refer": "string or null — null unless the rollup explicitly flags a referral need", "rollup_as_of": "ISO timestamp string copied verbatim from the COACHING STRATEGY block header, used internally — renderer will hide" },
  "coach_dna_alert": { "your_pattern_to_watch": string, "why_it_matters_with_this_client": "1 sentence connecting the coach pattern to a pattern observed in priorAnalyses for this client", "physical_interrupt": "1 sentence — body-based cue the coach can use to catch themselves in the moment" },
  "focus_this_session": "one sentence starting with an action verb: If nothing else this session, [action]",
  "this_session_is": [string, string, string],
  "this_session_is_not": [string, string, string]
}`;
    const userText = `Prepare a pre-session brief for session #${sessionCount + 1} with ${clientName}.\n\nThis session has NOT happened yet. All context below is drawn exclusively from PRIOR sessions (${priorAnalyses.length} prior session analyses available${currentScheduledAt ? `, all scheduled before ${currentScheduledAt}` : ''}). Predict patterns and risks; do not narrate the upcoming session as if it has already occurred.\n\nPrior session context:\n${lastNotes || 'No previous notes'}\n\nActive goals: ${goalsSummary || 'None set'}\n\nPre-session check-in (submitted by the client before this session): ${checkinText}${intakeBaseline ? '\n\nIntake baseline:\n' + intakeBaseline : ''}\n\nToday's date: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}${phase2Block}`;

    console.log('[pre-session-brief] stage 4 calling claude', {
      invokeId,
      systemPromptLength: systemText.length,
      userMessageLength: userText.length,
      priorSessionsCount: priorAnalyses.length,
      model,
      ms: Date.now() - invokeStart,
    });

    // 165s race wrapper sits inside the 180s Vercel function timeout
    // (vercel.json), leaving ~15s of headroom to log the timeout, persist
    // failure to ai-usage, and return a 500. Without it a hung upstream
    // produces a silent 502.
    //
    // Was 110s under the previous 120s maxDuration. The first Phase 2.2+2.3
    // attempt (e64b076) failed with the wrapper firing at exactly the
    // 110000ms bound — confirmed by coach_ai_usage_log showing duration_ms
    // = 110002 and 110031 on the two failed runs, zero output tokens (no
    // Anthropic charge). Bumping to 165s/180s pair gave the first verified
    // success (2e05fff: 146s actual generation, ran 19s under the wrapper).
    //
    // SIZING NOTE — these constants are minimums-with-headroom, not
    // arbitrary. Candy Apple's verified-good run carried a 7374-byte
    // Pattern Map. Clients (and downstream Sprixle clinical briefs) with
    // richer rollups will push generation time up and may require another
    // bump pair. Always change CLAUDE_TIMEOUT_MS and vercel.json's
    // maxDuration together; keep the ~15s headroom between them so a
    // wrapper-side reject still has time to log, write usage, and return
    // a structured 500 before the platform hard-cuts.
    const CLAUDE_TIMEOUT_MS = 165000;
    // SSE keep-alive during the long Claude wait. Without periodic comment
    // lines, intermediate proxies (Vercel edge, browsers, corporate) can
    // close idle streams between 30-120s, leaving the checklist visually
    // stalled even though generation is still progressing. 15s is well
    // under the typical 30s timeout. Comment lines (':\n\n') are valid SSE
    // and the EventSource/fetch-stream parser on the client ignores them.
    if (wantsSSE) {
      heartbeatInterval = setInterval(function() {
        try { res.write(':\n\n'); } catch (_) {}
      }, 15000);
    }
    let claudeRes;
    try {
      claudeRes = await Promise.race([
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            // 3500 truncated once pattern_explanation (3-5 moves per pattern)
            // landed. 7500 worked for Phase 1. Phase 2.2+2.3 added three new
            // top-level sections (pattern_map_insights, strategic_context,
            // coach_dna_alert) — bumped to 12000 to leave room for the larger
            // expected output without mid-stream truncation. 2e05fff's
            // verified-good run used 6310 output tokens, so 12000 holds ~2x
            // headroom against today's payload.
            //
            // SIZING NOTE — like CLAUDE_TIMEOUT_MS above, this is a minimum-
            // with-headroom, not an arbitrary number. Sprixle clinical briefs
            // will carry richer rollups (denser Pattern Maps, longer Coaching
            // Strategies, multi-page Coach DNA timelines) and may push output
            // past today's 12k ceiling. Watch claudeData.stop_reason in the
            // "claude returned" log; "max_tokens" means a real client just
            // tripped the ceiling and the cap needs to go up.
            max_tokens: 12000,
            system: [{ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' }, text: systemText }],
            messages: [{ role: 'user', content: userText }],
          }),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Claude API timeout after 165s')), CLAUDE_TIMEOUT_MS)),
      ]);
    } catch (fetchErr) {
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
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
      return respondError(500, { error: 'AI processing failed', details: fetchErr.message });
    }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }

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
      return respondError(502, { error: 'AI processing failed' });
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
      return respondError(500, { error: 'Failed to parse brief', stop_reason: stopReason });
    }

    // Inject the static disclaimer at the top of the brief. Done server-side
    // (not via the model) so wording is fixed and tokens are not spent
    // regenerating product copy. Lands in both the response payload and the
    // persisted coach_session_notes.pre_session_intelligence row. Object.assign
    // with about_this_brief first puts the disclaimer at the top of the
    // JSON output for the frontend renderer.
    brief = Object.assign({ about_this_brief: ABOUT_THIS_BRIEF }, brief);

    sendProgress('session_prep', 'complete');
    sendProgress('finalizing', 'in_progress');

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

    sendProgress('finalizing', 'complete');

    console.log('[pre-session-brief] complete', { invokeId, persisted, totalMs: Date.now() - invokeStart });
    const finalBrief = Object.assign({}, brief, { _persisted: persisted });
    if (wantsSSE) {
      try {
        res.write('data: ' + JSON.stringify({ type: 'complete', result: finalBrief }) + '\n\n');
        res.end();
      } catch (_) {}
      return;
    }
    return res.status(200).json(finalBrief);
  } catch (e) {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    console.error('[pre-session-brief] FATAL', {
      invokeId,
      message: e && e.message,
      stack: e && e.stack ? e.stack.substring(0, 1000) : null,
      totalMs: Date.now() - invokeStart,
    });
    if (wantsSSE) {
      try {
        res.write('data: ' + JSON.stringify({ type: 'error', message: (e && e.message) || 'Internal server error' }) + '\n\n');
        res.end();
      } catch (_) {}
      return;
    }
    return res.status(500).json({ error: e && e.message ? e.message : 'Internal server error' });
  }
}
