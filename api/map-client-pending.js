// api/map-client-pending.js
//
// POST /api/map-client-pending — list a single client's PENDING / IN-PROGRESS
// Effectiveness Map assignments for the requesting coach, each with a ready-to-use
// intake link. The coach's Supabase JWT is the authorization (coach ownership
// only — no active-connection gate; this is a read of the coach's own rows).
//
// The intake token is NOT stored: it's a deterministic HMAC over
// (coach_id, client_email, session_id, expires_at). We re-mint it here with each
// row's STORED expires_at — identical to the original token (no drift), exactly
// like assign-effectiveness-map's resend path.
//
// Body: { client_email }
// Returns: { ok:true, pending:[ { session_id, status, expires_at, assigned_at, goal, link } ] }  (newest first)
//          { ok:false, error, code? }

import { signMapLink } from '../lib/effmap-core/map-link.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same pinned canonical host + path as assign-effectiveness-map.js.
const SITE_ORIGIN = process.env.SITE_URL || 'https://www.ineedcoaching.org';
const INTAKE_PATH = '/map/intake';

const FAIL_MSG = 'Could not load pending Maps. Please try again.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;

function sbHeaders(extra) {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// Coach identity from the JWT (never trusted from the body) — mirrors assign-effectiveness-map.
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

// ilike for case-insensitive match, guarded with a JS exact compare so a wildcard
// email can't resolve to another coach — identical to assign-effectiveness-map.
async function loadCoach(coachEmail) {
  const url = `${SUPABASE_URL}/rest/v1/coach_profiles`
    + `?user_email=ilike.${encodeURIComponent(coachEmail)}`
    + `&select=id,user_email&limit=5`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row && row.user_email && String(row.user_email).toLowerCase() === coachEmail) || null;
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
    console.error('[map-client-pending] server not configured');
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }

  try {
    const coachEmail = await deriveCoachEmail(req);
    if (!coachEmail) return res.status(401).json({ ok: false, error: 'Please sign in again.', code: 'UNAUTHORIZED' });
    const coach = await loadCoach(coachEmail);
    if (!coach) return res.status(403).json({ ok: false, error: 'Coach profile not found.', code: 'ACCESS_DENIED' });

    const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
    const clientEmail = body && body.client_email ? String(body.client_email).trim().toLowerCase() : '';
    if (!clientEmail || clientEmail.length > EMAIL_MAX || !EMAIL_RE.test(clientEmail)) {
      return res.status(400).json({ ok: false, error: 'A valid client email is required.', code: 'BAD_EMAIL' });
    }

    // Coach-owned pending/in_progress assignments for this client, newest first.
    const url = `${SUPABASE_URL}/rest/v1/effectiveness_map_assignments`
      + `?coach_id=eq.${encodeURIComponent(coach.id)}`
      + `&client_email=eq.${encodeURIComponent(clientEmail)}`
      + `&status=in.(pending,in_progress)`
      + `&select=session_id,status,expires_at,assigned_at,goal`
      + `&order=assigned_at.desc`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[map-client-pending] assignments read failed', r.status, t.slice(0, 200));
      return res.status(200).json({ ok: false, error: FAIL_MSG });
    }
    const rows = await r.json().catch(() => []);
    const now = Date.now();

    const pending = (Array.isArray(rows) ? rows : [])
      // Drop rows already past their window — the link would self-invalidate at verify.
      .filter((row) => {
        const expMs = new Date(row.expires_at).getTime();
        return Number.isFinite(expMs) && now <= expMs;
      })
      .map((row) => ({
        session_id: row.session_id,
        status: row.status,
        expires_at: row.expires_at,
        assigned_at: row.assigned_at,
        goal: row.goal != null && String(row.goal).trim() !== '' ? String(row.goal) : null,
        link: intakeLink(coach.id, clientEmail, row.session_id, new Date(row.expires_at).getTime()),
      }));

    return res.status(200).json({ ok: true, pending });
  } catch (e) {
    console.error('[map-client-pending] error', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }
}
