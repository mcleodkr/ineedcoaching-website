// api/generate-effectiveness-map.js
//
// Effectiveness Map synthesis (P.I.P.E.S.). Read-only intelligence endpoint.
// COACH-INITIATED: the caller authenticates as a coach; the Map is generated for
// one of that coach's connected clients. Three access gates run BEFORE any Claude
// call; if any fails, Claude is never invoked.
//
//   POST { goal, phase, answers{10}, client_email, session_id, explorer_id?, product_context? }
//   Authorization: Bearer <coach JWT>   (required)
//   product_context: 'coaching' (default — ineedcoaching) | 'therapy' (Sprixle).
//
//   Gate 1a — coach has an active paid subscription (coach_profiles.subscription_status = 'active').
//   Gate 1b — client_email is an ACTIVE connection of this coach (coach_clients).
//   Gate 2  — coach is under their monthly Map limit (by tier: founding 25 / practice 50 / scale 150).
//   Failures: 401 UNAUTHORIZED (no/invalid coach token) · 403 ACCESS_DENIED · 403 MONTHLY_LIMIT_EXCEEDED.
//
// Conventions copied from generate-coaching-strategy.js: the system prompt is
// wrapped in a 1h ephemeral cache block; jsonrepair rescues near-miss JSON;
// logAIUsage records spend. Supabase via REST + service-role key (qroizygknxdjsstkezsf).
//
// Decisions locked with the framework owner (2026-06-09):
//   - Caller model -> coach-initiated only (no anonymous; client_email from body,
//     trusted only after the coach_clients gate; coach identity from the JWT).
//   - Unknown/null tier -> lowest limit (25), so an active coach is never hard-blocked
//     by a tier-string mismatch. (founding/scale exact strings to be confirmed.)
//   - Crisis  -> store a MINIMAL row (content-free crisis object; NO goal/phase/
//     client_email/narratives). Exempt from the monthly limit — not counted (though a
//     Claude call was still made: crisis is detected inside the synthesis call).
//   - Failure -> 200 + { status: 'failed', error_code } (house style), never 500.

import { createRequire } from 'module';
import { logAIUsage } from '../lib/ai-usage.js';
import { jsonrepair } from 'jsonrepair';

const require = createRequire(import.meta.url);
const SYNTH = require('./prompts/effectiveness-map-synthesis-v1.7.1.json');
const SYNTHESIS_PROMPT = SYNTH.prompt;
const PROMPT_VERSION = SYNTH.version; // '1.7.1'

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4000;
const PHASES = ['Dreaming', 'Building', 'Refining', 'Releasing', 'Sustaining'];
const PRODUCT_CONTEXTS = ['coaching', 'therapy']; // default 'coaching' (ineedcoaching); 'therapy' = Sprixle
const ANSWER_KEYS = [
  'physical_1', 'physical_2',
  'intellectual_1', 'intellectual_2',
  'psychological_1', 'psychological_2',
  'environmental_1', 'environmental_2',
  'social_1', 'social_2',
];

// Monthly Map-generation limits by subscription tier. Unknown/null tier falls back
// to DEFAULT_TIER_LIMIT (lowest) so an active coach is never blocked by a tier-string
// mismatch. NOTE: only 'practice' is confirmed in prod; confirm 'founding'/'scale'.
const TIER_LIMITS = { founding: 25, practice: 50, scale: 150 };
const DEFAULT_TIER_LIMIT = 25;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json', ...(extra || {}) };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function monthStartISO() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// --- access-gate data access -------------------------------------------------

// Caller (coach) email from the verified JWT — never from the body.
async function deriveCoachEmail(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    const email = u && u.email ? String(u.email).trim().toLowerCase() : '';
    return email || null;
  } catch {
    return null;
  }
}

