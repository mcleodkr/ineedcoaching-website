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
    const patternMapUrl = `${SUPABASE_URL}/rest/v1/coach_client_patterns?coach_id=eq.${coachId}&client_email=eq.${encodeURIComponent(clientEmail)}&order=last_analyzed.desc&limit=1&select=pattern,last_analyzed`;
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

    // Phase 2 — pull the three new sources into shape for the model. Each
    // is optional; missing data is treated as "not yet aggregated for this
    // client" rather than an error. Empty array, PostgREST error object, or
    // missing nested field all collapse to null and the corresponding
    // top-level field is set to null in the output.
    const patternMap = Array.isArray(patternMapRows) && patternMapRows.length && patternMapRows[0] && patternMapRows[0].pattern
      ? patternMapRows[0].pattern
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

    const model = 'claude-sonnet-4-6';
    const startTime = Date.now();
    const systemText = `You are a coaching intelligence assistant preparing a pre-session brief for a professional coach. The session you are preparing for has NOT happened yet — you are PREDICTING what may come up based on PRIOR sessions only. Every observation, pattern, and recommendation must be sourced from sessions that occurred before the upcoming one. Never describe what "happened in this session" or what the client "said today" — those events are still in the future. If the input data is empty or thin, say so plainly rather than inventing material. Your tone is that of a thoughtful senior colleague offering perspective — not a system giving commands. Write in strength-based, forward-focused language. ALWAYS frame guidance as options the coach may consider, not as directives. Preferred phrasings: "consider," "one option," "you might," "your choice," "if this fits," "one approach worth considering," "appears to," "may suggest." Banned phrasings: "you must," "you should," "do this," "always," "never," "the only way," "tell the coach to." The coach is the driver; Coach Clarity is a passenger offering suggestions the coach is free to ignore. No em dashes.

Evidence rules: each entry in patterns_noticed.evidence must be an ACTUAL CLIENT QUOTE drawn from the prior session data, paired with the session it came from and what happened next. Format each string as: \`Session N (date if known): client said "<verbatim quote>" → <what the coach or client did next>\`. If no real quote is available in the source data for a pattern, output fewer evidence entries (or an empty array) rather than inventing one. Honest sparsity beats fabricated specificity. Do not paraphrase quotes into clinical summaries — show the actual phrase the client used.

Confidence rules: assign a qualitative tier per pattern based on how consistently it appears across priorAnalyses. CRITICAL = appears in almost every recent session, will almost certainly come up today. HIGH = appears frequently, watch for it. MODERATE = appears occasionally, stay aware. LOW = appears once, note but do not overweight. Do not compute percentages — there is no pattern-occurrence table, so qualitative judgment is the honest answer. The confidence field MUST contain EXACTLY one of the four bare tier names — "CRITICAL", "HIGH", "MODERATE", or "LOW" — with NO surrounding characters: no em dash, no parenthetical, no explanation, no count. Put every explanation, frequency note, or basis in confidence_note. Examples of INVALID confidence values: "CRITICAL — qualitative tier per rules above", "HIGH (5 of 7 sessions)", "MODERATE - emerging pattern". Examples of VALID: "CRITICAL", "HIGH", "MODERATE", "LOW". The downstream renderer keys off the bare word, so any extra text breaks the badge. confidence_note is one short sentence explaining the basis for the tier.

Pattern selection (HARD CAP). Limit patterns_noticed to a maximum of 3 entries. If 1+ CRITICAL patterns warrant inclusion, include all CRITICAL patterns up to the cap of 3 first, ranked by leverage; then fill remaining slots (if any) with top HIGH/MODERATE patterns by leverage. If 0 CRITICAL patterns warrant inclusion, return the top 3 of any tier by leverage. Returning fewer than 3 patterns is acceptable when evidence supports fewer — do not pad. Leverage = qualitative weighing of evidence frequency, recency, and behavioral impact.

Phase 2 fields — sourced exclusively from explicit blocks in the user message.

pattern_map_insights — populate from the "## PATTERN MAP" block when the block is present. If the block is absent, pattern_map_insights MUST be null. Inferring content from priorAnalyses or any source other than the PATTERN MAP block is a violation. When populating: identify 2-3 core_patterns most relevant to the upcoming session: pattern_name (verbatim from the rollup), why_it_matters_today (one sentence on why this pattern is likely to surface today, grounded in what the rollup says), watch_for (concrete language or behavioral cue named in the rollup), intervention_point (when in the pattern cycle the rollup suggests is the best moment to intervene). Also produce pattern_frequency.most_active and pattern_frequency.emerging as short strings from the rollup; emerging may be null if the rollup does not flag an emerging pattern. Copy the rollup_as_of timestamp and sessions_since_rollup count from the block header verbatim into the output object.

strategic_context — populate from the "## COACHING STRATEGY" block when the block is present. If the block is absent, strategic_context MUST be null. Inferring content from priorAnalyses or any source other than the COACHING STRATEGY block is a violation. When populating: what_is_working (1 sentence), what_is_not_working (1 sentence), strategic_direction (one-sentence north star), approaches_to_explore (2-3 concrete next moves as strings), when_to_refer (string or null — null unless the rollup explicitly flags referral need). Copy rollup_as_of from the block header.

coach_dna_alert — populate ONLY when BOTH source blocks are present and substantive: the "## COACH DNA PROFILE" block (coach-level rollup: declared_orientation, framework_distribution, growth_edges, signal_patterns) AND the "## COACH DNA MANIFESTATIONS" block (per-session evidence of how those patterns showed up; each entry has a scope of "this_client" or "other_client"). If either block is absent, empty, or contains only generic placeholders without concrete coach-pattern content, coach_dna_alert MUST be null. Inferring a coach pattern from priorAnalyses, session content, frequency observations, or any source other than these two COACH DNA blocks is a violation. The model has no permitted path to construct a coach_dna_alert when either source is missing or sparse — null is the only correct output in that case. When populating: identify the coach's pattern MOST LIKELY to interfere with THIS client's work today. Draw the pattern itself from the PROFILE (signal_patterns or growth_edges), refined by what MANIFESTATIONS show actually surfacing in recent sessions. Prefer this_client manifestations over other_client manifestations when both are available — they are direct evidence for the coach-client pair you are prepping. your_pattern_to_watch (pattern name from the profile, sharpened by manifestation evidence), why_it_matters_with_this_client (one sentence connecting the coach's pattern to a pattern observed in priorAnalyses for THIS client), physical_interrupt (a body-based cue the coach can use to catch themselves; ground it in a specific manifestation when one is concrete).

Source binding (HARD RULE — violations break the contract):

| Output field          | Source block (ONLY)         | If source absent / empty |
| --------------------- | --------------------------- | ------------------------ |
| patterns_noticed      | priorAnalyses               | omit that pattern        |
| pattern_map_insights  | "## PATTERN MAP"            | null                     |
| strategic_context     | "## COACHING STRATEGY"      | null                     |
| coach_dna_alert       | "## COACH DNA PROFILE" + "## COACH DNA MANIFESTATIONS" (BOTH required) | null |

DO NOT infer a field's content from any source other than the row's listed block(s). DO NOT borrow rollup phrasing into patterns_noticed — language like "Flagged as a missed window in every one of the seven prior sessions" or "flagged in the coaching strategy as a pattern consistent enough to anticipate" is rollup-voice and belongs in pattern_map_insights / strategic_context, NEVER in patterns_noticed. patterns_noticed must read like the prior-session record itself: per-session evidence, verbatim quotes, no aggregate frequency framing. DO NOT populate coach_dna_alert by inferring a coach pattern from priorAnalyses, session content, or any source other than the two COACH DNA blocks; if either "## COACH DNA PROFILE" or "## COACH DNA MANIFESTATIONS" is absent or sparse, coach_dna_alert MUST be null. When in doubt, prefer omission over duplication.

EXCEPTION (single, narrow): pattern_loop.intervention_points[].readiness MAY consult Pattern Map and Coaching Strategy rollups to gauge client capacity for the intervention. This exception applies ONLY to the readiness enum value — NOT to intervention_question, NOT to rationale, NOT to any other field in pattern_loop or elsewhere in patterns_noticed. All surrounding content remains priorAnalyses-only. Do not extrapolate this single exception to any other field.

Rollup staleness (HARD RULE). PATTERN MAP and COACHING STRATEGY reflect their rollup as-of the last_analyzed timestamp shown in each block's header. For sessions in priorAnalyses that POSTDATE the rollup's last_analyzed timestamp, priorAnalyses is authoritative and the rollup is treated as historical. pattern_map_insights and strategic_context MUST render the rollup's view as-of its timestamp; do not silently retrofit fresher session data into the rollup output. If sessions_since_rollup > 0, name the staleness plainly in the output (for example, append "(per rollup as of <timestamp>; <N> session(s) since)" to pattern_frequency.most_active, or note it in strategic_direction) rather than producing a hybrid view that conflates rollup data with fresher priorAnalyses content.

Keep last_session_summary.recap to 2 sentences maximum. opening_questions must be specific, slightly uncomfortable, and movement-oriented. Not "What are you noticing..." but "What did you actually do differently in that moment vs what you usually do?" Create productive tension that opens the session with direction. For every entry in patterns_noticed you MUST include a pattern_explanation object teaching the coach how to work with the pattern. Write the explanation for a coach who may not have formal psychology training — define the term in plain language without clinical jargon. The "how_to_work_with_it" moves must be concrete, in-session actions the coach can use today, not abstract principles.

For opening_move (the single exploratory question that opens the session), prefer values-based framing over deficit framing. Reframe deficit prompts toward what the client was prioritizing or protecting. Examples: "What did you prioritize over this?" instead of "Why didn't you do it?"; "What were you protecting?" instead of "What got in the way?". This guidance applies to opening_move only. Patterns receive phrase_options for in-session use, not values-based homework framing.

Per-pattern fields (new in this version). Every entry in patterns_noticed must include the five fields below in addition to the existing eight. All five draw exclusively from priorAnalyses (with the single readiness carve-out above); none borrow rollup voice.

- pattern_loop: a structured model of the client's repeating cycle with stages and intervention points. stages is an array of 4-7 objects, each with stage_index (0-indexed integer, sequential, starting at 0), name (the behavioral stage), and thought_bubble (the internal narrative at that stage). intervention_points is an array of 2-4 objects, each with after_stage_index (must reference a valid stage_index from the stages array), readiness (enum: "primary" highest leverage now / "secondary" supportive / "aspirational" future capacity / "not_yet_ready" would backfire today), intervention_question (the exact question the coach would ask at this point), and rationale (why this intervention at this point). stages and intervention_points are SEPARATE arrays — do not nest intervention_points inside stage objects; intervention_points reference stages by index. If priorAnalyses cannot support at least 4 coherent stages, set pattern_loop to null rather than padding.

- what_to_listen_for: an array of 2-4 strings, each describing a specific verbal or behavioral signal the coach should watch for in the upcoming session (e.g., "She names a new responsibility she has taken on for someone else"; "She uses the phrase 'I just need to' or 'I should'"; "She mentions feeling tired but redirects before naming it"). Always populated for active patterns; never null.

- phrase_options: EXACTLY 4 objects with option_label values "A", "B", "C", "D" in that order. Each object has option_label, exact_phrase, and when_to_use. exact_phrase must be the actual words the coach could speak verbatim — punctuation, emphasis, contractions included — not a description of what to say. Options A, B, and C are dynamic, drawn from THIS client's pattern. Option D is ALWAYS the let-it-go option: its exact_phrase is the fixed string "Let it go this session — your judgment" with NO variation; only its when_to_use is dynamic, describing the in-session moment when naming the pattern would derail what the client is working through. when_to_use is a single string per option (not an array) describing the specific in-session trigger that maps to choosing that option. Never null; always 4 entries.

- physical_cue_in_coach_body: a string naming a concrete physical sensation the coach should watch for in their own body that signals this pattern is firing in session, paired with the in-session trigger that the sensation tracks. Concrete sensation only — no metaphor. Examples: "Tightness in your jaw when she lists what she's handling"; "Heat rising in your chest when she pivots fast from grief"; "The urge to lean forward when she minimizes". Never null.

- pattern_to_watch_in_yourself: an object with your_instinct (the coach's automatic response that would reinforce the client's pattern), alternative_question (a specific question the coach can ask instead, exact words like phrase_options), and why (brief rationale grounded in THIS CLIENT's pattern, not generic coaching theory). Distinct from coach_dna_alert: coach_dna_alert is the coach's general DNA drift across all clients; pattern_to_watch_in_yourself is per-client-pattern at the level of individual session interaction. Both coexist; do not collapse them. Never null.

Distinction between pattern_explanation.how_to_work_with_it and the new phrase_options (BOTH must be populated and substantively different): how_to_work_with_it is GENERAL APPROACH guidance the coach can apply across many sessions with this client — broad coaching moves at the strategy level; phrase_options is EXACT WORDS for THIS specific session with explicit in-session triggers (when_to_use) and the Option D let-it-go. Do NOT duplicate content between the two. If a how_to_work_with_it bullet would read identically to a phrase_options exact_phrase, the bullet is at the wrong level — generalize how_to_work_with_it or sharpen the phrase_option until they read distinct.

Pre-flight check before returning JSON (perform mentally on every field):

1. For each entry in patterns_noticed: verify the entry's language and evidence trace to priorAnalyses — NOT the PATTERN MAP or COACHING STRATEGY rollups. If any entry references aggregate frequency, the rollup voice, or rollup framing, regenerate that entry from priorAnalyses or drop it.

   VALID evidence string: \`Session 5 (Apr 22): client said "I keep doing the thing I told myself I wouldn't" → coach reflected the contradiction back, client paused and named the cost out loud\`

   INVALID examples (rollup-voice leaking into patterns_noticed):
     - "Flagged as a missed window in every one of the seven prior sessions" (aggregate frequency, rollup-voice — belongs in pattern_map_insights)
     - "Consistently flagged in the coaching strategy as a pattern to anticipate" (references the strategy rollup — belongs in strategic_context)
     - "The pattern map shows this is critical to address" (references the pattern map rollup — belongs in pattern_map_insights)
     - Any phrasing that begins with "Across the prior sessions..." or "Consistently across sessions..." (aggregate framing — patterns_noticed entries must cite specific sessions verbatim)

2. For coach_dna_alert: if the user message does not contain BOTH a "## COACH DNA PROFILE" block AND a "## COACH DNA MANIFESTATIONS" block, OR if either is present-but-empty / present-but-sparse, coach_dna_alert MUST be null. There is no permitted inference path from priorAnalyses, the PATTERN MAP, the COACHING STRATEGY, or session content to coach_dna_alert. Null is the only correct answer when either source is absent or sparse.

3. For pattern_map_insights and strategic_context: if the respective source block is absent, the field MUST be null. Do not paraphrase priorAnalyses content into either field as a substitute.

4. patterns_noticed length: verify the array has AT MOST 3 entries. If 1+ CRITICAL patterns warrant inclusion, all CRITICAL patterns appear first (up to the cap of 3) ranked by leverage, then HIGH/MODERATE fill any remaining slots by leverage. If 0 CRITICAL, top 3 of any tier by leverage. Fewer than 3 is acceptable when evidence supports fewer; never pad.

5. For each entry in patterns_noticed: verify all 13 fields are present (title, confidence, confidence_note, evidence, what_it_enables, risk_if_ignored, possibility_flag, pattern_explanation, pattern_loop, what_to_listen_for, phrase_options, physical_cue_in_coach_body, pattern_to_watch_in_yourself). Of these, only possibility_flag and pattern_loop may be null; all other 11 fields must be substantively populated.

6. For each entry's pattern_loop (when not null): verify stages has 4-7 entries with stage_index values 0, 1, 2, ... in sequence with no gaps. Verify intervention_points has 2-4 entries and every after_stage_index value matches an existing stage_index from the same pattern's stages array. Verify each readiness value is exactly one of: primary, secondary, aspirational, not_yet_ready (bare word, no surrounding text). If fewer than 4 coherent stages can be supported by priorAnalyses, set pattern_loop to null rather than padding.

7. For each entry's phrase_options: verify EXACTLY 4 entries with option_label values "A", "B", "C", "D" in that order. Verify option D's exact_phrase is the fixed string "Let it go this session — your judgment" (no variation). Verify A, B, C exact_phrase values are speakable verbatim coach language (the actual words the coach would say), not descriptions of what to say.

8. For each entry: verify pattern_explanation.how_to_work_with_it and phrase_options do not contain duplicate content. how_to_work_with_it is general approach across many sessions; phrase_options is exact words for THIS session. If any how_to_work_with_it bullet reads identically to any phrase_options.exact_phrase, rewrite the bullet at a more general level or sharpen the phrase_option until they read distinct.

Return ONLY valid JSON with these exact keys:
{
  "session_header": { "client_name": string, "session_number": number, "date": string },
  "orientation_snapshot": { "readiness_level": string, "primary_focus": string, "open_commitments": [{"title": string, "is_complete": boolean}] },
  "last_session_summary": { "recap": "2 sentences max", "key_insight": string, "between_session_plan": string },
  "patterns_noticed": [{ "title": string, "confidence": "<exactly one of: CRITICAL or HIGH or MODERATE or LOW. Bare word only, no other text>", "confidence_note": "one short sentence on the basis for the tier, referencing how often the pattern appears across priorAnalyses", "evidence": ["array of 2-3 strings (or fewer if real quotes are scarce — do not invent). Each string is a verbatim client quote with its session and what happened next, in the format: Session N (date if known): client said \"<verbatim quote>\" → <what happened next>"], "what_it_enables": "what this strength makes possible in coaching, 1 sentence", "risk_if_ignored": "what happens if coach overlooks this, 1 sentence", "possibility_flag": "string or null — a possibility the coach may want to hold lightly, tentative language only. null if no meaningful possibility exists", "pattern_explanation": { "what_it_is": "plain language definition of the pattern for a coach who may not have formal psychology training, 2-3 sentences. Avoid clinical labels (no \"dysregulation,\" \"maladaptive,\" diagnostic terms).", "in_this_client": "how this pattern shows up specifically in this client's data, 2-3 sentences. Reference real signals — phrases they've used, who they name, what they avoid.", "how_to_work_with_it": ["3 to 5 concrete coaching moves the coach can use today. Each move is one sentence, an observable action — what to notice, what to ask, what to reflect back, what to acknowledge. No abstract principles like \"build awareness\" — give the move. GENERAL APPROACH across many sessions, not the exact words for this specific session (phrase_options carries the exact words); must not duplicate any phrase_options.exact_phrase."] }, "pattern_loop": { "stages": [{ "stage_index": "integer, 0-indexed, sequential starting at 0", "name": "string — the behavioral stage label", "thought_bubble": "string — the internal narrative at this stage. stages array has 4-7 entries total." }], "intervention_points": [{ "after_stage_index": "integer — must reference a valid stage_index from the stages array above", "readiness": "<exactly one of: primary or secondary or aspirational or not_yet_ready. Bare word only.>", "intervention_question": "string — the exact question the coach would ask at this point", "rationale": "string — why this intervention at this point. intervention_points array has 2-4 entries total." }] }, "what_to_listen_for": ["array of 2-4 strings; each string is a specific verbal or behavioral signal to watch for in the upcoming session"], "phrase_options": [{ "option_label": "<exactly one of: A or B or C or D. Bare letter only.>", "exact_phrase": "string. For options A, B, C: the actual words the coach could speak verbatim — punctuation, emphasis, contractions included — drawn from THIS client's pattern, not a description. For option D: the fixed string \"Let it go this session — your judgment\" with NO variation.", "when_to_use": "string — the specific in-session moment that maps to choosing this option" }], "physical_cue_in_coach_body": "string — a concrete physical sensation in the coach's own body that signals this pattern is firing, paired with the in-session trigger the sensation tracks (e.g., \"Tightness in your jaw when she lists what she's handling\"). Concrete sensation only, never metaphor.", "pattern_to_watch_in_yourself": { "your_instinct": "string — the coach's automatic response that would reinforce the client's pattern", "alternative_question": "string — a specific question the coach can ask instead, exact words like phrase_options", "why": "string — brief rationale grounded in THIS CLIENT's pattern, not generic coaching theory" } }],
  "trajectory": ["2-3 strings showing direction of change over time. Start each with arrow: ↑ improving, → stable/stuck, ↓ declining. Pull from patterns across all sessions. 1 sentence each."],
  "opening_move": "A single exploratory question the coach could use to open the session. Not leading. Invites the client to surface what matters. Example: 'What did you not say in that memo that you already knew?' Under 25 words.",
  "session_strategy": { "primary_move": "one direction worth considering as the primary approach, 1 sentence — this is the anchor", "notice_in_session": "something specific to observe in real-time, 1 sentence", "leverage": "a specific strength or recent win to build on, 1 sentence", "avoid": "what the coach may want to be cautious of, 1 sentence", "decision_point": { "if_reflective": "one approach worth considering if client moves into reflection, 1 sentence", "if_analytical": "one approach worth considering if client stays analytical, 1 sentence" } },
  "realtime_signals": [{ "signal": "an observable in-session cue to watch for", "micro_intervention": "a specific gentle response the coach may want to consider in the moment, 1 sentence" }],
  "confidence_misread_risk": "string or null — generate ONLY when evidence suggests client may intellectually understand a concept without embodying it yet. Tentative language. null if no evidence.",
  "pattern_map_insights": { "core_patterns": [{ "pattern_name": string, "why_it_matters_today": "1 sentence on why this pattern is likely to surface today, grounded in the rollup", "watch_for": "1 sentence — concrete language or behavioral cue from the rollup", "intervention_point": "1 sentence — when in the pattern cycle the rollup suggests is the best moment to intervene" }], "pattern_frequency": { "most_active": "short string from the rollup, with the rollup_as_of staleness note appended when sessions_since_rollup > 0", "emerging": "short string from the rollup, or null if no emerging pattern is flagged" }, "rollup_as_of": "ISO timestamp string, copied verbatim from the PATTERN MAP block header", "sessions_since_rollup": number },
  "strategic_context": { "what_is_working": "1 sentence from the rollup", "what_is_not_working": "1 sentence from the rollup", "strategic_direction": "one-sentence north star from the rollup", "approaches_to_explore": ["2-3 concrete next moves, one per string"], "when_to_refer": "string or null — null unless the rollup explicitly flags a referral need", "rollup_as_of": "ISO timestamp string, copied verbatim from the COACHING STRATEGY block header" },
  "coach_dna_alert": { "your_pattern_to_watch": "pattern name from the coach DNA timeline", "why_it_matters_with_this_client": "1 sentence connecting this coach pattern to a pattern observed in priorAnalyses", "physical_interrupt": "1 sentence — body-based cue the coach can use to catch themselves in the moment" },
  "opening_questions": ["specific, slightly uncomfortable, movement-oriented. At least one must address the gap between intellectual understanding and embodied change — body awareness, actual behavior vs. thought about behavior", "another", "another"],
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

    // 270s race wrapper sits inside the 285s Vercel function timeout
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
    // Bumped again to 270s/285s after Phase 2.9.1 (5eec35a) added 5 new
    // per-pattern fields plus expanded pre-flight checks (3 → 8 items);
    // the 165s wrapper fired at exactly 165034ms with 0/0 tokens on the
    // first regen, confirming the heavier schema exceeds 165s reliably.
    //
    // SIZING NOTE — these constants are minimums-with-headroom, not
    // arbitrary. Candy Apple's verified-good run carried a 7374-byte
    // Pattern Map. Clients (and downstream Sprixle clinical briefs) with
    // richer rollups will push generation time up and may require another
    // bump pair. Always change CLAUDE_TIMEOUT_MS and vercel.json's
    // maxDuration together; keep the ~15s headroom between them so a
    // wrapper-side reject still has time to log, write usage, and return
    // a structured 500 before the platform hard-cuts.
    const CLAUDE_TIMEOUT_MS = 270000;
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Claude API timeout after 270s')), CLAUDE_TIMEOUT_MS)),
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
