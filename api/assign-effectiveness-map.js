// api/assign-effectiveness-map.js
//
// POST /api/assign-effectiveness-map — coach-initiated Effectiveness Map intake
// assignment (Step 6). The coach's Supabase JWT is the authorization. Three
// actions on one client's assignment, all service-role (the assignments table is
// coach-readable but write-locked by RLS):
//
//   action:'create' (default) — full gates (active subscription, active
//       coach_clients connection, monthly Map limit), then a new 'pending'
//       assignment row + a signed 14-day HMAC intake link. Optional body.goal
//       carries a prior goal forward (a Map re-take): stored on the row so the
//       intake pre-fills it and the new Map files under the same goal. Absent →
//       the client names a brand-new goal (unchanged behavior).
//   action:'resend'           — re-mint the SAME link for an existing active
//       assignment (same session_id + expiry → identical token). No new row, no
//       limit charge. Requires the coach own the row + an active connection.
//   action:'cancel'           — flip an existing active assignment to 'expired'
//       (kills the link). Requires only that the coach own the row.
//
// Body: { client_email, action?, session_id?, goal? }   (session_id: resend/cancel; goal: optional carry-forward on create)
// Returns (create/resend): { ok:true, link, session_id, status, expires_at, assigned_at? }
//          (cancel):        { ok:true, session_id, status:'expired' }
//          (error):         { ok:false, error, code? }

import { randomUUID } from 'crypto';
import { signMapLink } from '../lib/effmap-core/map-link.js';
import { limitForTier, monthlyMapCount } from '../lib/effmap-core/effmap-limits.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Pinned canonical host for the link (apex 308-redirects to www and would strip
// the token's usefulness in some clients). Overridable via SITE_URL. Same house
// convention as api/map-intake-submit.js.
const SITE_ORIGIN = process.env.SITE_URL || 'https://www.ineedcoaching.org';
const INTAKE_PATH = '/map/intake';
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000; // 14-day window (brief)

const FAIL_MSG = 'Could not create the assignment. Please try again.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;
const GOAL_MAX = 1000; // a carried-forward goal is a real goal sentence; cap defensively
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sbHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// --- coach identity from the JWT (never trusted from the body) ---
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

// ilike for case-insensitive match, but ILIKE treats %/_ as wildcards — guard
// with a JS exact match so a wildcard email can't resolve to another coach.
async function loadCoach(coachEmail) {
  const url = `${SUPABASE_URL}/rest/v1/coach_profiles`
    + `?user_email=ilike.${encodeURIComponent(coachEmail)}`
    + `&select=id,user_email,subscription_status,subscription_tier&limit=5`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row && row.user_email && String(row.user_email).toLowerCase() === coachEmail) || null;
}

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

