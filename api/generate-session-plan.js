// POST { intervention_plan_id, booking_id, coach_id, client_email, regenerate? }
// Generates a tactical session plan for an upcoming booking. Reads the locked
// Intervention Plan + most recent post_session_analysis + active goals +
// pre-session check-in (if any) + recent journal entries. Single Claude pass
// returns the runbook; the validator strips items that violate the structural
// guardrails before persistence.
//
// Each generation is its own row in session_plans (no upsert). Coach can
// regenerate freely; the panel surfaces the most-recent plan.

import { logAIUsage } from '../lib/ai-usage.js';

async function callClaude(apiKey, model, maxTokens, system, userMessage, passName, meta) {
  console.log(`[${passName}] Using model: ${model}`);
  const startTime = Date.now();
  let res, data;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    data = await res.json().catch(function() { return null; });
  } catch (err) {
    await logAIUsage({ feature: (meta && meta.feature) || 'session_plan_builder', coachId: meta && meta.coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    throw err;
  }
  await logAIUsage({
    feature: (meta && meta.feature) || 'session_plan_builder',
    coachId: meta && meta.coachId,
    model: (data && data.model) || model,
    usage: data && data.usage,
    requestId: data && data.id,
    status: res.ok ? 'success' : 'error',
    errorMessage: res.ok ? null : (data && data.error && data.error.message),
    durationMs: Date.now() - startTime,
  });
  if (!res.ok) {
    const errBody = data ? JSON.stringify(data).slice(0, 1000) : '(no body)';
    console.error(`[${passName}] Claude API error ${res.status}:`, errBody);
    throw new Error(`${passName} Claude API error ${res.status}`);
  }
  if (data.stop_reason === 'max_tokens') {
    const rawLen = (data.content?.[0]?.text || '').length;
    console.error(`[${passName}] Output truncated at max_tokens. raw length: ${rawLen}`);
    throw new Error(`${passName} output exceeded token limit`);
  }
  console.log(`[${passName}] Cache stats:`, {
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
    input_tokens: data.usage?.input_tokens,
    output_tokens: data.usage?.output_tokens,
  });
  let rawText = data.content?.[0]?.text || '';
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const match = rawText.match(/\{[\s\S]*\}/);
  try {
    return match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch (e) {
    console.error(`[${passName}] JSON parse failed. Raw:`, rawText.substring(0, 2000));
    throw new Error(`${passName} JSON parse error: ${e.message}`);
  }
}

const SESSION_PLAN_GUARDRAILS = `You are Coach Clarity, generating a tactical session plan for a single upcoming coaching session. Read the locked Intervention Plan, the most recent post-session analysis, active goals, pre-session check-in (if any), and recent journal entries. Output strictly valid JSON matching the schema below.

PRONOUN DEFAULT: Refer to the client using they/them/their unless the supplied source materials show the client and coach consistently using a different pronoun set. Never infer pronouns from names or any demographic cue.

This plan is an instrument, not a synthesis. The coach reads it 5 minutes before the session begins. Every sentence should land immediately, no interpretation needed.

HARD GUARDRAILS — violation drops or repairs the field at validation time, so respect them at generation:
1. today_priority is ONE sentence. If you cannot compress the priority into one sentence, the priority is not yet clear — sharpen it. The validator truncates anything past the first sentence.
2. opening must be a specific question or coach move, not a category. Bad: "Check in on their week." Good: "Open with: 'Where in your body did this past week live?'" When quoting a verbatim opener, prefix with "Open with: ".
3. key_questions are drawn from session_arc[0] of the Intervention Plan or from new pre-session context (check-in / journal). Never invented. If neither has questions to draw from, output 2-3 derived from the plan's working_hypotheses or behavioral_targets and cite the source in source_attribution.
4. do_not_miss is derived from the Intervention Plan's coach_commitment.text, restated as a one-sentence in-session interrupt cue. Example: if commitment says "pause at cost-adjacent moments before reframe", do_not_miss reads: "Interrupt yourself when you start to reframe — slow them at the cost moment."
5. close_with must include checking on at least one prior commitment whose status is "untested" or "ambiguous", pulled from the Intervention Plan's prior_commitments array. Cite the commitment by its text.
6. Time flow is tight: opening_minutes ≤ 8, close_minutes ≤ 10, work fills the middle. No more than 3 work segments. The total minutes provided by the booking must equal opening + work + close.
7. body_cues_to_watch ONLY populates when the Intervention Plan's modality_sequence includes somatic/body/breath/nervous-system stages OR external_conditions imply somatic relevance (recovery context, medication change, dysregulation). Otherwise return an empty array. The validator strips this field if neither condition holds.
8. pre_session_signals populates ONLY with real check-in / journal / approach_lab data provided in this prompt. Each item's source_id MUST appear in the supplied data. If no new context exists, return an empty array. The absence may itself be relevant — note this in source_attribution.notes when applicable. The validator drops any signal whose source_id was not supplied.
9. branches use if-then format drawn from the Intervention Plan's strategic_frames fallback_paths or risk_watchouts. Not invented. Format: { if: "<live signal>", then: "<coach move>" }.
10. Source attribution preserved. Every meaningful field includes which Intervention Plan section, prior session, or pre-session signal it pulls from in source_attribution. Audit trail for therapists later.

TONE: Coaching language only. No clinical labels. No directive phrasing in the coach's interior process — but tactical, instrument-grade language for actions ("Open with…", "Hold the silence after…", "Close with…"). The plan tells the coach what to do, not what to think.

Return ONLY raw JSON. No markdown. No preamble. Start with { and end with }.`;

const SESSION_PLAN_SCHEMA = `Schema:
{
  "today_priority": "ONE sentence — the single most important thing for this session",
  "opening": "specific question or coach move (use 'Open with: ' prefix when quoting)",
  "key_questions": ["question 1", "question 2", "question 3"],
  "do_not_miss": "one-sentence in-session interrupt cue derived from coach_commitment",
  "close_with": "specific close-of-session ask, including a check on a prior commitment",
  "commitments_to_test": [
    {
      "commitment_text": "exact text from prior_commitments",
      "from_session_date": "Apr 12, 2026 or null",
      "current_status": "untested|ambiguous|kept|broken",
      "how_to_check_in": "specific opening to surface this naturally"
    }
  ],
  "pre_session_signals": [
    {
      "type": "checkin|journal|approach_lab",
      "summary": "what new context arrived since last session",
      "source_id": "exact uuid from supplied data"
    }
  ],
  "turning_points": [{ "trigger": "live signal to watch for", "move": "what you do" }],
  "branches": [{ "if": "live signal", "then": "coach move" }],
  "body_cues_to_watch": ["cue 1", "cue 2"],
  "time_flow": {
    "opening": { "minutes": 5, "summary": "what happens here" },
    "work": { "minutes": 35, "summary": "what happens here" },
    "close": { "minutes": 10, "summary": "what happens here" }
  },
  "source_attribution": {
    "today_priority": "ip:session_arc[0]",
    "opening": "ip:session_arc[0].focus",
    "key_questions": ["ip:behavioral_targets", "ip:next_session.listen_for"],
    "do_not_miss": "ip:coach_commitment",
    "close_with": "ip:prior_commitments[N]",
    "branches": "ip:strategic_frames[0].fallback_paths",
    "notes": "optional — capture absence-of-signal observations"
  }
}`;

const CACHED_SYSTEM = SESSION_PLAN_GUARDRAILS + '\n\n' + SESSION_PLAN_SCHEMA;

// Pretty-prints the prior session plan as a human-readable block for the
// model. Used only on Revise (chunk 6.7 accumulate-mode) — sits OUTSIDE the
// cached prefix so cache hits on the system block survive across revisions.
function formatPriorPlanBlock(prior) {
  const lines = ['PRIOR SESSION PLAN (the coach is revising this, not starting over):', ''];
  const cd = prior.coaching_data || {};
  if (cd.today_priority) {
    lines.push('Priority: ' + cd.today_priority);
    lines.push('');
  }
  if (prior.opening) {
    lines.push('Opening:');
    lines.push(prior.opening);
    lines.push('');
  }
  if (Array.isArray(prior.key_questions) && prior.key_questions.length) {
    lines.push('Key questions:');
    prior.key_questions.forEach(function(q) { lines.push('- ' + q); });
    lines.push('');
  }
  if (cd.do_not_miss) {
    lines.push('Do not miss: ' + cd.do_not_miss);
    lines.push('');
  }
  if (Array.isArray(prior.turning_points) && prior.turning_points.length) {
    lines.push('Turning points:');
    prior.turning_points.forEach(function(tp) {
      lines.push('- If ' + (tp && tp.trigger || '') + ' → ' + (tp && tp.move || ''));
    });
    lines.push('');
  }
  if (Array.isArray(prior.branches) && prior.branches.length) {
    lines.push('Branches:');
    prior.branches.forEach(function(b) {
      lines.push('- If ' + (b && b.if || '') + ' → ' + (b && b.then || ''));
    });
    lines.push('');
  }
  if (Array.isArray(prior.body_cues_to_watch) && prior.body_cues_to_watch.length) {
    lines.push('Body cues to watch:');
    prior.body_cues_to_watch.forEach(function(c) { lines.push('- ' + c); });
    lines.push('');
  }
  if (cd.close_with) {
    lines.push('Close with: ' + cd.close_with);
    lines.push('');
  }
  if (prior.time_flow && typeof prior.time_flow === 'object') {
    const tf = prior.time_flow;
    lines.push('Time flow:');
    if (tf.opening) lines.push('- Opening (' + (tf.opening.minutes || '?') + ' min): ' + (tf.opening.summary || ''));
    if (tf.work) lines.push('- Work (' + (tf.work.minutes || '?') + ' min): ' + (tf.work.summary || ''));
    if (tf.close) lines.push('- Close (' + (tf.close.minutes || '?') + ' min): ' + (tf.close.summary || ''));
  }
  return lines.join('\n').trim();
}

function ipSuggestsSomatic(ip) {
  if (!ip) return false;
  const modality = JSON.stringify(ip.modality_sequence || []);
  const conditions = JSON.stringify(ip.external_conditions || []);
  return /somatic|body|breath|nervous system|sensorimotor|polyvagal|grounding/i.test(modality)
    || /recovery|medication|substance|dysreg|sobriety|withdrawal|panic|trauma response/i.test(conditions);
}

function validateSessionPlan(raw, ctx) {
  const r = raw || {};

  // Guardrail 1: today_priority is one sentence. Take everything up to the
  // first sentence-terminator (.!?) followed by whitespace or end-of-string.
  let today_priority = String(r.today_priority || '').trim();
  const firstSentence = today_priority.match(/[^.!?]+[.!?]/);
  if (firstSentence) today_priority = firstSentence[0].trim();

  const opening = String(r.opening || '').trim();
  const key_questions = (Array.isArray(r.key_questions) ? r.key_questions : [])
    .map(q => String(q || '').trim())
    .filter(Boolean)
    .slice(0, 6);
  const do_not_miss = String(r.do_not_miss || '').trim();
  const close_with = String(r.close_with || '').trim();

  const validStatuses = ['untested','ambiguous','kept','broken'];
  const commitments_to_test = (Array.isArray(r.commitments_to_test) ? r.commitments_to_test : [])
    .filter(c => c && c.commitment_text)
    .map(c => ({
      commitment_text: String(c.commitment_text),
      from_session_date: c.from_session_date || null,
      current_status: validStatuses.includes(c.current_status) ? c.current_status : 'untested',
      how_to_check_in: String(c.how_to_check_in || ''),
    }));

  // Guardrail 8: pre_session_signals must have source_ids that match supplied data.
  const validSignalIds = new Set();
  if (ctx.checkin?.id) validSignalIds.add(String(ctx.checkin.id));
  (ctx.journal_entries || []).forEach(j => { if (j?.id) validSignalIds.add(String(j.id)); });
  const pre_session_signals = (Array.isArray(r.pre_session_signals) ? r.pre_session_signals : [])
    .filter(s => s && s.source_id && validSignalIds.has(String(s.source_id)))
    .map(s => ({
      type: ['checkin','journal','approach_lab'].includes(s.type) ? s.type : 'checkin',
      summary: String(s.summary || ''),
      source_id: s.source_id,
    }));

  const turning_points = (Array.isArray(r.turning_points) ? r.turning_points : [])
    .filter(tp => tp && (tp.trigger || tp.move))
    .map(tp => ({ trigger: String(tp.trigger || ''), move: String(tp.move || '') }));

  const branches = (Array.isArray(r.branches) ? r.branches : [])
    .filter(b => b && (b.if || b.then))
    .map(b => ({ if: String(b.if || ''), then: String(b.then || '') }));

  // Guardrail 7: body_cues_to_watch only when the IP suggests somatic relevance.
  const allowSomatic = ipSuggestsSomatic(ctx.intervention_plan);
  const body_cues_to_watch = allowSomatic
    ? (Array.isArray(r.body_cues_to_watch) ? r.body_cues_to_watch : [])
        .map(s => String(s || '').trim()).filter(Boolean)
    : [];

  // Guardrail 6: time flow caps. opening ≤ 8, close ≤ 10, work fills middle.
  const tf = r.time_flow || {};
  const totalMin = ctx.booking_duration_minutes || 60;
  const openingMin = Math.max(1, Math.min(parseInt(tf.opening?.minutes, 10) || 5, 8));
  const closeMin = Math.max(1, Math.min(parseInt(tf.close?.minutes, 10) || 10, 10));
  const workMin = Math.max(5, totalMin - openingMin - closeMin);
  const time_flow = {
    opening: { minutes: openingMin, summary: String(tf.opening?.summary || '') },
    work: { minutes: workMin, summary: String(tf.work?.summary || '') },
    close: { minutes: closeMin, summary: String(tf.close?.summary || '') },
  };

  const source_attribution = (r.source_attribution && typeof r.source_attribution === 'object') ? r.source_attribution : {};

  return {
    today_priority,
    opening,
    key_questions,
    do_not_miss,
    close_with,
    commitments_to_test,
    pre_session_signals,
    turning_points,
    branches,
    body_cues_to_watch,
    time_flow,
    source_attribution,
  };
}

async function fetchContext(SUPABASE_URL, SUPABASE_KEY, intervention_plan_id, booking_id, coach_id, client_email) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const enc = encodeURIComponent(client_email);

  const [ipRes, recentRes, goalsRes, bookingRes, checkinRes, journalRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/intervention_plans?id=eq.${intervention_plan_id}&select=*&limit=1`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_session_notes?client_email=eq.${enc}&post_session_analysis=not.is.null&select=booking_id,created_at,post_session_analysis&order=created_at.desc&limit=1`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coach_id}&client_email=eq.${enc}&status=in.(active,progressing,stalled,blocked)&select=id,title,description,status,target_date`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${booking_id}&select=id,scheduled_at,service_id,status&limit=1`, { headers }),
    // Pre-session check-in attached to this booking (table name varies — try the canonical one used elsewhere)
    fetch(`${SUPABASE_URL}/rest/v1/coach_checkin_responses?client_email=eq.${enc}&booking_id=eq.${booking_id}&select=*&order=created_at.desc&limit=1`, { headers }),
    // Recent journal entries since last session — best-effort, table may not exist for all coaches
    fetch(`${SUPABASE_URL}/rest/v1/coach_journal_entries?client_email=eq.${enc}&select=id,entry_text,created_at&order=created_at.desc&limit=5`, { headers }),
  ]);

  const ipRows = await ipRes.json().catch(() => []);
  const recentRows = await recentRes.json().catch(() => []);
  const goalsRows = await goalsRes.json().catch(() => []);
  const bookingRows = await bookingRes.json().catch(() => []);
  const checkinRows = await checkinRes.json().catch(() => []);
  let journalRows = [];
  try { journalRows = await journalRes.json(); if (!Array.isArray(journalRows)) journalRows = []; } catch (_) {}

  return {
    intervention_plan: Array.isArray(ipRows) ? ipRows[0] : null,
    most_recent_session: Array.isArray(recentRows) ? recentRows[0] : null,
    active_goals: Array.isArray(goalsRows) ? goalsRows : [],
    booking: Array.isArray(bookingRows) ? bookingRows[0] : null,
    checkin: Array.isArray(checkinRows) && checkinRows[0] ? checkinRows[0] : null,
    journal_entries: Array.isArray(journalRows) ? journalRows : [],
    // duration_minutes isn't a column on coach_bookings — duration lives on
    // coach_services as a free-text field ("60 min") and isn't joined here.
    // Default to 60 for the time_flow validator. Wire a proper service join
    // in a follow-up if non-60-minute sessions become a real signal.
    booking_duration_minutes: 60,
  };
}

