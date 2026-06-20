// lib/supervision.js
//
// Shared helpers for the Supervision API routes (Ticket 2). Service-role only.
// Coach identity is ALWAYS derived from the caller's Supabase JWT email (the house
// convention — mirrors api/map-coach-read.js / api/assign-effectiveness-map.js) and
// never trusted from the request body. Cross-coach reads (a supervisor reading a
// supervisee's data) require the service role because those tables' RLS only admits
// the owning coach; authorization is therefore enforced HERE in code (supervisor
// role + an active supervision relationship) before any cross-coach data is returned.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const SB_URL = SUPABASE_URL;
export function serviceConfigured() { return !!SERVICE_KEY; }

export function sbHeaders(extra) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(extra || {}) };
}

export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
}

export function parseBody(req) {
  if (!req || req.body == null) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s.trim()); }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isEmail(s) { return typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s); }

// Caller's auth email (lowercased) from the Supabase JWT Bearer token, or null.
export async function deriveEmail(req) {
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    const email = u && u.email ? String(u.email).trim().toLowerCase() : '';
    return email || null;
  } catch { return null; }
}

// Caller's coach_profiles.id. ilike for case-insensitive match, then an EXACT
// lowercased JS check so an email containing %/_ can't resolve to another row
// (same guard as api/map-coach-read.js).
export async function deriveCoachId(req) {
  const email = await deriveEmail(req);
  if (!email) return null;
  return resolveCoachIdByEmail(email);
}

export async function resolveCoachIdByEmail(email) {
  const c = await resolveCoachByEmail(email);
  return c ? c.id : null;
}

// Full coach profile (id + names + email) by email, or null. Used by invite-supervisor.
export async function resolveCoachByEmail(email) {
  if (!isEmail(email)) return null;
  const lower = email.trim().toLowerCase();
  const url = `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=ilike.${encodeURIComponent(lower)}&select=id,user_email,display_name,full_name&limit=5`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  if (!Array.isArray(rows)) return null;
  return rows.find((row) => row && row.user_email && String(row.user_email).toLowerCase() === lower) || null;
}

export async function isSupervisor(coachId) {
  if (!coachId) return false;
  const url = `${SUPABASE_URL}/rest/v1/user_roles?coach_id=eq.${encodeURIComponent(coachId)}&role=eq.supervisor&select=id&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return false;
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

// Is there an ACTIVE supervision relationship from supervisorId over superviseeId?
export async function supervises(supervisorId, superviseeId) {
  if (!supervisorId || !superviseeId) return false;
  const url = `${SUPABASE_URL}/rest/v1/supervision_relationships`
    + `?supervisor_id=eq.${encodeURIComponent(supervisorId)}`
    + `&supervisee_id=eq.${encodeURIComponent(superviseeId)}`
    + `&status=eq.active&select=id&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return false;
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

// Best-effort notification write (existing coach_notifications pattern). Never throws.
export async function notifyCoach(coachId, { type, title, body, link_url }) {
  if (!coachId || !type || !title) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/coach_notifications`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ coach_id: coachId, type, title, body: body || null, link_url: link_url || null }),
    });
  } catch (e) {
    console.warn('[supervision] notifyCoach failed', e && e.message);
  }
}

// Annotation target_type allowlist (matches the live CHECK constraint). Note the
// brief's "session_note" maps to the live value "session".
const TARGET_TYPES = ['effectiveness_map', 'session', 'booking', 'client', 'coach_dna', 'pattern_map', 'general'];
export function normalizeTargetType(t) {
  const v = String(t || '').trim();
  if (v === 'session_note') return 'session';
  return TARGET_TYPES.includes(v) ? v : null;
}
