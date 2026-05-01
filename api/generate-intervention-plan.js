// POST { coach_id, client_email }
// Generates the cold first round of an intervention plan.
// Reads: every post_session_analysis for the client, the client's
// pattern_map, all active goals, approach_lab_runs filtered by client,
// and the coach's coach_dna patterns. Single Claude pass returns the
// 11-section structured plan; the validator drops items that violate
// the source-tracking guardrails before persistence.

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
        'anthropic-beta': 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
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
    await logAIUsage({ feature: (meta && meta.feature) || 'intervention_plan', coachId: meta && meta.coachId, model, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    throw err;
  }
  await logAIUsage({
    feature: (meta && meta.feature) || 'intervention_plan',
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
    throw new Error(`${passName} output exceeded token limit — try shorter feedback or simpler revision`);
  }
  // Cache observability — cache_read_input_tokens > 0 confirms a hit on the
  // ephemeral system block. Logged so the Vercel runtime log shows whether
  // back-to-back calls in a coach session are cheap (warm cache) or fresh.
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

const PLAN_GUARDRAILS = `You are Coach Clarity, generating a longitudinal intervention plan for a coach working with one client. Read everything you are given. Output strictly valid JSON matching the schema below.

HARD GUARDRAILS — violation drops items at validation time, so respect them at generation:
1. Every output item that has a source_sessions field must populate it with real booking_ids drawn from the supplied sessions list. Items with empty source_sessions will be dropped. Do not fabricate evidence to satisfy this rule — return fewer, better items.
2. Friction points carry forward verbatim. Surface every friction_points item from every session inside external_conditions. You may not paraphrase risks more gently than the source session expressed them. If a source session names a medication change (e.g. self-weaning Zoloft) or substance use (e.g. edibles), reproduce that language with minimal change in external_conditions.
3. When external_conditions contain medication changes, substance use, or major life disruption, downgrade non-compliance interpretations elsewhere in the plan. Treat behavioral failure as state-dependent capacity, not skill resistance. Increase emphasis on tracking versus correcting in modality_sequence and progress_markers.
4. Working hypotheses use hedge language only — phrases like "consistent with", "current pattern suggests", "appears to". Never declarative drives/causes language. The status field is one of: testing | strengthening | weakening. No confidence percentages.
5. Modality requires defense. If you cannot ground a proposed modality in concrete session evidence, omit it. The frontend renders an empty modality_sequence with a "Select modality" CTA, which is a better outcome than a fabricated modality.
6. Every strategic_frame whose primary_tool is non-empty must define at least one fallback_path. If no fallback exists, drop the frame.
7. Pattern integration when sessions name different patterns. If session 1 names pattern A and session 2 names pattern B, integrate them as expressions of an underlying driver in working_hypotheses, OR explicitly call out the pattern shift in source_evidence. Never silently ignore older sessions.
8. Tactical specificity inverse to distance. Session N+1 = "specific". Session N+2 = "contingent". Session N+3 and beyond = "directional". Use the labels exactly.
9. Commitments enumerate from prior sessions. For each commitment found in prior sessions, set status by whether subsequent sessions reference it as kept, broken, or ambiguous. Default to "untested" when no later session references it.
10. Approach Lab runs and Coach DNA are first-class inputs. Weave relevant techniques from approach_lab_runs into modality_sequence. Weave relevant pattern_activation_map and blind_spots from coach_dna into risk_watchouts and coach_commitment without the coach prompting.
11. Adaptive behavioral target cap under high-impact external conditions. If any external_conditions item has impact_level: "high", return at most 3 behavioral_targets in the plan, prioritizing those linked to an active goal_id or supporting the highest-impact external condition directly. Stacking multiple simultaneous practice demands under high-impact external conditions (medication change, active recovery, acute life event) contradicts the state-dependent capacity frame and increases the risk of practice non-compliance being misread as resistance. When in doubt, fewer well-anchored targets are better than many.

TONE: Coaching language only. No clinical labels. No directive phrasing. Use "you might", "this may", "one possible direction".

Return ONLY raw JSON. No markdown. No preamble. Start with { and end with }.`;

const PLAN_SCHEMA_INSTRUCTIONS = `Schema:
{
  "external_conditions": [{ "description": "", "source_sessions": ["booking_id"], "evidence_quote": "", "impact_level": "low|medium|high" }],
  "working_hypotheses": [{ "pattern": "", "drivers": [""], "expressions": { "slow_pattern": "", "fast_pattern": "" }, "confidence": "high|moderate|low", "status": "testing|strengthening|weakening", "source_sessions": ["booking_id"], "evidence_quote": "" }],
  "strategic_frames": [{ "name": "", "description": "", "primary_tool": "", "fallback_paths": [{ "trigger": "", "actions": [""] }], "source_sessions": ["booking_id"] }],
  "behavioral_targets": [{ "target": "", "frequency": "", "context": "", "linked_goal_id": null, "observable": true, "source_sessions": ["booking_id"] }],
  "prior_commitments": [{ "commitment_text": "", "source_session": "booking_id", "status": "kept|broken|ambiguous|untested" }],
  "modality_sequence": [{ "stage": 1, "modality": "", "goal": "", "techniques": [""], "source_evidence": [{ "session_id": "booking_id", "quote": "" }] }],
  "progress_markers": [{ "marker": "", "type": "internal|behavioral|relational", "source_sessions": ["booking_id"] }],
  "risk_watchouts": [{ "pattern": "", "detection_signal": "", "response_strategy": "", "source": "session|pattern_map|coach_dna" }],
  "session_arc": [{ "session_number": 1, "label": "next|if_pause_holds|tentative|review", "focus": "", "specificity": "specific|contingent|directional", "source_sessions": ["booking_id"] }],
  "coach_commitment": { "text": "", "derived_from": ["coach_dna","pattern_map","post_session_analysis"] }
}`;

// Validation: strip items that violate hard guardrails before persistence.
// Validation drops; it does not fabricate. Empty arrays are valid output.
function validatePlan(planRaw, validBookingIds, activeGoalIds) {
  const okBookings = new Set(validBookingIds.map(String));
  const okGoals = new Set(activeGoalIds.map(String));

  function filterBySources(arr) {
    return (Array.isArray(arr) ? arr : []).map(item => {
      const ss = (item && Array.isArray(item.source_sessions) ? item.source_sessions : []).filter(id => okBookings.has(String(id)));
      return { ...item, source_sessions: ss };
    }).filter(item => item.source_sessions.length > 0);
  }

  const out = {
    external_conditions: filterBySources(planRaw.external_conditions).map(i => ({
      description: i.description || '',
      source_sessions: i.source_sessions,
      evidence_quote: i.evidence_quote || '',
      impact_level: ['low','medium','high'].includes(i.impact_level) ? i.impact_level : 'medium',
    })),
    working_hypotheses: filterBySources(planRaw.working_hypotheses).map(i => ({
      pattern: i.pattern || '',
      drivers: Array.isArray(i.drivers) ? i.drivers : [],
      expressions: i.expressions && typeof i.expressions === 'object' ? i.expressions : {},
      confidence: ['high','moderate','low'].includes(i.confidence) ? i.confidence : 'moderate',
      status: ['testing','strengthening','weakening'].includes(i.status) ? i.status : 'testing',
      source_sessions: i.source_sessions,
      evidence_quote: i.evidence_quote || '',
    })),
    strategic_frames: filterBySources(planRaw.strategic_frames).filter(i => {
      // Drop frames whose primary_tool is set but fallback_paths is empty
      const hasPrimary = !!(i.primary_tool && String(i.primary_tool).trim());
      const fallbacks = Array.isArray(i.fallback_paths) ? i.fallback_paths.filter(fp => fp && fp.trigger && Array.isArray(fp.actions) && fp.actions.length) : [];
      if (hasPrimary && fallbacks.length === 0) return false;
      i.fallback_paths = fallbacks;
      return true;
    }),
    behavioral_targets: filterBySources(planRaw.behavioral_targets).map(i => ({
      target: i.target || '',
      frequency: i.frequency || '',
      context: i.context || '',
      linked_goal_id: (i.linked_goal_id && okGoals.has(String(i.linked_goal_id))) ? i.linked_goal_id : null,
      observable: typeof i.observable === 'boolean' ? i.observable : false,
      source_sessions: i.source_sessions,
    })),
    prior_commitments: (Array.isArray(planRaw.prior_commitments) ? planRaw.prior_commitments : [])
      .filter(c => c && c.commitment_text && okBookings.has(String(c.source_session)))
      .map(c => ({
        commitment_text: c.commitment_text,
        source_session: c.source_session,
        status: ['kept','broken','ambiguous','untested'].includes(c.status) ? c.status : 'untested',
      })),
    modality_sequence: (Array.isArray(planRaw.modality_sequence) ? planRaw.modality_sequence : [])
      .filter(m => m && Array.isArray(m.source_evidence) && m.source_evidence.length > 0)
      .map(m => ({
        stage: [1,2,3].includes(m.stage) ? m.stage : 1,
        modality: m.modality || '',
        goal: m.goal || '',
        techniques: Array.isArray(m.techniques) ? m.techniques : [],
        source_evidence: m.source_evidence
          .filter(se => se && okBookings.has(String(se.session_id)))
          .map(se => ({ session_id: se.session_id, quote: se.quote || '' })),
      }))
      .filter(m => m.source_evidence.length > 0)
      // Stage numbering is structural, not a model decision. Overwrite by
      // index after all other validation so we never persist '1, 2, 3, 1'
      // sequences (Claude has produced these). Mirrors the session_arc
      // specificity index override below.
      .map((m, i) => ({ ...m, stage: i + 1 })),
    progress_markers: filterBySources(planRaw.progress_markers).map(i => ({
      marker: i.marker || '',
      type: ['internal','behavioral','relational'].includes(i.type) ? i.type : 'behavioral',
      source_sessions: i.source_sessions,
    })),
    risk_watchouts: (Array.isArray(planRaw.risk_watchouts) ? planRaw.risk_watchouts : [])
      .filter(r => r && r.pattern)
      .map(r => ({
        pattern: r.pattern,
        detection_signal: r.detection_signal || '',
        response_strategy: r.response_strategy || '',
        source: ['session','pattern_map','coach_dna'].includes(r.source) ? r.source : 'session',
      })),
    session_arc: (Array.isArray(planRaw.session_arc) ? planRaw.session_arc : [])
      .filter(s => s)
      .map((s, idx) => ({
        session_number: typeof s.session_number === 'number' ? s.session_number : (idx + 1),
        label: ['next','if_pause_holds','tentative','review'].includes(s.label) ? s.label : (idx === 0 ? 'next' : 'tentative'),
        focus: s.focus || '',
        // Hard-enforce specificity by distance: idx 0 → specific, idx 1 → contingent, idx 2+ → directional
        specificity: idx === 0 ? 'specific' : idx === 1 ? 'contingent' : 'directional',
        source_sessions: (Array.isArray(s.source_sessions) ? s.source_sessions : []).filter(id => okBookings.has(String(id))),
      })),
    coach_commitment: (planRaw.coach_commitment && typeof planRaw.coach_commitment === 'object') ? {
      text: planRaw.coach_commitment.text || '',
      derived_from: Array.isArray(planRaw.coach_commitment.derived_from)
        ? planRaw.coach_commitment.derived_from.filter(d => ['coach_dna','pattern_map','post_session_analysis'].includes(d))
        : [],
    } : { text: '', derived_from: [] },
  };
  // Belt-and-braces enforcement of guardrail 11. When any external condition
  // is high-impact, behavioral_targets are sorted with linked_goal_id items
  // first (Array.prototype.sort is stable, preserving original order within
  // each group), then truncated to 3. Server-side cap so prompt drift never
  // produces a 7-target plan under acute conditions.
  const hasHighImpact = (out.external_conditions || []).some(ec => ec && ec.impact_level === 'high');
  if (hasHighImpact && Array.isArray(out.behavioral_targets) && out.behavioral_targets.length > 3) {
    out.behavioral_targets = out.behavioral_targets.slice().sort(function(a, b) {
      const aLinked = a && a.linked_goal_id ? 1 : 0;
      const bLinked = b && b.linked_goal_id ? 1 : 0;
      return bLinked - aLinked;
    }).slice(0, 3);
  }
  return out;
}

async function fetchAllContext(SUPABASE_URL, SUPABASE_KEY, coach_id, client_email) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const enc = encodeURIComponent(client_email);
  const [sessionsRes, patternRes, goalsRes, approachRes, dnaRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/coach_session_notes?client_email=eq.${enc}&post_session_analysis=not.is.null&select=booking_id,created_at,post_session_analysis&order=created_at.desc`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_client_patterns?coach_id=eq.${coach_id}&client_email=eq.${enc}&select=pattern_map,session_count,last_analyzed&limit=1`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coach_id}&client_email=eq.${enc}&status=in.(active,progressing,stalled,blocked)&select=id,title,description,status,target_date`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/approach_lab_runs?coach_id=eq.${coach_id}&client_email=eq.${enc}&select=*&order=created_at.desc&limit=10`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coach_id}&select=signal_patterns&limit=1`, { headers }),
  ]);

  const sessionsRaw = await sessionsRes.json().catch(() => []);
  const patternRows = await patternRes.json().catch(() => []);
  const goalsRows = await goalsRes.json().catch(() => []);
  // approach_lab_runs may not exist as a table for every install — tolerate 404 / empty
  let approachRows = [];
  try { approachRows = await approachRes.json(); if (!Array.isArray(approachRows)) approachRows = []; } catch (_) { approachRows = []; }
  const dnaRows = await dnaRes.json().catch(() => []);

  // Filter sessions to ones with post_session_analysis (others have nothing to feed)
  const sessions = (Array.isArray(sessionsRaw) ? sessionsRaw : [])
    .filter(s => s && s.booking_id && s.post_session_analysis)
    .map(s => ({
      booking_id: s.booking_id,
      session_date: s.created_at || null,
      analysis: s.post_session_analysis,
    }));

  return {
    sessions,
    pattern_map: patternRows?.[0]?.pattern_map || null,
    pattern_map_meta: patternRows?.[0] ? { session_count: patternRows[0].session_count, last_analyzed: patternRows[0].last_analyzed } : null,
    active_goals: Array.isArray(goalsRows) ? goalsRows : [],
    approach_lab_runs: approachRows,
    coach_dna: dnaRows?.[0]?.signal_patterns || null,
  };
}

function buildUserPayload(ctx) {
  // Compress sessions to the fields the prompt actually needs so we don't
  // blow context on inert metadata.
  const sessionDigests = ctx.sessions.map(s => ({
    booking_id: s.booking_id,
    session_date: s.session_date,
    analysis: {
      key_insights: s.analysis?.key_insights,
      core_focus: s.analysis?.core_focus,
      breakthrough: s.analysis?.breakthrough,
      pattern: s.analysis?.pattern,
      friction_points: s.analysis?.friction_points,
      commitments: s.analysis?.commitments,
      coaching_interventions: s.analysis?.coaching_interventions,
      missed_windows: s.analysis?.missed_windows,
      patterns_and_your_role: s.analysis?.patterns_and_your_role,
      next_session: s.analysis?.next_session,
      emotional_anchor: s.analysis?.emotional_anchor,
    },
  }));

  return `Generate a strategic intervention plan from the following longitudinal context.

SESSIONS (${sessionDigests.length}):
${JSON.stringify(sessionDigests)}

CLIENT PATTERN MAP:
${ctx.pattern_map ? JSON.stringify(ctx.pattern_map) : 'not yet generated'}

ACTIVE GOALS (${ctx.active_goals.length}):
${JSON.stringify(ctx.active_goals)}

APPROACH LAB RUNS FOR THIS CLIENT (${ctx.approach_lab_runs.length}):
${JSON.stringify(ctx.approach_lab_runs.map(r => ({ approach_name: r.selected_approach || r.approach_name, moments: r.result?.moments?.slice?.(0, 3), created_at: r.created_at })))}

COACH DNA (signal patterns):
${ctx.coach_dna ? JSON.stringify({ bias_profile: ctx.coach_dna.bias_profile?.slice?.(0, 5), pattern_activation_map: ctx.coach_dna.pattern_activation_map?.slice?.(0, 5), blind_spots: ctx.coach_dna.blind_spots?.slice?.(0, 3), growth_edges: ctx.coach_dna.growth_edges?.slice?.(0, 3) }) : 'not yet generated'}

`;
}

// Single cached system block. Combines guardrails + schema so the merged
// length clears Anthropic's 1024-token minimum for sonnet-class cache writes
// (guardrails alone is ~764 tokens, schema alone is ~392 tokens; merged
// they're ~1156). Identical bytes used in both generate and revise endpoints
// so the two share the same cache key — back-to-back calls in a coach
// session pay the cache-read discount on subsequent rounds.
const CACHED_SYSTEM = PLAN_GUARDRAILS + '\n\n' + PLAN_SCHEMA_INSTRUCTIONS;

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
    const { coach_id, client_email } = body;
    if (!coach_id || !client_email) {
      return res.status(400).json({ error: 'Missing required fields: coach_id, client_email' });
    }

    const ctx = await fetchAllContext(SUPABASE_URL, SUPABASE_KEY, coach_id, client_email);
    if (ctx.sessions.length === 0) {
      return res.status(400).json({ error: 'No analyzed sessions for this client. Run Coach Clarity on at least one session before generating an intervention plan.' });
    }
    console.log(`[InterventionPlan] Generating for ${client_email} — ${ctx.sessions.length} session(s), ${ctx.active_goals.length} active goal(s), ${ctx.approach_lab_runs.length} approach lab run(s)`);

    const planRaw = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      16000,
      [{ type: 'text', text: CACHED_SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      buildUserPayload(ctx),
      'InterventionPlan: Generation',
      { feature: 'intervention_plan', coachId: coach_id }
    );

    const validBookingIds = ctx.sessions.map(s => s.booking_id);
    const activeGoalIds = ctx.active_goals.map(g => g.id);
    const plan = validatePlan(planRaw, validBookingIds, activeGoalIds);

    // Persist as draft, round 0
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    // Pre-generate the new id so we can archive prior unarchived non-locked
    // plans pointing at it BEFORE the new row is inserted. Locked plans are
    // never auto-archived here — only the explicit "Regenerate from latest
    // sessions" flow archives a locked plan. This prevents stale draft
    // accumulation (the 6-plans-per-client problem) without ever discarding
    // a plan a coach committed to.
    const newPlanId = globalThis.crypto.randomUUID();
    const enc = encodeURIComponent(client_email);
    const archiveRes = await fetch(
      `${SUPABASE_URL}/rest/v1/intervention_plans?coach_id=eq.${coach_id}&client_email=eq.${enc}&status=neq.locked&archived_at=is.null`,
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ archived_at: new Date().toISOString(), archived_for_plan_id: newPlanId }),
      }
    );
    if (!archiveRes.ok) {
      const archErr = await archiveRes.text();
      console.warn('[InterventionPlan] prior-draft archive failed (continuing):', archErr.slice(0, 300));
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/intervention_plans`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        id: newPlanId,
        coach_id,
        client_email,
        status: 'draft',
        generation_round: 0,
        generated_by_ai: true,
        external_conditions: plan.external_conditions,
        working_hypotheses: plan.working_hypotheses,
        strategic_frames: plan.strategic_frames,
        behavioral_targets: plan.behavioral_targets,
        prior_commitments: plan.prior_commitments,
        modality_sequence: plan.modality_sequence,
        progress_markers: plan.progress_markers,
        risk_watchouts: plan.risk_watchouts,
        session_arc: plan.session_arc,
        coach_commitment: plan.coach_commitment,
        product_context: 'coaching',
      }),
    });
    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('[InterventionPlan] insert failed:', err);
      return res.status(500).json({ error: 'Failed to persist plan', detail: err.slice(0, 400) });
    }
    const inserted = await insertRes.json();
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    console.log(`[InterventionPlan] Created plan ${row?.id} (round 0)`);
    return res.status(200).json(row);
  } catch (e) {
    console.error('[generate-intervention-plan] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
