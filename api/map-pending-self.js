// api/map-pending-self.js
//
// POST /api/map-pending-self — the logged-in CLIENT's own PENDING / IN-PROGRESS
// Effectiveness Map assignments, each with a ready intake link, so the client
// dashboard can render a "Take your Effectiveness Map" nudge. The client's own
// Supabase JWT is the authorization; the email is derived from that token
// server-side (never trusted from the body) and the service-role read is scoped
// strictly to client_email = that email — a client can only ever see assignments
// addressed to them. Mirrors api/map-client-read.js's auth model.
//
// The intake token is a deterministic HMAC over (coach_id, client_email,
// session_id, expires_at) — not stored — re-minted here with each row's STORED
// expires_at (no drift). coach_id is read only to mint the token and is NEVER
// returned to the browser.
//
// Body: {}  (identity comes from the JWT, not the body)
// Returns: { ok:true, pending:[ { session_id, status, expires_at, goal, link } ] }  (newest first)
//          { ok:false, error }

import { signMapLink } from '../lib/effmap-core/map-link.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SITE_ORIGIN = process.env.SITE_URL || 'https://www.ineedcoaching.org';
const INTAKE_PATH = '/map/intake';

const FAIL_MSG = 'Could not load your pending Maps.';
const EMAIL_MAX = 254;

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
}

// Resolve the caller's email from their Supabase JWT (never trusted from body) —
// identical to api/map-client-read.js.
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
    return email && email.length <= EMAIL_MAX ? email : null;
  } catch {
    return null;
  }
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
    console.error('[map-pending-self] server not configured');
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }

  try {
    const email = await deriveUserEmail(req);
    if (!email) return res.status(401).json({ ok: false, error: 'Please sign in again.' });

    // Strictly scoped to the caller's own email. coach_id is selected ONLY to mint
    // the token below — it is never placed in the response.
    const url = `${SUPABASE_URL}/rest/v1/effectiveness_map_assignments`
      + `?client_email=eq.${encodeURIComponent(email)}`
      + `&status=in.(pending,in_progress)`
      + `&select=session_id,status,expires_at,goal,coach_id`
      + `&order=assigned_at.desc`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[map-pending-self] assignments read failed', r.status, t.slice(0, 200));
      return res.status(200).json({ ok: false, error: FAIL_MSG });
    }
    const rows = await r.json().catch(() => []);
    const now = Date.now();

    const pending = (Array.isArray(rows) ? rows : [])
      .filter((row) => {
        const expMs = new Date(row.expires_at).getTime();
        return Number.isFinite(expMs) && now <= expMs;
      })
      .map((row) => ({
        session_id: row.session_id,
        status: row.status,
        expires_at: row.expires_at,
        goal: row.goal != null && String(row.goal).trim() !== '' ? String(row.goal) : null,
        link: intakeLink(row.coach_id, email, row.session_id, new Date(row.expires_at).getTime()),
      }));

    return res.status(200).json({ ok: true, pending });
  } catch (e) {
    console.error('[map-pending-self] error', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL_MSG });
  }
}
