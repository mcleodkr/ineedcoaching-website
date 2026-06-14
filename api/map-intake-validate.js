// POST /api/map-intake-validate — validate a signed Effectiveness Map intake
// link on page load (brief v1.1, Step 2). No Supabase auth: a valid
// MAP_LINK_SECRET HMAC token IS the authorization. Service-role only; the
// explorer never authenticates.
//
// Body: { token }  — the signed link from /map/intake?token=...
//
// Flow:
//   1. verifyMapLink(token) — HMAC + expiry; bad/tampered/expired → generic invalid.
//   2. Look up the effectiveness_map_assignments row by session_id (service role).
//   3. status='completed' → { ok:true, status:'completed' } so the page routes to
//      results (works even past expiry — a finished Map is always viewable).
//   4. Past expires_at → flip status='expired' (the "expire on next load" rule), invalid.
//   5. status='expired' → generic invalid.
//   6. pending|in_progress → flip pending→in_progress (idempotent), return the saved
//      draft (answers, current_screen) so the explorer resumes where they left off,
//      plus goal: the coach's carried-forward goal (Map re-take) or null. When set,
//      the intake pre-fills it read-only and skips goal entry.
//
// Never leaks why a link failed (one generic message), and never returns coach_id
// or client_email to the browser — the token already carries them; the server
// re-derives them on every call (e.g. the submit handler in Step 3).

import { verifyMapLink } from '../lib/map-link.js';

const INACTIVE_MSG = 'This link is no longer active. Ask your coach to send a new one.';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY || !process.env.MAP_LINK_SECRET) {
    console.error('[map-intake-validate] server not configured');
    return res.status(500).json({ ok: false, error: INACTIVE_MSG });
  }

  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const READ_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const token = typeof body.token === 'string' ? body.token : '';

    // 1. Cryptographic gate — runs before any DB read.
    const decoded = verifyMapLink(token);
    if (!decoded) return res.status(200).json({ ok: false, error: INACTIVE_MSG });
    const sessionId = decoded.sessionId;

    // 2. Assignment row by session_id (goal: a carried-forward goal on a Map re-take).
    const aRes = await fetch(
      `${SUPABASE_URL}/rest/v1/effectiveness_map_assignments?session_id=eq.${encodeURIComponent(sessionId)}&select=status,expires_at,goal&limit=1`,
      { headers: READ_HEADERS }
    );
    const aRows = await aRes.json().catch(() => []);
    const assignment = Array.isArray(aRows) ? aRows[0] : null;
    if (!assignment) return res.status(200).json({ ok: false, error: INACTIVE_MSG });

    // 3. Completed → always routable to results, even past expiry.
    if (assignment.status === 'completed') {
      return res.status(200).json({ ok: true, status: 'completed' });
    }

    // 4. Past expiry → expire on load, then treat as inactive.
    const expMs = new Date(assignment.expires_at).getTime();
    if (Number.isFinite(expMs) && Date.now() > expMs) {
      if (assignment.status !== 'expired') {
        await patchStatus(SUPABASE_URL, SB_HEADERS, sessionId, 'expired');
      }
      return res.status(200).json({ ok: false, error: INACTIVE_MSG });
    }

    // 5. Explicitly expired status → inactive.
    if (assignment.status === 'expired') {
      return res.status(200).json({ ok: false, error: INACTIVE_MSG });
    }

    // 6. pending | in_progress → mark in_progress (only flip pending) + return any draft.
    if (assignment.status === 'pending') {
      await patchStatus(SUPABASE_URL, SB_HEADERS, sessionId, 'in_progress');
    }

    const dRes = await fetch(
      `${SUPABASE_URL}/rest/v1/effectiveness_map_drafts?session_id=eq.${encodeURIComponent(sessionId)}&select=answers,current_screen&limit=1`,
      { headers: READ_HEADERS }
    );
    const dRows = await dRes.json().catch(() => []);
    const draftRow = Array.isArray(dRows) ? dRows[0] : null;
    const draft = draftRow
      ? { answers: draftRow.answers || {}, current_screen: draftRow.current_screen || 0 }
      : null;

    // goal (when set) is the coach's carried-forward goal — the intake pre-fills it
    // read-only and skips goal entry. null → the client names the goal (default flow).
    const carriedGoal = assignment.goal != null && String(assignment.goal).trim() !== ''
      ? String(assignment.goal)
      : null;

    return res.status(200).json({ ok: true, status: 'in_progress', draft, goal: carriedGoal });
  } catch (e) {
    console.error('[map-intake-validate] error', e && e.message);
    return res.status(500).json({ ok: false, error: INACTIVE_MSG });
  }
}

async function patchStatus(supabaseUrl, headers, sessionId, status) {
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/effectiveness_map_assignments?session_id=eq.${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', headers, body: JSON.stringify({ status }) }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[map-intake-validate] status patch failed', r.status, t.slice(0, 200));
    }
  } catch (err) {
    console.error('[map-intake-validate] status patch threw', err && err.message);
  }
}
