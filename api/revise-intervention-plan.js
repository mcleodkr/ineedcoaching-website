// POST { plan_id, coach_feedback, round: 1 | 2 }
// Regenerates the plan with the coach's structured feedback applied.
// Loads the same context the original generation used, so the model can
// re-reason against the full picture (not just the prior plan + feedback).
// Writes a row to intervention_plan_revisions with sections_changed
// derived by shallow-comparing each top-level section before/after.

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

// Byte-identical to generate-intervention-plan.js's PLAN_GUARDRAILS so the
// system block hashes to the same cache key in both endpoints. A coach who
// runs Round 0 → Revise 1 → Revise 2 hits the cached prefix on rounds 1+2.
// Revise-specific framing ("you are refining; preserve unchanged sections")
// goes in the user message so the system block stays cacheable across calls.
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

const SECTION_KEYS = [
  'external_conditions','working_hypotheses','strategic_frames','behavioral_targets',
  'prior_commitments','modality_sequence','progress_markers','risk_watchouts',
  'session_arc','coach_commitment',
];

// Reuse validator logic from generate; copy here to keep endpoints self-contained
// (Vercel deploys each as its own bundle, no shared module path).
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
      .map(c => ({ commitment_text: c.commitment_text, source_session: c.source_session, status: ['kept','broken','ambiguous','untested'].includes(c.status) ? c.status : 'untested' })),
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

// Minimal revise context — the prior plan ALREADY contains source-cited
// synthesis of every session, the pattern map, and the coach DNA. Reloading
// all of that on every revise round was the ~30K-token tax that periodically
// produced 504s. We need just enough to validate citations (valid_session_ids,
// active_goals) and the prior plan to refine. Approach Lab and Coach DNA are
// loaded conditionally only when the coach feedback explicitly references them.
async function fetchMinimalReviseContext(SUPABASE_URL, SUPABASE_KEY, coachId, clientEmail) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const enc = encodeURIComponent(clientEmail);
  const [sessionsRes, goalsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/coach_session_notes?client_email=eq.${enc}&post_session_analysis=not.is.null&select=booking_id&order=created_at.asc`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/coach_goals?coach_id=eq.${coachId}&client_email=eq.${enc}&status=in.(active,progressing,stalled,blocked)&select=id,title,status`, { headers }),
  ]);
  const sessionsRows = await sessionsRes.json().catch(() => []);
  const goalsRows = await goalsRes.json().catch(() => []);
  return {
    valid_session_ids: (Array.isArray(sessionsRows) ? sessionsRows : []).map(s => s && s.booking_id).filter(Boolean),
    active_goals: Array.isArray(goalsRows) ? goalsRows : [],
  };
}

// Keyword detectors — intentionally simple. A real semantic classifier could
// decide better, but isn't worth building until we see the keyword approach
// miss in practice. False positives just load extra context (no quality harm);
// false negatives mean the model lacks supporting material the coach asked for.
function shouldLoadApproachLab(coachFeedback) {
  return /\b(approach lab|lab run|dbt|ifs|emdr|cbt|gestalt|act|specific (modality|technique|skill))\b/i.test(coachFeedback || '');
}
function shouldLoadCoachDNA(coachFeedback) {
  return /\b(coach dna|my pattern|blind spot|my bias|my tendency|my habit)\b/i.test(coachFeedback || '');
}

async function fetchApproachLabRuns(SUPABASE_URL, SUPABASE_KEY, coachId, clientEmail) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const enc = encodeURIComponent(clientEmail);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/approach_lab_runs?coach_id=eq.${coachId}&client_email=eq.${enc}&select=*&order=created_at.desc&limit=10`, { headers });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
}
async function fetchCoachDNA(SUPABASE_URL, SUPABASE_KEY, coachId) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${coachId}&select=signal_patterns&limit=1`, { headers });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.signal_patterns || null;
  } catch (_) { return null; }
}

// Single cached system block — byte-identical to generate-intervention-plan.js
// so the two endpoints share the same cache key.
const CACHED_SYSTEM = PLAN_GUARDRAILS + '\n\n' + PLAN_SCHEMA_INSTRUCTIONS;