async function loadCoach(coachEmail) {
  const url = `${SUPABASE_URL}/rest/v1/coach_profiles`
    + `?user_email=ilike.${encodeURIComponent(coachEmail)}`
    + `&select=id,subscription_status,subscription_tier&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Gate 1b — is client_email an active connection of this coach? Compare lowercased
// in JS to avoid LIKE-wildcard pitfalls; a coach roster is small and bounded.
async function isActiveConnection(coachId, clientEmail) {
  const url = `${SUPABASE_URL}/rest/v1/coach_clients`
    + `?coach_id=eq.${encodeURIComponent(coachId)}&status=eq.active&select=client_email`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return false;
  const rows = await r.json().catch(() => null);
  if (!Array.isArray(rows)) return false;
  const target = clientEmail.toLowerCase();
  return rows.some((row) => row && row.client_email && String(row.client_email).toLowerCase() === target);
}

// Gate 2 — count this coach's non-crisis Maps in the current calendar month (UTC) via
// an exact PostgREST count. Crisis rows are exempt from the limit (no map was produced
// for the client). Returns null if the count can't be determined.
async function monthlyMapCount(coachId) {
  const url = `${SUPABASE_URL}/rest/v1/effectiveness_maps`
    + `?coach_id=eq.${encodeURIComponent(coachId)}&crisis_flag=eq.false`
    + `&created_at=gte.${encodeURIComponent(monthStartISO())}&select=id`;
  const r = await fetch(url, { headers: sbHeaders({ Prefer: 'count=exact', Range: '0-0' }) });
  if (!r.ok && r.status !== 206) return null;
  const cr = r.headers.get('content-range') || '';
  const total = parseInt(cr.split('/')[1], 10);
  return Number.isFinite(total) ? total : null;
}

// --- synthesis (unchanged from explorer-initiated build) ---------------------

// Normalize v1.7 `explorer_facing` into the stored explorer_facing_output shape.
// Field names stay aligned with what map/results.html and coach-dashboard.html
// read (primary_status / snapshot_paragraph / system_picture.narrative), so
// v1.5 through v1.7 rows render through one code path. The stored key stays
// `system_picture` for that compatibility — the model field is `whole_picture`
// and the frontend label is "The Whole Picture"; the explorer never sees the
// key. v1.7 additions: opener, status_legend, closing_summary.
function collectExplorerFacing(map) {
  const ef = (map.explorer_facing && typeof map.explorer_facing === 'object') ? map.explorer_facing : {};
  const out = {};
  out.opener = ef.opener ?? null;
  out.status_legend = map.status_legend ?? null;
  if (ef.domains && typeof ef.domains === 'object') {
    out.domain_statuses = {};
    for (const [domain, d] of Object.entries(ef.domains)) {
      if (!d || typeof d !== 'object') continue;
      out.domain_statuses[domain] = {
        primary_status: d.status_label ?? null,
        secondary_status: d.secondary_label ?? null,
        snapshot_paragraph: d.paragraph ?? null,
      };
    }
  }
  out.system_picture = ef.whole_picture != null ? { narrative: ef.whole_picture } : null;
  out.how_this_shows_up = ef.how_this_shows_up ?? null;
  out.closing_summary = (ef.closing_summary && typeof ef.closing_summary === 'object') ? ef.closing_summary : null;
  out.release_question = ef.release_question ?? null;
  return out;
}

// Generated explorer-facing words only — the fixed opener and status legend are
// returned copy, not narrative, and don't count against the 700-1100 target.
function wordCount(map) {
  const ef = (map.explorer_facing && typeof map.explorer_facing === 'object') ? map.explorer_facing : {};
  const parts = [];
  if (ef.domains && typeof ef.domains === 'object') {
    for (const d of Object.values(ef.domains)) {
      if (d && d.paragraph) parts.push(d.paragraph);
    }
  }
  if (ef.whole_picture) parts.push(ef.whole_picture);
  if (ef.how_this_shows_up) parts.push(ef.how_this_shows_up);
  if (ef.closing_summary && typeof ef.closing_summary === 'object') {
    for (const c of Object.values(ef.closing_summary)) {
      if (c && c.plain) parts.push(c.plain);
    }
  }
  if (ef.release_question && ef.release_question.question) parts.push(ef.release_question.question);
  const text = parts.filter(Boolean).join(' ').trim();
  return text ? text.split(/\s+/).length : 0;
}

function buildUserMessage(input) {
  const a = input.answers;
  return [
    `Goal: ${input.goal}`,
    `Phase: ${input.phase}`,
    '',
    'Physical domain:',
    `Q1 (body noticing): ${a.physical_1}`,
    `Q2 (change since goal): ${a.physical_2}`,
    '',
    'Intellectual domain:',
    `Q3 (thinking availability): ${a.intellectual_1}`,
    `Q4 (inner chatter): ${a.intellectual_2}`,
    '',
    'Psychological domain:',
    `Q5 (first internal response): ${a.psychological_1}`,
    `Q6 (standing in it): ${a.psychological_2}`,
    '',
    'Environmental domain:',
    `Q7 (space/people/conditions): ${a.environmental_1}`,
    `Q8 (reflects where going/been): ${a.environmental_2}`,
    '',
    'Social domain:',
    `Q9 (who is in the room): ${a.social_1}`,
    `Q10 (sacrifice/compromise/negotiate): ${a.social_2}`,
  ].join('\n');
}

async function callClaude(userMessage) {
  const startTime = Date.now();
  const systemPayload = [{ type: 'text', text: SYNTHESIS_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  let res, data;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPayload,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    await logAIUsage({ feature: 'effectiveness_map', model: MODEL, status: 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    throw err;
  }
  await logAIUsage({
    feature: 'effectiveness_map',
    model: (data && data.model) || MODEL,
    usage: data && data.usage,
    requestId: data && data.id,
    status: res.ok ? 'success' : 'error',
    errorMessage: res.ok ? null : (data && data.error && data.error.message),
    durationMs: Date.now() - startTime,
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}`);
  const text = data && data.content && data.content[0] && data.content[0].text;
  if (!text) throw new Error('Empty Claude response');
  return text;
}

