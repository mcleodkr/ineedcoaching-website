// Server-side endpoint for the daily check-in (mood / one_word / pattern_response).
//
// Replaces the direct client-to-Supabase insert that used to live in
// client-dashboard.html. Ordering is non-negotiable and mirrors the
// Effectiveness Map crisis pattern (api/generate-effectiveness-map.js):
//
//   1. INSERT the explorer_checkins row first. The insert must succeed and
//      commit before anything else — a check-in is never lost. If the insert
//      itself fails we return a non-200 so the client retries; nothing else runs.
//   2. THEN screen pattern_response for crisis language (additive). The screen
//      can only ADD a resources prompt; it can never block or lose a check-in.
//   3. Return { ok:true, crisis:<bool> }. Any screen error/timeout -> crisis:false.
//
// Privacy: crisis handling is content-free beyond the boolean flag. The screen's
// reasoning is never stored, and pattern_response is never logged anywhere.

import { logAIUsage } from '../lib/ai-usage.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 50;
// Tight bound: a 50-token boolean screen is fast. If it runs long we abort and
// treat it as crisis:false so the already-saved check-in is never delayed.
const SCREEN_TIMEOUT_MS = 10000;

// Kim-approved verbatim crisis-detection instruction. This is safety language —
// do not edit without her sign-off. The same bypass set (urgent safety / self-harm
// / harm-to-others / genuine inability to function) is referenced by the synthesis
// prompt in ticket 2; they must stay consistent.
const SCREEN_INSTRUCTION =
  'You are a safety screen. Read only the reflection text below, written by a ' +
  'coaching client in a daily check-in. Decide whether it contains any of: ' +
  '(1) urgent safety language or suicidal intent, (2) self-harm language, ' +
  '(3) intent to harm others, or (4) a genuine inability to function, meaning ' +
  'the person cannot carry out basic daily functioning such as getting out of bed ' +
  'or caring for themselves or their dependents. Ordinary hard weeks, stress, ' +
  'sadness, frustration, exhaustion, low energy, or venting are NOT a crisis. ' +
  'Only a true inability to function qualifies under (4), not ordinary depletion ' +
  'or tiredness. When genuinely uncertain whether something rises to crisis, flag ' +
  'it. Respond with ONLY this JSON and nothing else: {"crisis": true} or ' +
  '{"crisis": false}.';

function sbHeaders(extra) {
  return Object.assign(
    {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    extra || {}
  );
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// Caller email from the verified JWT — never from the body. Preserves the
// per-user scoping the old direct insert got from RLS (the client used to send
// its own auth token): a client can only write their own check-in.
async function deriveUserEmail(req) {
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

function strOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// Insert the check-in. Returns true on commit, false on any failure. Never throws.
async function insertCheckin(row) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/explorer_checkins`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      // Status only — never echo the row content into logs.
      console.error(`[submit-daily-checkin] insert failed ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[submit-daily-checkin] insert error:', e && e.message);
    return false;
  }
}

// Crisis screen. Returns boolean. NEVER throws — any error/timeout -> false.
// The reflection text is screened in-memory and never persisted or logged.
async function screenForCrisis(patternResponse, coachId) {
  const text = strOrNull(patternResponse);
  if (!text) return false; // nothing to screen
  if (!process.env.ANTHROPIC_API_KEY) return false;

  const startTime = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCREEN_TIMEOUT_MS);
  let res, data;
  try {
    const userMessage = SCREEN_INSTRUCTION + '\n\nReflection text: """' + text + '"""';
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
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    const timedOut = controller.signal.aborted;
    // Telemetry only — feature flag, no reflection content. Awaited (non-fatal)
    // so the row lands before the serverless function returns.
    await logAIUsage({
      coachId: coachId || null,
      feature: 'checkin_safety_screen',
      model: MODEL,
      status: timedOut ? 'timeout' : 'error',
      errorMessage: err && err.message,
      durationMs: Date.now() - startTime,
    }).catch(() => {});
    return false;
  } finally {
    clearTimeout(timer);
  }

  await logAIUsage({
    coachId: coachId || null,
    feature: 'checkin_safety_screen',
    model: (data && data.model) || MODEL,
    usage: data && data.usage,
    requestId: data && data.id,
    status: res.ok ? 'success' : 'error',
    errorMessage: res.ok ? null : (data && data.error && data.error.message),
    durationMs: Date.now() - startTime,
  }).catch(() => {});

  if (!res.ok) return false;
  const out = data && data.content && data.content[0] && data.content[0].text;
  if (!out) return false;
  // Parse the single boolean flag. Never store the model's reasoning — flag only.
  try {
    const match = String(out).match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : null;
    return parsed && parsed.crisis === true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!SUPABASE_KEY) {
    console.error('[submit-daily-checkin] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  // Authenticated caller only — the row is stamped with the verified email,
  // never with a client-supplied user_email (which is ignored).
  const userEmail = await deriveUserEmail(req);
  if (!userEmail) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const mood = strOrNull(body.mood);
  // Mirror the client's own validation: mood is required to start a check-in.
  if (!mood) {
    return res.status(400).json({ ok: false, error: 'Missing mood' });
  }

  const patternResponse = strOrNull(body.pattern_response);
  const row = {
    user_email: userEmail,
    mood: mood,
    one_word: strOrNull(body.one_word),
    pattern_response: patternResponse,
    pattern_referenced: strOrNull(body.pattern_referenced),
    coach_id: strOrNull(body.coach_id),
    created_at: strOrNull(body.created_at) || new Date().toISOString(),
  };

  // 1. Insert first. A failed insert means the check-in did not save — tell the
  //    client so it retries. Nothing else runs until the row is committed.
  const saved = await insertCheckin(row);
  if (!saved) {
    return res.status(502).json({ ok: false, error: 'Could not save check-in' });
  }

  // 2. Screen (additive). Self-contained: never throws, never delays beyond the
  //    abort bound, returns false on any failure. The insert is already committed.
  let crisis = false;
  try {
    crisis = await screenForCrisis(patternResponse, row.coach_id);
  } catch {
    crisis = false; // belt-and-suspenders: the check-in is saved regardless
  }

  if (crisis) {
    // Flag only — no reflection content in the log.
    console.warn('[submit-daily-checkin] crisis flag raised');
  }

  // 3. Always ok:true here — the check-in is saved. crisis only adds resources.
  return res.status(200).json({ ok: true, crisis });
}
