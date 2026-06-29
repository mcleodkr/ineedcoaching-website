// POST { coach_id, client_email, archive_plan_id? }
// Creates a brand-new intervention plan from current context. If
// archive_plan_id is provided, the prior plan is archived (archived_at
// stamped, archived_for_plan_id pointed at the new id) so the timeline
// of plans for this client is preserved.
//
// This is the explicit "Regenerate from latest sessions" surface in the
// locked-mode UI — distinct from /api/revise-intervention-plan, which
// edits an existing draft in place.

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
  let rawText = data.content?.[0]?.text || '';
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const match = rawText.match(/\{[\s\S]*\}/);
  try {
    return match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch (e) {
    throw new Error(`${passName} JSON parse error: ${e.message}`);
  }
}

// Byte-identical to the GUARDRAILS in generate / revise — keeps all three
// intervention-plan-generating endpoints behaviorally identical. (Regenerate
// does not yet use prompt caching; if/when it does, the shared text will
// also share the cache key.)
const PLAN_GUARDRAILS = `You are Coach Clarity, generating a longitudinal intervention plan for a coach working with one client. Read everything you are given. Output strictly valid JSON matching the schema below.

HARD GUARDRAILS — violation drops items at validation time, so respect them at generation:
1. Every output item that has a source_sessions field must populate it with real booking_ids drawn from the supplied sessions list. Items with empty source_sessions will be dropped. Do not fabricate evidence to satisfy this rule — return fewer, better items.
2. Friction points carry forward verbatim. Surface every friction_points item from every session inside external_conditions. You may not paraphrase risks more gently than the source session expressed them. If a source session names a medication change (e.g. self-weaning Zoloft) or substance use (e.g. edibles), reproduce that language with minimal change in external_conditions.
3. When external_conditions contain medication changes, substance use, or major life disruption, downgrade non-compliance interpretations elsewhere in the plan. Treat behavioral failure as state-dependent capacity, not skill resistance. Increase emphasis on tracking versus correcting in modality_sequence and progress_markers.
4. Working hypotheses use hedge language only — phrases like "it looks like", "she seems to", "this might be". Never declarative drives/causes language. The status field is one of: testing | strengthening | weakening. No confidence percentages.
5. Modality requires defense. If you cannot ground a proposed modality in concrete session evidence, omit it. The frontend renders an empty modality_sequence with a "Select modality" CTA, which is a better outcome than a fabricated modality.
6. Every strategic_frame whose primary_tool is non-empty must define at least one fallback_path. If no fallback exists, drop the frame.
7. Pattern integration when sessions name different patterns. If session 1 names pattern A and session 2 names pattern B, integrate them as expressions of an underlying driver in working_hypotheses, OR explicitly call out the pattern shift in source_evidence. Never silently ignore older sessions.
8. Tactical specificity inverse to distance. Session N+1 = "specific". Session N+2 = "contingent". Session N+3 and beyond = "directional". Use the labels exactly.
9. Commitments enumerate from prior sessions. For each commitment found in prior sessions, set status by whether subsequent sessions reference it as kept, broken, or ambiguous. Default to "untested" when no later session references it.
10. Approach Lab runs and Coach DNA are first-class inputs. Weave relevant techniques from approach_lab_runs into modality_sequence. Weave relevant pattern_activation_map and blind_spots from coach_dna into risk_watchouts and coach_commitment without the coach prompting.
11. Adaptive behavioral target cap under high-impact external conditions. If any external_conditions item has impact_level: "high", return at most 3 behavioral_targets in the plan, prioritizing those linked to an active goal_id or supporting the highest-impact external condition directly. Stacking multiple simultaneous practice demands under high-impact external conditions (medication change, active recovery, acute life event) contradicts the state-dependent capacity frame and increases the risk of practice non-compliance being misread as resistance. When in doubt, fewer well-anchored targets are better than many.

VOICE — how every word of this plan must read:
Write so a brand-new coach understands it in one read, and a seasoned coach
respects the precision underneath. One voice for both. The depth never shrinks,
the words do.
- Plain, concrete, everyday words carrying the full meaning. Never make a
  sentence shorter by making the idea thinner.
- Keep the client's exact specifics. The wine, the mirror, the dealer, the
  doctor, the morning text. Never trade a specific for a category like
  "substances" or "external validation."
- Write about the person in flowing sentences, not a chart. No clipped fragments.
- No talking down, no over-explaining, no telling the coach how to feel.
- Coaching register only. No clinical or diagnostic language, no condition
  labels, no modality names, no treatment-protocol framing.
- Gestalt vocabulary in your own voice: never good, bad, right, wrong, should,
  must, mistake, or failure. Use effective, ineffective, aligned with, serving.
  A hard word inside the client's own quote stays.
- No em dashes. Use commas or periods.
- Keep what is uncertain uncertain, but say it plainly: "it looks like",
  "she seems to", "this might be." Not "consistent with", "current pattern
  suggests", "appears to."
The standard to match, same content clinical then plain. Write the plain column:
Clinical: "Fear of being seen as inadequate, driving preemptive moves to head
off judgment. Needing outside proof of worth, with availability and partial
compliance standing in for it."
Plain: "She tends to move first, before anyone gets the chance to decide she
isn't enough. Being available, being helpful, meeting people partway, those
have stood in for proof of her worth."
Clinical: "Wine collection kept, mirror film retained, addiction history
withheld from the doctor. Each a negotiated exception that preserves a sense of
control while quietly sustaining risk."
Plain: "The wine she kept, the film still on the mirror, the part of her history
she held back from her doctor. Each one is a quiet exception she made with
herself. They let her feel in control, and they keep a little risk alive at the
same time."
Nothing got vaguer in the plain column. Only the jargon left.

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
    external_conditions: filterBySources(planRaw.external_conditions).map(i => ({ description: i.description || '', source_sessions: i.source_sessions, evidence_quote: i.evidence_quote || '', impact_level: ['low','medium','high'].includes(i.impact_level) ? i.impact_level : 'medium' })),
    working_hypotheses: filterBySources(planRaw.working_hypotheses).map(i => ({ pattern: i.pattern || '', drivers: Array.isArray(i.drivers) ? i.drivers : [], expressions: i.expressions && typeof i.expressions === 'object' ? i.expressions : {}, confidence: ['high','moderate','low'].includes(i.confidence) ? i.confidence : 'moderate', status: ['testing','strengthening','weakening'].includes(i.status) ? i.status : 'testing', source_sessions: i.source_sessions, evidence_quote: i.evidence_quote || '' })),
    strategic_frames: filterBySources(planRaw.strategic_frames).filter(i => {
      const hasPrimary = !!(i.primary_tool && String(i.primary_tool).trim());
      const fallbacks = Array.isArray(i.fallback_paths) ? i.fallback_paths.filter(fp => fp && fp.trigger && Array.isArray(fp.actions) && fp.actions.length) : [];
      if (hasPrimary && fallbacks.length === 0) return false;
      i.fallback_paths = fallbacks;
      return true;
    }),
    behavioral_targets: filterBySources(planRaw.behavioral_targets).map(i => ({ target: i.target || '', frequency: i.frequency || '', context: i.context || '', linked_goal_id: (i.linked_goal_id && okGoals.has(String(i.linked_goal_id))) ? i.linked_goal_id : null, observable: typeof i.observable === 'boolean' ? i.observable : false, source_sessions: i.source_sessions })),
    prior_commitments: (Array.isArray(planRaw.prior_commitments) ? planRaw.prior_commitments : []).filter(c => c && c.commitment_text && okBookings.has(String(c.source_session))).map(c => ({ commitment_text: c.commitment_text, source_session: c.source_session, status: ['kept','broken','ambiguous','untested'].includes(c.status) ? c.status : 'untested' })),
    modality_sequence: (Array.isArray(planRaw.modality_sequence) ? planRaw.modality_sequence : []).filter(m => m && Array.isArray(m.source_evidence) && m.source_evidence.length > 0).map(m => ({ stage: [1,2,3].includes(m.stage) ? m.stage : 1, modality: m.modality || '', goal: m.goal || '', techniques: Array.isArray(m.techniques) ? m.techniques : [], source_evidence: m.source_evidence.filter(se => se && okBookings.has(String(se.session_id))).map(se => ({ session_id: se.session_id, quote: se.quote || '' })) })).filter(m => m.source_evidence.length > 0).map((m, i) => ({ ...m, stage: i + 1 })),
    progress_markers: filterBySources(planRaw.progress_markers).map(i => ({ marker: i.marker || '', type: ['internal','behavioral','relational'].includes(i.type) ? i.type : 'behavioral', source_sessions: i.source_sessions })),
    risk_watchouts: (Array.isArray(planRaw.risk_watchouts) ? planRaw.risk_watchouts : []).filter(r => r && r.pattern).map(r => ({ pattern: r.pattern, detection_signal: r.detection_signal || '', response_strategy: r.response_strategy || '', source: ['session','pattern_map','coach_dna'].includes(r.source) ? r.source : 'session' })),
    session_arc: (Array.isArray(planRaw.session_arc) ? planRaw.session_arc : []).filter(s => s).map((s, idx) => ({ session_number: typeof s.session_number === 'number' ? s.session_number : (idx + 1), label: ['next','if_pause_holds','tentative','review'].includes(s.label) ? s.label : (idx === 0 ? 'next' : 'tentative'), focus: s.focus || '', specificity: idx === 0 ? 'specific' : idx === 1 ? 'contingent' : 'directional', source_sessions: (Array.isArray(s.source_sessions) ? s.source_sessions : []).filter(id => okBookings.has(String(id))) })),
    coach_commitment: (planRaw.coach_commitment && typeof planRaw.coach_commitment === 'object') ? { text: planRaw.coach_commitment.text || '', derived_from: Array.isArray(planRaw.coach_commitment.derived_from) ? planRaw.coach_commitment.derived_from.filter(d => ['coach_dna','pattern_map','post_session_analysis'].includes(d)) : [] } : { text: '', derived_from: [] },
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
    fetch(`${SUPABASE_URL}/rest/v1/coach_client_patterns?coach_id=eq.${coach_id}&client_email=eq.${enc}&select=pattern_map&limit=1`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coach_id}&client_email=eq.${enc}&status=in.(active,progressing,stalled,blocked)&select=id,title,description,status,target_date`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/approach_lab_runs?coach_id=eq.${coach_id}&client_email=eq.${enc}&select=*&order=created_at.desc&limit=10`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coach_id}&select=signal_patterns&limit=1`, { headers }),
  ]);
  const sessionsRaw = await sessionsRes.json().catch(() => []);
  const patternRows = await patternRes.json().catch(() => []);
  const goalsRows = await goalsRes.json().catch(() => []);
  let approachRows = [];
  try { approachRows = await approachRes.json(); if (!Array.isArray(approachRows)) approachRows = []; } catch (_) {}
  const dnaRows = await dnaRes.json().catch(() => []);
  const sessions = (Array.isArray(sessionsRaw) ? sessionsRaw : [])
    .filter(s => s && s.booking_id && s.post_session_analysis)
    .map(s => ({ booking_id: s.booking_id, session_date: s.created_at || null, analysis: s.post_session_analysis }));
  return {
    sessions,
    pattern_map: patternRows?.[0]?.pattern_map || null,
    active_goals: Array.isArray(goalsRows) ? goalsRows : [],
    approach_lab_runs: approachRows,
    coach_dna: dnaRows?.[0]?.signal_patterns || null,
  };
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
    const { coach_id, client_email, archive_plan_id } = body;
    if (!coach_id || !client_email) {
      return res.status(400).json({ error: 'Missing required fields: coach_id, client_email' });
    }

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    const ctx = await fetchAllContext(SUPABASE_URL, SUPABASE_KEY, coach_id, client_email);
    if (ctx.sessions.length === 0) {
      return res.status(400).json({ error: 'No analyzed sessions for this client.' });
    }

    const userPayload = `Generate a strategic intervention plan from the following longitudinal context.

SESSIONS (${ctx.sessions.length}):
${JSON.stringify(ctx.sessions.map(s => ({ booking_id: s.booking_id, session_date: s.session_date, analysis: { key_insights: s.analysis?.key_insights, core_focus: s.analysis?.core_focus, breakthrough: s.analysis?.breakthrough, pattern: s.analysis?.pattern, friction_points: s.analysis?.friction_points, commitments: s.analysis?.commitments, coaching_interventions: s.analysis?.coaching_interventions, missed_windows: s.analysis?.missed_windows, patterns_and_your_role: s.analysis?.patterns_and_your_role, next_session: s.analysis?.next_session } })))}

CLIENT PATTERN MAP:
${ctx.pattern_map ? JSON.stringify(ctx.pattern_map) : 'not yet generated'}

ACTIVE GOALS:
${JSON.stringify(ctx.active_goals)}

APPROACH LAB RUNS:
${JSON.stringify(ctx.approach_lab_runs.map(r => ({ approach_name: r.selected_approach || r.approach_name, moments: r.result?.moments?.slice?.(0, 3) })))}

COACH DNA:
${ctx.coach_dna ? JSON.stringify({ bias_profile: ctx.coach_dna.bias_profile?.slice?.(0, 5), pattern_activation_map: ctx.coach_dna.pattern_activation_map?.slice?.(0, 5), blind_spots: ctx.coach_dna.blind_spots?.slice?.(0, 3), growth_edges: ctx.coach_dna.growth_edges?.slice?.(0, 3) }) : 'not yet generated'}

${PLAN_SCHEMA_INSTRUCTIONS}`;

    const planRaw = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      16000,
      PLAN_GUARDRAILS,
      userPayload,
      'InterventionPlan: Regenerate from scratch',
      { feature: 'intervention_plan', coachId: coach_id }
    );
    const validBookingIds = ctx.sessions.map(s => s.booking_id);
    const activeGoalIds = ctx.active_goals.map(g => g.id);
    const plan = validatePlan(planRaw, validBookingIds, activeGoalIds);

    // Insert new plan
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/intervention_plans`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        coach_id,
        client_email,
        status: 'draft',
        generation_round: 0,
        generated_by_ai: true,
        ...plan,
        product_context: 'coaching',
      }),
    });
    if (!insertRes.ok) {
      const err = await insertRes.text();
      return res.status(500).json({ error: 'Failed to persist new plan', detail: err.slice(0, 400) });
    }
    const inserted = await insertRes.json();
    const newRow = Array.isArray(inserted) ? inserted[0] : inserted;

    // Archive prior plan if requested
    if (archive_plan_id && newRow?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/intervention_plans?id=eq.${archive_plan_id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          archived_at: new Date().toISOString(),
          archived_for_plan_id: newRow.id,
        }),
      });
    }

    return res.status(200).json(newRow);
  } catch (e) {
    console.error('[regenerate-intervention-plan-from-scratch] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
