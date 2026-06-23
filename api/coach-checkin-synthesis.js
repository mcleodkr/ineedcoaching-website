// api/coach-checkin-synthesis.js
//
// Coach Clarity — check-in synthesis. A real AI read of one client's
// between-session check-ins (explorer_checkins), coach-side only. Coaching
// context: never clinical/therapy/diagnostic language, never a named modality.
//
//   GET  ?client_email=<email>           Authorization: Bearer <coach JWT>
//        Read-only. Returns the cached synthesis instantly (no Claude call) plus
//        the staleness signal so the panel can render immediately.
//   POST { client_email, force? }         Authorization: Bearer <coach JWT>
//        Generates (or returns a still-fresh cache). force=true always regenerates.
//
// Ownership: the caller's coach identity comes from the verified JWT. Synthesis is
// built ONLY over explorer_checkins rows whose coach_id matches this coach's
// coach_profiles.id — a coach can never read another coach's client data, and
// legacy rows with a null coach_id are excluded by design.
//
// Caching (per coach_id + client_email, like the Supervision Snapshot):
//   coach_checkin_synthesis stores the synthesis JSON, the count of check-ins it
//   was built from (14-day window), and generated_at. Regeneration happens only
//   when a new check-in has arrived (current window count > stored count) or the
//   coach forces a Refresh. Cost lands in coach_ai_usage_log (feature
//   'checkin_synthesis') via logAIUsage, like every other AI call.
//
// Pattern conventions copied from generate-effectiveness-map.js: coach JWT →
// /auth/v1/user → coach_profiles; system prompt in a 1h ephemeral cache block;
// jsonrepair rescues near-miss JSON; Supabase via REST + service-role key.

import { logAIUsage } from '../lib/ai-usage.js';
import { jsonrepair } from 'jsonrepair';

const MODEL = 'claude-sonnet-4-6';
// The output is three short lenses plus one question — small. 800 is ample.
const MAX_TOKENS = 800;
// Abort well inside Vercel's limit; this call is small so a clean failure beats a
// raw timeout. No retry budget concern at this size.
const CLAUDE_TIMEOUT_MS = 60000;
const WINDOW_DAYS = 14;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// VERBATIM synthesis system prompt (clinical-gate approved). Do not reword.
const SYSTEM_PROMPT = `You are Coach Clarity, generating a check-in synthesis for a coach reviewing a client's between-session check-ins. This is a coaching context, never therapy. You never use clinical, diagnostic, or therapy language. You never name any therapeutic modality.

You produce exactly three lenses and one question, returned as JSON:
{
  "pattern_noticed": "...",
  "possible_connection": "...",
  "coaching_direction": "...",
  "session_question": "..."
}

Rules for every lens:
- Lead with one plain declarative sentence a coach could say out loud. State it plainly. Do not open with abstract or writerly framing.
- Then support it with the client's own words (their one-words and reflections), quoted briefly.
- Write in coaching language. Never use the words good, bad, right, wrong, should, must, mistake, or failure. Speak in terms of what is effective, what is draining or resourcing energy, what is serving the client, what they are reaching for or accomplishing.

pattern_noticed: The single clearest thing in this client's check-ins that the coach might otherwise miss. Distinguish effort from state: words like "stay encouraged," "keep pushing," "focused," "hang in there" are instructions a person gives themselves, not descriptions of how they feel. Name that plainly when you see it.

possible_connection: Read the check-ins through the P.I.P.E.S. domains (Physical, Intellectual, Psychological, Environmental, Social) as a lens, not a checklist. When two domains move together, name the connection in plain words (for example, a physical signal like disrupted sleep moving alongside a psychological signal like a heavier mood). If only one domain is present, say what is recurring instead. Never list domains that are not present. Never output empty domain headers.

coaching_direction: One thing worth exploring in session, framed as exploration, not advice or homework. No instructions to the client.

session_question: One open question, generated from THIS client's actual words and patterns, that the coach could use to open the next session. Never a generic or reusable question. It must reference something specific from these check-ins.

Keep each lens to two or three sentences. Be plain and direct. If the check-in data is thin (one or two entries), say so honestly and keep the synthesis brief rather than over-reading.`;

const SYNTHESIS_FIELDS = ['pattern_noticed', 'possible_connection', 'coaching_direction', 'session_question'];

function sbHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'content-type': 'application/json', ...(extra || {}) };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// Caller (coach) email from the verified JWT — never from the body/query.
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

async function loadCoachId(coachEmail) {
  const url = `${SUPABASE_URL}/rest/v1/coach_profiles`
    + `?user_email=ilike.${encodeURIComponent(coachEmail)}&select=id&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows.length ? rows[0].id : null;
}

// Coach-owned check-ins for this client in the 14-day window, oldest first.
// The coach_id filter is the ownership gate: only this coach's rows are ever read.
async function fetchOwnedWindowRows(coachId, clientEmail) {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/explorer_checkins`
    + `?user_email=ilike.${encodeURIComponent(clientEmail)}`
    + `&coach_id=eq.${encodeURIComponent(coachId)}`
    + `&created_at=gte.${encodeURIComponent(cutoff)}`
    + `&order=created_at.asc`
    + `&select=mood,one_word,pattern_response,pattern_referenced,created_at`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`checkins read ${r.status}`);
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) ? rows : [];
}

async function loadCache(coachId, clientEmail) {
  const url = `${SUPABASE_URL}/rest/v1/coach_checkin_synthesis`
    + `?coach_id=eq.${encodeURIComponent(coachId)}`
    + `&client_email=ilike.${encodeURIComponent(clientEmail)}`
    + `&select=synthesis,source_count,generated_at,model&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function upsertCache(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/coach_checkin_synthesis?on_conflict=coach_id,client_email`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`cache upsert ${r.status}: ${body.slice(0, 200)}`);
  }
}