function parseMap(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  try { return JSON.parse(jsonrepair(t)); } catch { /* fall through */ }
  return null;
}

async function getExisting(sessionId) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/effectiveness_maps?session_id=eq.${encodeURIComponent(sessionId)}&select=crisis_flag,raw_output&limit=1`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) return null;
    const rows = await r.json().catch(() => null);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

async function storeRow(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/effectiveness_maps`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`storage ${r.status}: ${body.slice(0, 300)}`);
  }
}

function crisisResponse() {
  return {
    metadata: { prompt_version: PROMPT_VERSION },
    crisis_flag: true,
    crisis_response: { reason: 'crisis_language_detected', frontend_action: 'show_safety_resources', map_generated: false },
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_KEY || !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  // --- coach authentication (required; caller is the coach) ---
  const coachEmail = await deriveCoachEmail(req);
  if (!coachEmail) return res.status(401).json({ error: 'UNAUTHORIZED' });

  // --- GATE 1a: coach exists + active paid subscription ---
  const coach = await loadCoach(coachEmail);
  if (!coach) return res.status(403).json({ error: 'ACCESS_DENIED', reason: 'coach_not_found' });
  if (coach.subscription_status !== 'active') {
    return res.status(403).json({ error: 'ACCESS_DENIED', reason: 'subscription_inactive' });
  }

  // --- input validation (400; distinct from access denial) ---
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const goal = body.goal ? String(body.goal).trim() : '';
  const phase = body.phase ? String(body.phase).trim() : '';
  const sessionId = body.session_id ? String(body.session_id).trim() : '';
  const clientEmailRaw = body.client_email ? String(body.client_email).trim() : '';
  const explorerId = body.explorer_id ? String(body.explorer_id).trim() : null;
  const rawContext = body.product_context ? String(body.product_context).trim().toLowerCase() : '';
  const productContext = PRODUCT_CONTEXTS.includes(rawContext) ? rawContext : 'coaching';
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};

  if (!goal) return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: 'goal' });
  if (!PHASES.includes(phase)) return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: 'phase' });
  if (!sessionId) return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: 'session_id' });
  if (!clientEmailRaw) return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: 'client_email' });
  for (const k of ANSWER_KEYS) {
    if (!answers[k] || !String(answers[k]).trim()) {
      return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: `answers.${k}` });
    }
  }
  const clientEmail = clientEmailRaw.toLowerCase();

  try {
    // --- GATE 1b: client_email is an active connection of this coach ---
    const connected = await isActiveConnection(coach.id, clientEmail);
    if (!connected) return res.status(403).json({ error: 'ACCESS_DENIED', reason: 'client_not_connected' });

    // --- idempotency: one Map per session_id. Returning an existing Map is a read,
    //     not a generation — it precedes the monthly gate and never re-spends. ---
    const existing = await getExisting(sessionId);
    if (existing) {
      if (existing.crisis_flag) return res.status(200).json(crisisResponse());
      return res.status(200).json({ status: 'ok', session_id: sessionId, reused: true, map: existing.raw_output });
    }

    // --- GATE 2: monthly Map limit for this coach's tier ---
    const tier = coach.subscription_tier ? String(coach.subscription_tier).toLowerCase() : '';
    const limit = Object.prototype.hasOwnProperty.call(TIER_LIMITS, tier) ? TIER_LIMITS[tier] : DEFAULT_TIER_LIMIT;
    const used = await monthlyMapCount(coach.id);
    if (used === null) {
      // Count unavailable: fail open so a paying coach is not blocked by a telemetry
      // glitch (limit is a business guardrail, not a security boundary). Logged loudly.
      console.error(`[effectiveness-map] monthly count unavailable for coach ${coach.id}; allowing`);
    } else if (used >= limit) {
      return res.status(403).json({ error: 'MONTHLY_LIMIT_EXCEEDED', tier: tier || null, limit, used });
    }

    // --- synthesis (jsonrepair rescue + one retry); total failure -> 200 + status:'failed' ---
    let map = null;
    for (let attempt = 0; attempt < 2 && !map; attempt++) {
      let raw;
      try {
        raw = await callClaude(buildUserMessage({ goal, phase, answers }));
      } catch (err) {
        if (attempt === 1) {
          console.error('[effectiveness-map] synthesis error:', err && err.message);
          return res.status(200).json({ status: 'failed', error_code: 'SYNTHESIS_FAILURE', session_id: sessionId });
        }
        continue;
      }
      map = parseMap(raw);
      if (!map && attempt === 1) {
        console.error('[effectiveness-map] parse failure after retry');
        return res.status(200).json({ status: 'failed', error_code: 'SYNTHESIS_PARSE_FAILURE', session_id: sessionId });
      }
    }
    if (!map) {
      return res.status(200).json({ status: 'failed', error_code: 'SYNTHESIS_FAILURE', session_id: sessionId });
    }

    // --- crisis gate: minimal row (no goal/phase/client_email/narratives), exempt
    //     from the monthly limit (monthlyMapCount filters crisis_flag=false);
    //     return crisis object only ---
    if (map.crisis_flag === true) {
      const crisisRow = {
        session_id: sessionId,
        coach_id: coach.id,
        explorer_id: explorerId,
        client_email: null,
        goal: null,
        phase: null,
        prompt_version: (map.metadata && map.metadata.prompt_version) || PROMPT_VERSION,
        crisis_flag: true,
        dominant_pattern_label: null,
        overall_evidence_strength: null,
        raw_output: map, // crisis JSON is content-free (flags only)
        explorer_facing_output: null,
        answers: null, // crisis rows stay content-free — never store answers
        product_context: productContext,
      };
      try { await storeRow(crisisRow); }
      catch (e) { console.error('[effectiveness-map] crisis MAP_STORAGE_FAILURE:', e && e.message); }
      console.warn(`[effectiveness-map] crisis_flag session_id=${sessionId} coach=${coach.id}`); // no content
      return res.status(200).json(crisisResponse());
    }

    // --- validation gates (warn-only; never reject a generated Map) ---
    const reportedVersion = map.metadata && map.metadata.prompt_version;
    if (reportedVersion && reportedVersion !== PROMPT_VERSION) {
      console.warn(`[effectiveness-map] prompt_version drift: got ${reportedVersion}, loaded ${PROMPT_VERSION} (session ${sessionId})`);
    }
    const overallStrength = (map.output_length_check && map.output_length_check.overall_evidence_strength) || null;
    const words = wordCount(map);
    if (words > 1400) {
      console.warn(`[effectiveness-map] word count ${words} > 1400 (session ${sessionId})`);
    }
    if (words < 200 && overallStrength && overallStrength !== 'thin') {
      console.warn(`[effectiveness-map] thin output (${words} words) but evidence='${overallStrength}' (session ${sessionId})`);
    }

    const coachFacing = (map.coach_facing && typeof map.coach_facing === 'object') ? map.coach_facing : {};
    const row = {
      session_id: sessionId,
      coach_id: coach.id,
      explorer_id: explorerId,
      client_email: clientEmail,
      goal,
      phase,
      prompt_version: reportedVersion || PROMPT_VERSION,
      crisis_flag: false,
      dominant_pattern_label: (coachFacing.dominant_pattern && coachFacing.dominant_pattern.label) || null,
      overall_evidence_strength: overallStrength,
      raw_output: map,
      explorer_facing_output: collectExplorerFacing(map),
      // v1.6 brief: preserve the raw intake answers on the Map row (non-crisis only)
      // so a Map's claims can always be audited against what was actually submitted.
      // Only the ten canonical keys — never arbitrary body content.
      answers: Object.fromEntries(ANSWER_KEYS.map((k) => [k, String(answers[k])])),
      product_context: productContext,
    };

    // Storage failure must not lose the Map: still return it, log the failure.
    try {
      await storeRow(row);
    } catch (e) {
      console.error('[effectiveness-map] MAP_STORAGE_FAILURE:', e && e.message);
      return res.status(200).json({ status: 'ok', session_id: sessionId, stored: false, map });
    }

    return res.status(200).json({ status: 'ok', session_id: sessionId, stored: true, map });
  } catch (err) {
    console.error('[effectiveness-map] unexpected:', err && err.message);
    return res.status(200).json({ status: 'failed', error_code: 'SYNTHESIS_FAILURE', session_id: sessionId });
  }
}