function buildUserPayload(ctx) {
  const ip = ctx.intervention_plan;
  // Compress to what the prompt actually needs — the IP synthesis already
  // distills the broader arc, so the most recent session contributes only
  // its key signals (commitments, friction, breakthrough, next_session hints).
  const recent = ctx.most_recent_session?.post_session_analysis;
  const recentDigest = recent ? {
    booking_id: ctx.most_recent_session.booking_id,
    created_at: ctx.most_recent_session.created_at,
    key_insights: recent.key_insights,
    breakthrough: recent.breakthrough,
    friction_points: recent.friction_points,
    commitments: recent.commitments,
    next_session: recent.next_session,
    emotional_anchor: recent.emotional_anchor,
  } : null;

  const checkinDigest = ctx.checkin ? {
    id: ctx.checkin.id,
    created_at: ctx.checkin.created_at,
    responses: ctx.checkin.responses || ctx.checkin.checkin_responses || ctx.checkin,
  } : null;

  const journalDigest = ctx.journal_entries.map(j => ({
    id: j.id,
    created_at: j.created_at,
    entry_text: (j.entry_text || '').slice(0, 600),
  }));

  const sessionAt = ctx.booking?.scheduled_at || null;
  const sessionDateLabel = sessionAt ? new Date(sessionAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'upcoming';

  return `Generate a tactical session plan from the following inputs.

UPCOMING SESSION:
- session_date: ${sessionDateLabel}
- duration_minutes: ${ctx.booking_duration_minutes}
- booking_id: ${ctx.booking?.id || 'unknown'}

LOCKED INTERVENTION PLAN (full strategic synthesis):
${JSON.stringify({
    id: ip?.id,
    external_conditions: ip?.external_conditions,
    working_hypotheses: ip?.working_hypotheses,
    strategic_frames: ip?.strategic_frames,
    behavioral_targets: ip?.behavioral_targets,
    prior_commitments: ip?.prior_commitments,
    modality_sequence: ip?.modality_sequence,
    progress_markers: ip?.progress_markers,
    risk_watchouts: ip?.risk_watchouts,
    session_arc: ip?.session_arc,
    coach_commitment: ip?.coach_commitment,
  })}

MOST RECENT SESSION ANALYSIS (single most recent — IP already integrates the broader arc):
${recentDigest ? JSON.stringify(recentDigest) : 'no analyzed sessions on file yet'}

ACTIVE GOALS:
${JSON.stringify(ctx.active_goals)}

PRE-SESSION CHECK-IN FOR THIS BOOKING:
${checkinDigest ? JSON.stringify(checkinDigest) : 'no pre-session check-in submitted'}

RECENT JOURNAL ENTRIES (most recent 5):
${journalDigest.length ? JSON.stringify(journalDigest) : 'no journal entries on file'}

Generate the session plan now. Remember: today_priority is ONE sentence; opening is a specific question or move; pre_session_signals.source_id must match a supplied id; body_cues_to_watch only if the IP suggests somatic relevance; time_flow opening + work + close = ${ctx.booking_duration_minutes}.`;
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
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { intervention_plan_id, booking_id, coach_id, client_email } = body;
    const revision_context = (typeof body.revision_context === 'string' && body.revision_context.trim()) ? body.revision_context.trim() : null;
    if (!intervention_plan_id || !booking_id || !coach_id || !client_email) {
      return res.status(400).json({ error: 'Missing required fields: intervention_plan_id, booking_id, coach_id, client_email' });
    }

    const ctx = await fetchContext(SUPABASE_URL, SUPABASE_KEY, intervention_plan_id, booking_id, coach_id, client_email);

    if (!ctx.intervention_plan) {
      return res.status(404).json({ error: 'Intervention plan not found' });
    }
    if (ctx.intervention_plan.status !== 'locked') {
      return res.status(409).json({ error: 'Intervention plan must be locked before generating a session plan.' });
    }
    if (!ctx.booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    // Look up the prior active plan for this booking. The partial unique
    // index allows at most one — Revise must archive it before INSERT,
    // and a non-revision call must refuse if one already exists (otherwise
    // we silently accumulate duplicates the way pre-chunk-6.5 did).
    let priorPlan = null;
    let priorLookupTolerated = false;
    try {
      // Widened SELECT in chunk 6.7 — Revise now needs the full prior plan
      // content to feed into the accumulate prompt, not just id + coach_edits
      // for the dup-guard.
      const priorRes = await fetch(`${SUPABASE_URL}/rest/v1/session_plans?booking_id=eq.${booking_id}&archived_at=is.null&select=id,coach_edits,opening,key_questions,turning_points,branches,body_cues_to_watch,time_flow,coaching_data&limit=1`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      if (priorRes.ok) {
        const priorRows = await priorRes.json();
        priorPlan = Array.isArray(priorRows) && priorRows[0] ? priorRows[0] : null;
      } else {
        const errBody = await priorRes.text().catch(() => '');
        if (priorRes.status === 400 && /archived_at|column .* does not exist/i.test(errBody)) {
          // Migration not yet applied. Tolerate so the endpoint still returns
          // a plan, but skip the duplicate guard since we can't tell active
          // from archived without the column.
          console.warn('[SessionPlan] archived_at missing — apply migrations/20260425_session_plans_persistence.sql. Duplicate guard disabled until migration runs.');
          priorLookupTolerated = true;
        } else {
          console.error('[SessionPlan] prior-plan lookup failed:', priorRes.status, errBody.slice(0, 300));
        }
      }
    } catch (e) {
      console.error('[SessionPlan] prior-plan lookup exception:', e.message);
    }

    // Non-revision request and an active plan already exists — refuse so the
    // partial unique index never trips and the panel can prompt the coach
    // toward Revise instead of silently creating a duplicate row.
    if (!revision_context && priorPlan && !priorLookupTolerated) {
      return res.status(409).json({
        error: 'A session plan already exists for this booking. Use Revise with new context to update it, or Edit to modify fields directly.',
        existing_plan_id: priorPlan.id,
      });
    }

    console.log(`[SessionPlan] Generating for booking ${booking_id} on locked IP ${intervention_plan_id} — checkin: ${!!ctx.checkin}, journal: ${ctx.journal_entries.length}, goals: ${ctx.active_goals.length}, revision: ${!!revision_context}`);

    // Revise (chunk 6.7) switched from reset-mode to accumulate-mode: the
    // prior session plan is fed into the prompt as fresh context so the model
    // layers the new revision_context onto the existing plan instead of
    // building from scratch. The prior-plan block sits OUTSIDE the cached
    // prefix because it changes per revision; the cached system carries only
    // the static guardrails + schema.
    const hasPriorContent = !!(priorPlan && (priorPlan.opening || (Array.isArray(priorPlan.key_questions) && priorPlan.key_questions.length)));
    const priorPlanBlock = (revision_context && hasPriorContent) ? formatPriorPlanBlock(priorPlan) : '';

    const systemBlocks = [
      { type: 'text', text: CACHED_SYSTEM, cache_control: { type: 'ephemeral' } },
    ];
    if (revision_context) {
      systemBlocks.push({
        type: 'text',
        text: hasPriorContent
          ? `The coach is revising an existing session plan, not generating from scratch. The prior session plan appears in the user message above. The coach's stated reason for this revision is: "${revision_context}"\n\nYour task: integrate the coach's revision context with the prior session plan. Preserve what still serves the session — keep questions, turning points, and branches that align with the new context. Modify or replace what no longer serves. Add new material where the revision context calls for content that wasn't there before.\n\nIf the revision context is directive (e.g., "scrap the prior framing and start with X"), follow it. If the revision context is additive (e.g., "integrate principles of ACT" or "client relapsed this week"), layer the new framing onto the existing plan rather than replacing it wholesale.\n\nOutput the full revised session plan, including any preserved-from-prior content. Do not output a diff or partial update.`
          : `Coach has requested a revision. Their stated reason: ${revision_context}\n\nUse this to inform what should change in the revised plan; preserve what the coach has not flagged as needing change.`,
      });
    }

    const userPayload = priorPlanBlock
      ? `${buildUserPayload(ctx)}\n\n${priorPlanBlock}`
      : buildUserPayload(ctx);

    const planRaw = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      4000,
      systemBlocks,
      userPayload,
      revision_context ? 'SessionPlan: Revision' : 'SessionPlan: Generation',
      { feature: 'session_plan_builder', coachId: coach_id }
    );

    const validated = validateSessionPlan(planRaw, ctx);

    // Pre-generate new id so the archive PATCH can point archived_for_plan_id
    // at the (yet-uninserted) new row. Same archive-then-insert pattern as
    // the IP regenerate-from-scratch flow. If insert fails after archive
    // succeeds, rollback by un-archiving.
    const newPlanId = globalThis.crypto.randomUUID();

    if (revision_context && priorPlan) {
      const archRes = await fetch(`${SUPABASE_URL}/rest/v1/session_plans?id=eq.${priorPlan.id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ archived_at: new Date().toISOString(), archived_for_plan_id: newPlanId }),
      });
      if (!archRes.ok) {
        const archErr = await archRes.text();
        console.error('[SessionPlan] archive prior failed:', archErr);
        return res.status(500).json({ error: 'Failed to archive prior session plan', detail: archErr.slice(0, 400) });
      }
    }

    const nowIso = new Date().toISOString();
    const insertBody = {
      id: newPlanId,
      intervention_plan_id,
      booking_id,
      coach_id,
      client_email,
      opening: validated.opening,
      key_questions: validated.key_questions,
      turning_points: validated.turning_points,
      branches: validated.branches,
      body_cues_to_watch: validated.body_cues_to_watch,
      time_flow: validated.time_flow,
      product_context: 'coaching',
      coaching_data: {
        today_priority: validated.today_priority,
        do_not_miss: validated.do_not_miss,
        close_with: validated.close_with,
        commitments_to_test: validated.commitments_to_test,
        pre_session_signals: validated.pre_session_signals,
        source_intervention_plan_id: intervention_plan_id,
        source_intervention_plan_version: 1,
        source_attribution: validated.source_attribution,
      },
    };
    if (revision_context) {
      insertBody.revision_context = revision_context;
      insertBody.coach_edits = [{
        action: 'revision',
        criteria: revision_context,
        revised_at: nowIso,
        coach_id,
        archived_prior_plan_id: priorPlan?.id || null,
      }];
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/session_plans`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(insertBody),
    });
    if (!insertRes.ok && revision_context && priorPlan) {
      // Rollback the archive — leave the prior plan active so the coach
      // doesn't lose access to a working plan because of a transient error.
      const rollbackErr = await insertRes.text();
      console.error('[SessionPlan] revision insert failed, rolling back archive:', rollbackErr);
      await fetch(`${SUPABASE_URL}/rest/v1/session_plans?id=eq.${priorPlan.id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ archived_at: null, archived_for_plan_id: null }),
      });
      return res.status(500).json({ error: 'Failed to persist revised session plan; prior plan restored', detail: rollbackErr.slice(0, 400) });
    }
    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('[SessionPlan] insert failed:', err);
      return res.status(500).json({ error: 'Failed to persist session plan', detail: err.slice(0, 400) });
    }
    const inserted = await insertRes.json();
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    console.log(`[SessionPlan] Created plan ${row?.id} for booking ${booking_id}`);

    // Log the revise action for usage analytics. session_plan_id points at
    // the NEW plan (the durable artifact resulting from the action); the
    // prior plan id is captured in metadata for chain-walks. Best-effort —
    // do not block the response on logging failure.
    if (revision_context && row?.id) {
      fetch(`${SUPABASE_URL}/rest/v1/session_plan_actions`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          session_plan_id: row.id,
          coach_id,
          client_email,
          booking_id,
          action: 'revise',
          revision_context,
          revision_context_length: revision_context.length,
          had_prior_plan: hasPriorContent,
          metadata: { prior_plan_id: priorPlan?.id || null, intervention_plan_id },
        }),
      }).catch(e => console.error('[SessionPlan] analytics log failed:', e.message));
    }

    // Return the unified shape the panel renders directly — top-level columns
    // plus coaching_data spread so the UI doesn't need to know the storage split.
    return res.status(200).json({
      ...row,
      ...(row?.coaching_data || {}),
    });
  } catch (e) {
    console.error('[generate-session-plan] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