// One assignment row owned by this coach for this client+session, or null.
async function loadOwnedAssignment(coachId, clientEmail, sessionId) {
  const url = `${SUPABASE_URL}/rest/v1/effectiveness_map_assignments`
    + `?coach_id=eq.${encodeURIComponent(coachId)}`
    + `&session_id=eq.${encodeURIComponent(sessionId)}`
    + `&client_email=eq.${encodeURIComponent(clientEmail)}`
    + `&select=session_id,status,expires_at,assigned_at&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function intakeLink(coachId, clientEmail, sessionId, expiresAtMs) {
  const token = signMapLink({ coachId, clientEmail, sessionId, expiresAt: expiresAtMs });
  return `${SITE_ORIGIN}${INTAKE_PATH}?token=${encodeURIComponent(token)}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!SUPABASE_KEY || !process.env.MAP_LINK_SECRET) {
    console.error('[assign-effectiveness-map] server not configured');
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }

  try {
    // --- coach auth ---
    const coachEmail = await deriveCoachEmail(req);
    if (!coachEmail) return res.status(401).json({ ok: false, error: 'Please sign in again.', code: 'UNAUTHORIZED' });
    const coach = await loadCoach(coachEmail);
    if (!coach) return res.status(403).json({ ok: false, error: 'Coach profile not found.', code: 'ACCESS_DENIED' });

    // --- input ---
    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    const action = body && body.action ? String(body.action).toLowerCase() : 'create';
    const clientEmail = body && body.client_email ? String(body.client_email).trim().toLowerCase() : '';
    if (!clientEmail || clientEmail.length > EMAIL_MAX || !EMAIL_RE.test(clientEmail)) {
      return res.status(400).json({ ok: false, error: 'A valid client email is required.', code: 'BAD_EMAIL' });
    }

    // Whitelist the action up front (create falls through to the gated path below).
    if (action !== 'create' && action !== 'resend' && action !== 'cancel') {
      return res.status(400).json({ ok: false, error: 'Unknown action.', code: 'BAD_ACTION' });
    }
    if (action === 'cancel') return cancelAssignment(res, coach.id, clientEmail, body);
    if (action === 'resend') return resendAssignment(res, coach.id, clientEmail, body);

    // --- CREATE: full gates ---
    if (coach.subscription_status !== 'active') {
      return res.status(403).json({ ok: false, error: 'An active subscription is required to assign Maps.', code: 'SUBSCRIPTION_INACTIVE' });
    }
    if (!(await isActiveConnection(coach.id, clientEmail))) {
      return res.status(403).json({ ok: false, error: 'This client is not an active connection.', code: 'NOT_CONNECTED' });
    }
    const tier = coach.subscription_tier ? String(coach.subscription_tier).toLowerCase() : '';
    const limit = limitForTier(tier);
    const used = await monthlyMapCount(coach.id, SUPABASE_URL, SUPABASE_KEY);
    if (used === null) {
      // Count unavailable: fail open (business guardrail, not a security boundary). Logged.
      console.error(`[assign-effectiveness-map] monthly count unavailable for coach ${coach.id}; allowing`);
    } else if (used >= limit) {
      return res.status(403).json({ ok: false, error: `You have reached your monthly limit of ${limit} Maps.`, code: 'MONTHLY_LIMIT_EXCEEDED', limit, used });
    }

    // --- optional carry-forward goal (Map re-take). Stored on the row so the
    //     intake pre-fills it; absent → the client names a brand-new goal. ---
    const carriedGoal = body && body.goal != null ? String(body.goal).trim() : '';
    if (carriedGoal.length > GOAL_MAX) {
      return res.status(400).json({ ok: false, error: 'That goal is too long to carry forward.', code: 'BAD_GOAL' });
    }

    // --- mint + persist (token and assignment share one expiry, so they can't drift) ---
    const sessionId = randomUUID();
    const expiresAtMs = Date.now() + EXPIRY_MS;
    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/effectiveness_map_assignments`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({
        coach_id: coach.id,
        client_email: clientEmail,
        session_id: sessionId,
        status: 'pending',
        expires_at: new Date(expiresAtMs).toISOString(),
        product_context: 'coaching',
        // Only set when carried forward; omitted → column stays NULL (new-goal flow).
        ...(carriedGoal ? { goal: carriedGoal } : {}),
      }),
    });
    if (!insRes.ok) {
      const t = await insRes.text().catch(() => '');
      console.error('[assign-effectiveness-map] insert failed', insRes.status, t.slice(0, 200));
      return res.status(200).json({ ok: false, error: FAIL_MSG });
    }
    const inserted = (await insRes.json().catch(() => []))[0] || null;
    const link = intakeLink(coach.id, clientEmail, sessionId, expiresAtMs);
    return res.status(200).json({
      ok: true,
      link,
      session_id: sessionId,
      status: 'pending',
      expires_at: inserted ? inserted.expires_at : new Date(expiresAtMs).toISOString(),
      assigned_at: inserted ? inserted.assigned_at : null,
    });
  } catch (e) {
    console.error('[assign-effectiveness-map] error', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }
}

// Re-mint the existing active assignment's link (same token). Requires the coach
// own the row and an active connection (it is a re-send of an invite).
async function resendAssignment(res, coachId, clientEmail, body) {
  const sessionId = body && body.session_id ? String(body.session_id) : '';
  if (!UUID_RE.test(sessionId)) return res.status(400).json({ ok: false, error: 'A session is required.', code: 'BAD_SESSION' });
  if (!(await isActiveConnection(coachId, clientEmail))) {
    return res.status(403).json({ ok: false, error: 'This client is not an active connection.', code: 'NOT_CONNECTED' });
  }
  const a = await loadOwnedAssignment(coachId, clientEmail, sessionId);
  if (!a) return res.status(404).json({ ok: false, error: 'Assignment not found.', code: 'NOT_FOUND' });
  const expMs = new Date(a.expires_at).getTime();
  // Reject completed/expired/non-finite-expiry: a NaN expiry would otherwise mint a
  // token that self-invalidates at verifyMapLink — a silently broken link.
  if (!Number.isFinite(expMs) || a.status === 'completed' || a.status === 'expired' || Date.now() > expMs) {
    return res.status(409).json({ ok: false, error: 'This link is no longer active. Assign a new one.', code: 'NOT_RESENDABLE' });
  }
  const link = intakeLink(coachId, clientEmail, sessionId, expMs);
  return res.status(200).json({ ok: true, link, session_id: sessionId, status: a.status, expires_at: a.expires_at });
}

// Flip an active assignment to 'expired'. Coach ownership is the only gate
// (cleanup must work even if the connection later lapsed).
async function cancelAssignment(res, coachId, clientEmail, body) {
  const sessionId = body && body.session_id ? String(body.session_id) : '';
  if (!UUID_RE.test(sessionId)) return res.status(400).json({ ok: false, error: 'A session is required.', code: 'BAD_SESSION' });
  const a = await loadOwnedAssignment(coachId, clientEmail, sessionId);
  if (!a) return res.status(404).json({ ok: false, error: 'Assignment not found.', code: 'NOT_FOUND' });
  if (a.status === 'completed') {
    return res.status(409).json({ ok: false, error: 'This Map is already complete and cannot be cancelled.', code: 'ALREADY_COMPLETED' });
  }
  // PATCH scoped to the SAME ownership triple loadOwnedAssignment verified
  // (coach_id + session_id + client_email), so the write can never widen past it.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/effectiveness_map_assignments`
      + `?coach_id=eq.${encodeURIComponent(coachId)}`
      + `&session_id=eq.${encodeURIComponent(sessionId)}`
      + `&client_email=eq.${encodeURIComponent(clientEmail)}`,
    { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ status: 'expired' }) }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('[assign-effectiveness-map] cancel patch failed', r.status, t.slice(0, 200));
    return res.status(200).json({ ok: false, error: FAIL_MSG });
  }
  return res.status(200).json({ ok: true, session_id: sessionId, status: 'expired' });
}
