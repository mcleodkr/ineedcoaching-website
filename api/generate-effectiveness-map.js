// api/generate-effectiveness-map.js
//
// Effectiveness Map synthesis (P.I.P.E.S.). Read-only intelligence endpoint:
//   POST { goal, phase, answers{10}, explorer_id?, session_id, product_context? }
//   product_context: 'coaching' (default — ineedcoaching) | 'therapy' (Sprixle);
//   any other/absent value normalizes to 'coaching'. client_email is derived from
//   the verified JWT, never the body.
// Runs the v1.5 synthesis prompt through Claude and returns the structured Map
// JSON, storing it in effectiveness_maps. Never writes elsewhere, never emails,
// never triggers a downstream action.
//
// Conventions copied from generate-coaching-strategy.js: the (deterministic)
// system prompt is wrapped in a 1h ephemeral cache block so its prefix is cached
// across calls; jsonrepair rescues near-miss JSON; logAIUsage records spend.
// Supabase via REST + service-role key (qroizygknxdjsstkezsf), matching
// coach-mirror.js / generate-coach-dna.js.
//
// Decisions locked with the framework owner (2026-06-09):
//   - Crisis  -> store a MINIMAL row (no goal/answers/narratives, no client_email);
//               return the crisis object only.
//   - Failure -> 200 + { status: 'failed', error_code } (house style), never 500.
//   - Identity -> hybrid: explorer_id (anonymous/self) + client_email (derived from
//                the client JWT, never the body; powers coach-read RLS).

import { createRequire } from 'module';
import { logAIUsage } from '../lib/ai-usage.js';
import { jsonrepair } from 'jsonrepair';

const require = createRequire(import.meta.url);
const SYNTH = require('./prompts/effectiveness-map-synthesis-v1.5.json');
const SYNTHESIS_PROMPT = SYNTH.prompt;
const PROMPT_VERSION = SYNTH.version; // '1.5'

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

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json' };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// Explorer-facing narrative payload — extracted to explorer_facing_output, and the
// source of truth for the word-count gate. Excludes coach-only analytics
// (dominant_pattern, phase_discrepancy, lead_domains), which live in raw_output.
function collectExplorerFacing(map) {
  const out = {};
  if (map.domain_statuses && typeof map.domain_statuses === 'object') {
    out.domain_statuses = {};
    for (const [domain, d] of Object.entries(map.domain_statuses)) {
      if (!d || typeof d !== 'object') continue;
      out.domain_statuses[domain] = {
        primary_status: d.primary_status ?? null,
        secondary_status: d.secondary_status ?? null,
        one_line_read: d.one_line_read ?? null,
        snapshot_paragraph: d.snapshot_paragraph ?? null,
      };
    }
  }
  out.system_picture = map.system_picture ?? null;
  out.cross_domain_tax = map.cross_domain_tax ?? null;
  out.release_question = map.release_question ?? null;
  return out;
}

function wordCount(map) {
  const parts = [];
  if (map.domain_statuses && typeof map.domain_statuses === 'object') {
    for (const d of Object.values(map.domain_statuses)) {
      if (d && d.snapshot_paragraph) parts.push(d.snapshot_paragraph);
    }
  }
  if (map.system_picture && map.system_picture.narrative) parts.push(map.system_picture.narrative);
  if (map.cross_domain_tax && map.cross_domain_tax.narrative) parts.push(map.cross_domain_tax.narrative);
  if (map.release_question && map.release_question.question) parts.push(map.release_question.question);
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

// client_email comes ONLY from the verified JWT (like connect-coach.js), never the
// body. Returns null for anonymous explorers or an unverifiable token — generation
// still proceeds; the row is simply not coach-visible.
async function deriveClientEmail(req) {
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

// Parse the Map JSON. Strips an accidental ```json fence, then JSON.parse, then
// jsonrepair as a last rescue. Returns null if unrecoverable.
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
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
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

  // --- input validation (400 on bad input; distinct from synthesis failure) ---
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const goal = body.goal ? String(body.goal).trim() : '';
  const phase = body.phase ? String(body.phase).trim() : '';
  const sessionId = body.session_id ? String(body.session_id).trim() : '';
  const explorerId = body.explorer_id ? String(body.explorer_id).trim() : null;
  const rawContext = body.product_context ? String(body.product_context).trim().toLowerCase() : '';
  const productContext = PRODUCT_CONTEXTS.includes(rawContext) ? rawContext : 'coaching';
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};

  if (!goal) return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: 'goal' });
  if (!PHASES.includes(phase)) return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: 'phase' });
  if (!sessionId) return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: 'session_id' });
  for (const k of ANSWER_KEYS) {
    if (!answers[k] || !String(answers[k]).trim()) {
      return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: `answers.${k}` });
    }
  }

  try {
    // --- idempotency: one Map per session_id (unique). Re-submission returns the
    //     stored result with no Claude re-spend. ---
    const existing = await getExisting(sessionId);
    if (existing) {
      if (existing.crisis_flag) return res.status(200).json(crisisResponse());
      return res.status(200).json({ status: 'ok', session_id: sessionId, reused: true, map: existing.raw_output });
    }

    const clientEmail = await deriveClientEmail(req); // null when anonymous / unverifiable

    // --- synthesis with jsonrepair rescue + one retry; total failure -> 200 + status:'failed' ---
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

    // --- crisis gate: minimal row, no content/identity; return crisis object only ---
    if (map.crisis_flag === true) {
      const crisisRow = {
        session_id: sessionId,
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
        product_context: productContext,
      };
      try { await storeRow(crisisRow); }
      catch (e) { console.error('[effectiveness-map] crisis MAP_STORAGE_FAILURE:', e && e.message); }
      console.warn(`[effectiveness-map] crisis_flag session_id=${sessionId}`); // session_id only, no content
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

    const row = {
      session_id: sessionId,
      explorer_id: explorerId,
      client_email: clientEmail,
      goal,
      phase,
      prompt_version: reportedVersion || PROMPT_VERSION,
      crisis_flag: false,
      dominant_pattern_label: (map.dominant_pattern && map.dominant_pattern.label) || null,
      overall_evidence_strength: overallStrength,
      raw_output: map,
      explorer_facing_output: collectExplorerFacing(map),
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