function diffSections(before, after) {
  const changed = [];
  for (const k of SECTION_KEYS) {
    if (JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null)) changed.push(k);
  }
  return changed;
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
    const { plan_id, coach_feedback, round } = body;
    if (!plan_id || !coach_feedback || ![1, 2].includes(round)) {
      return res.status(400).json({ error: 'Missing or invalid required fields: plan_id, coach_feedback, round (1|2)' });
    }

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    // Load existing plan
    const planRes = await fetch(`${SUPABASE_URL}/rest/v1/intervention_plans?id=eq.${plan_id}&select=*&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const planRows = await planRes.json();
    if (!Array.isArray(planRows) || planRows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    const existing = planRows[0];
    if (existing.status === 'locked') {
      return res.status(409).json({ error: 'Plan is locked. Use intervention-plan-section to edit fields, or regenerate-from-scratch for a new version.' });
    }
    if (existing.generation_round >= 2) {
      return res.status(409).json({ error: 'Maximum revision rounds reached (2). Lock the plan or edit sections inline.' });
    }
    if (round !== existing.generation_round + 1) {
      return res.status(400).json({ error: `Expected round ${existing.generation_round + 1}, got ${round}` });
    }

    const ctx = await fetchMinimalReviseContext(SUPABASE_URL, SUPABASE_KEY, existing.coach_id, existing.client_email);

    // Conditional augmentation: only pull approach lab / coach DNA when the
    // coach feedback explicitly references them. Logs the decision so we can
    // see in Vercel runtime which path each revision took.
    let approachLabRuns = null;
    let coachDna = null;
    const wantApproach = shouldLoadApproachLab(coach_feedback);
    const wantDna = shouldLoadCoachDNA(coach_feedback);
    if (wantApproach) approachLabRuns = await fetchApproachLabRuns(SUPABASE_URL, SUPABASE_KEY, existing.coach_id, existing.client_email);
    if (wantDna) coachDna = await fetchCoachDNA(SUPABASE_URL, SUPABASE_KEY, existing.coach_id);
    console.log(`[revise] feedback-driven loaders: approach_lab=${wantApproach}, coach_dna=${wantDna}`);

    const beforePlan = {
      external_conditions: existing.external_conditions,
      working_hypotheses: existing.working_hypotheses,
      strategic_frames: existing.strategic_frames,
      behavioral_targets: existing.behavioral_targets,
      prior_commitments: existing.prior_commitments,
      modality_sequence: existing.modality_sequence,
      progress_markers: existing.progress_markers,
      risk_watchouts: existing.risk_watchouts,
      session_arc: existing.session_arc,
      coach_commitment: existing.coach_commitment,
    };

    // The prior plan is the synthesized form of all earlier session evidence —
    // refining against it (plus the coach's feedback) is sufficient. The
    // schema instructions live in the cached system block; the user message
    // carries only what's new per call (prior plan, feedback, validation
    // anchors, conditional approach lab / coach DNA when keyword-matched).
    const approachLabBlock = approachLabRuns ? `\nAPPROACH LAB RUNS:\n${JSON.stringify(approachLabRuns.map(r => ({ approach_name: r.selected_approach || r.approach_name, moments: r.result?.moments?.slice?.(0, 3), created_at: r.created_at })))}\n` : '';
    const coachDnaBlock = coachDna ? `\nCOACH DNA:\n${JSON.stringify({ bias_profile: coachDna.bias_profile?.slice?.(0, 5), pattern_activation_map: coachDna.pattern_activation_map?.slice?.(0, 5), blind_spots: coachDna.blind_spots?.slice?.(0, 3), growth_edges: coachDna.growth_edges?.slice?.(0, 3) })}\n` : '';

    const userPayload = `Refine the existing intervention plan based on the coach's feedback below. You are revising — apply the feedback faithfully, but DO NOT strip sections you weren't asked to change. Return the FULL plan, even if many sections are unchanged.

PRIOR PLAN (full — already contains source-cited synthesis from all sessions, pattern map, and coach DNA):
${JSON.stringify(beforePlan)}

COACH FEEDBACK (round ${round}):
${coach_feedback}

VALID SESSION BOOKING IDS (every source_sessions reference must be in this list):
${JSON.stringify(ctx.valid_session_ids)}

ACTIVE GOALS (every linked_goal_id must be in this list):
${JSON.stringify(ctx.active_goals)}
${approachLabBlock}${coachDnaBlock}`;

    const planRaw = await callClaude(
      ANTHROPIC_API_KEY,
      'claude-sonnet-4-6',
      16000,
      [{ type: 'text', text: CACHED_SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      userPayload,
      `InterventionPlan: Revise round ${round}`,
      { feature: 'intervention_plan', coachId: existing.coach_id }
    );

    const validBookingIds = ctx.valid_session_ids;
    const activeGoalIds = ctx.active_goals.map(g => g.id);
    const newPlan = validatePlan(planRaw, validBookingIds, activeGoalIds);
    const sectionsChanged = diffSections(beforePlan, newPlan);

    // Persist updated plan
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/intervention_plans?id=eq.${plan_id}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        ...newPlan,
        generation_round: round,
        generated_by_ai: true,
      }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error('[revise-intervention-plan] PATCH failed:', err);
      return res.status(500).json({ error: 'Failed to update plan', detail: err.slice(0, 400) });
    }
    const updated = await patchRes.json();
    const updatedRow = Array.isArray(updated) ? updated[0] : updated;

    // Log revision
    await fetch(`${SUPABASE_URL}/rest/v1/intervention_plan_revisions`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        plan_id,
        round,
        coach_feedback,
        claude_response: JSON.stringify(newPlan).slice(0, 50000),
        sections_changed: sectionsChanged,
        product_context: existing.product_context || 'coaching',
      }),
    });

    console.log(`[InterventionPlan] Revised plan ${plan_id} round ${round} — sections changed: ${sectionsChanged.join(', ') || '(none)'}`);
    return res.status(200).json({ ...updatedRow, sections_changed: sectionsChanged });
  } catch (e) {
    console.error('[revise-intervention-plan] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