function buildUserMessage(rows) {
  const fmtDate = (s) => {
    try { return new Date(s).toISOString().slice(0, 10); } catch { return ''; }
  };
  const lines = rows.map((r) => {
    const parts = [`[${fmtDate(r.created_at)}] mood: ${r.mood || '(none)'} | one-word: ${r.one_word || '(none)'}`];
    if (r.pattern_referenced && String(r.pattern_referenced).trim()) {
      parts.push(`Prompt: ${String(r.pattern_referenced).trim()}`);
    }
    if (r.pattern_response && String(r.pattern_response).trim()) {
      parts.push(`Reflection: ${String(r.pattern_response).trim()}`);
    }
    return parts.join('\n');
  });
  return `This client's between-session check-ins over the last ${WINDOW_DAYS} days, oldest first (${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}). Mood values map heavy/exhausted=lowest through thriving=highest.\n\n${lines.join('\n\n')}`;
}

function parseSynthesis(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch { /* fall through */ }
  if (!obj) { try { obj = JSON.parse(jsonrepair(t)); } catch { /* fall through */ } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const k of SYNTHESIS_FIELDS) {
    if (!obj[k] || !String(obj[k]).trim()) return null; // all four fields required
    out[k] = String(obj[k]).trim();
  }
  return out;
}

async function callClaude(userMessage, coachId) {
  const startTime = Date.now();
  const systemPayload = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
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
      signal: controller.signal,
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    const timedOut = controller.signal.aborted;
    await logAIUsage({ coachId, feature: 'checkin_synthesis', model: MODEL, status: timedOut ? 'timeout' : 'error', errorMessage: err && err.message, durationMs: Date.now() - startTime });
    throw err;
  } finally {
    clearTimeout(timer);
  }
  await logAIUsage({
    coachId,
    feature: 'checkin_synthesis',
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SUPABASE_KEY || !process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const coachEmail = await deriveCoachEmail(req);
  if (!coachEmail) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const coachId = await loadCoachId(coachEmail);
  if (!coachId) return res.status(403).json({ error: 'ACCESS_DENIED', reason: 'coach_not_found' });

  const body = req.method === 'POST' ? (typeof req.body === 'string' ? safeJson(req.body) : (req.body || {})) : {};
  const clientEmailRaw = req.method === 'POST'
    ? (body.client_email ? String(body.client_email).trim() : '')
    : (req.query && req.query.client_email ? String(req.query.client_email).trim() : '');
  if (!clientEmailRaw) return res.status(400).json({ error: 'MISSING_REQUIRED_FIELD', field: 'client_email' });
  const clientEmail = clientEmailRaw;

  try {
    const rows = await fetchOwnedWindowRows(coachId, clientEmail);
    const currentCount = rows.length;
    const cache = await loadCache(coachId, clientEmail);
    const storedCount = cache ? Number(cache.source_count || 0) : null;

    // ---- READ MODE: instant, no Claude call ----
    if (req.method === 'GET') {
      const stale = cache ? currentCount > storedCount : currentCount > 0;
      return res.status(200).json({
        status: 'ok',
        synthesis: cache ? cache.synthesis : null,
        source_count: storedCount,
        current_count: currentCount,
        stale,
        generated_at: cache ? cache.generated_at : null,
      });
    }

    // ---- GENERATE MODE ----
    const force = !!body.force;

    // Nothing this coach owns in the window — never call Claude, never 403-leak.
    if (currentCount === 0) {
      return res.status(200).json({ status: 'ok', synthesis: null, source_count: storedCount, current_count: 0, message: 'no_checkins' });
    }

    // Cost guard: a still-fresh cache is reused unless the coach forced a refresh.
    if (!force && cache && storedCount >= currentCount) {
      return res.status(200).json({ status: 'ok', synthesis: cache.synthesis, source_count: storedCount, current_count: currentCount, stale: false, generated_at: cache.generated_at, reused: true });
    }

    let synthesis = null;
    try {
      const raw = await callClaude(buildUserMessage(rows), coachId);
      synthesis = parseSynthesis(raw);
    } catch (err) {
      console.error('[checkin-synthesis] generation error:', err && err.message);
    }

    // Failure must never clobber a good cached synthesis.
    if (!synthesis) {
      if (cache) {
        return res.status(200).json({ status: 'stale', synthesis: cache.synthesis, source_count: storedCount, current_count: currentCount, generated_at: cache.generated_at, error_code: 'SYNTHESIS_FAILURE' });
      }
      return res.status(200).json({ status: 'failed', synthesis: null, current_count: currentCount, error_code: 'SYNTHESIS_FAILURE' });
    }

    const generatedAt = new Date().toISOString();
    try {
      await upsertCache({ coach_id: coachId, client_email: clientEmail, synthesis, source_count: currentCount, model: MODEL, generated_at: generatedAt });
    } catch (e) {
      // Storage failure must not lose the synthesis: return it, log the failure.
      console.error('[checkin-synthesis] cache upsert failed:', e && e.message);
      return res.status(200).json({ status: 'ok', synthesis, source_count: currentCount, current_count: currentCount, generated_at: generatedAt, stored: false });
    }
    return res.status(200).json({ status: 'ok', synthesis, source_count: currentCount, current_count: currentCount, generated_at: generatedAt, stored: true, regenerated: true });
  } catch (err) {
    console.error('[checkin-synthesis] unexpected:', err && err.message);
    return res.status(200).json({ status: 'failed', synthesis: null, error_code: 'UNEXPECTED' });
  }
}
