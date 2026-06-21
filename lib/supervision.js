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

// Idempotently grant the 'supervisor' role to a coach. Safe to call repeatedly:
// checks for an existing row first, inserts only if missing. Never throws.
export async function ensureSupervisorRole(coachId) {
  if (!coachId) return false;
  try {
    if (await isSupervisor(coachId)) return true;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_roles`, {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ coach_id: coachId, role: 'supervisor' }),
    });
    if (!r.ok && r.status !== 409) { const t = await r.text().catch(() => ''); console.error('[supervision] ensureSupervisorRole', r.status, t.slice(0, 160)); }
    return true;
  } catch (e) { console.warn('[supervision] ensureSupervisorRole failed', e && e.message); return false; }
}

// One supervision_relationships row by id (id + parties + status), or null.
export async function getRelationshipById(relId) {
  if (!isUuid(relId)) return null;
  const url = `${SUPABASE_URL}/rest/v1/supervision_relationships?id=eq.${encodeURIComponent(relId)}&select=id,supervisor_id,supervisee_id,status&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) ? (rows[0] || null) : null;
}

// id -> { user_email, display_name, full_name } map for a set of coach ids.
export async function coachContactsByIds(ids) {
  const list = (ids || []).filter(Boolean).map(encodeURIComponent);
  if (!list.length) return {};
  const r = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=in.(${list.join(',')})&select=id,user_email,display_name,full_name`, { headers: sbHeaders() });
  if (!r.ok) return {};
  const rows = await r.json().catch(() => []);
  const byId = {};
  (Array.isArray(rows) ? rows : []).forEach((p) => { byId[p.id] = p; });
  return byId;
}

// Best-effort Resend email telling a supervisee their supervisor shared an agenda.
// Never throws.
export async function sendSupervisionAgendaEmail({ toEmail, supervisorName }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) { console.warn('[supervision] no RESEND_API_KEY; skipping agenda email'); return; }
  if (!isEmail(toEmail)) return;
  try {
    const who = (supervisorName && String(supervisorName).trim()) || 'Your supervisor';
    const url = 'https://www.ineedcoaching.org/coach-dashboard.html';
    const subject = 'Your supervisor has shared a supervision agenda';
    const text = `${who} has prepared an agenda for your upcoming supervision session.\n\n`
      + `Review it and add your reflections before you meet:\n${url}\n\nThe ineedcoaching.org team`;
    const html = `<p><strong>${escHtml(who)}</strong> has prepared an agenda for your upcoming supervision session.</p>`
      + `<p>Review it and add your reflections before you meet:</p>`
      + `<p><a href="${url}" style="color:#c49a3c;font-weight:600;">Open your dashboard &rarr;</a></p>`
      + `<p style="color:#6b6b6b;">The ineedcoaching.org team</p>`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'ineedcoaching.org <briefs@ineedcoaching.org>', to: toEmail, subject, text, html }),
    });
    if (!r.ok) console.error('[supervision] agenda email failed', r.status, await r.text().catch(() => ''));
  } catch (e) {
    console.error('[supervision] agenda email error', e && e.message);
  }
}

// Find the coach_profiles row for an email, creating a minimal one if none exists.
// New rows carry only identity fields (user_email + display/full name) — no
// marketplace, subscription, or coach-facing fields. Returns the profile id or null.
// Handles the UNIQUE(user_email) race by re-reading on a conflicting insert.
export async function ensureCoachProfileByEmail(email, opts) {
  if (!isEmail(email)) return null;
  const lower = email.trim().toLowerCase();
  const existing = await resolveCoachByEmail(lower);
  if (existing) return existing.id;
  const fullName = (opts && typeof opts.full_name === 'string' && opts.full_name.trim()) ? opts.full_name.trim() : null;
  const row = { user_email: lower, display_name: fullName, full_name: fullName };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (r.ok) {
    const created = (await r.json().catch(() => []))[0];
    if (created && created.id) return created.id;
  } else if (r.status === 409) {
    // Lost the race — the row now exists; read it back.
    const again = await resolveCoachByEmail(lower);
    if (again) return again.id;
  } else {
    const t = await r.text().catch(() => ''); console.error('[supervision] ensureCoachProfileByEmail', r.status, t.slice(0, 160));
  }
  return null;
}

// Best-effort Resend email inviting someone to supervise. mode 'existing' links to
// the supervisor dashboard; mode 'new' links to the free supervisor signup. Never throws.
export async function sendSupervisionInviteEmail({ toEmail, inviterName, mode }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) { console.warn('[supervision] no RESEND_API_KEY; skipping invite email'); return; }
  if (!isEmail(toEmail)) return;
  try {
    const who = (inviterName && String(inviterName).trim()) || 'A coach';
    const subject = `${who} has invited you to provide supervision`;
    let text, html;
    if (mode === 'new') {
      const url = 'https://www.ineedcoaching.org/supervisor-signup.html';
      text = `${who} has invited you to supervise their coaching practice on ineedcoaching.org.\n\n`
        + `Create your free supervisor account to accept:\n${url}\n\n`
        + `This invitation will be waiting for you when you sign up.\n\nThe ineedcoaching.org team`;
      html = `<p><strong>${escHtml(who)}</strong> has invited you to supervise their coaching practice on ineedcoaching.org.</p>`
        + `<p>Create your free supervisor account to accept:</p>`
        + `<p><a href="${url}" style="color:#c49a3c;font-weight:600;">Create your supervisor account &rarr;</a></p>`
        + `<p style="color:#6b6b6b;">This invitation will be waiting for you when you sign up.</p>`
        + `<p style="color:#6b6b6b;">The ineedcoaching.org team</p>`;
    } else {
      const url = 'https://www.ineedcoaching.org/supervisor-dashboard.html';
      text = `${who} has invited you to supervise their coaching practice on ineedcoaching.org.\n\n`
        + `Accept the request from your supervisor dashboard:\n${url}\n\nThe ineedcoaching.org team`;
      html = `<p><strong>${escHtml(who)}</strong> has invited you to supervise their coaching practice on ineedcoaching.org.</p>`
        + `<p><a href="${url}" style="color:#c49a3c;font-weight:600;">Accept on your supervisor dashboard &rarr;</a></p>`
        + `<p style="color:#6b6b6b;">The ineedcoaching.org team</p>`;
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'ineedcoaching.org <briefs@ineedcoaching.org>', to: toEmail, subject, text, html }),
    });
    if (!r.ok) console.error('[supervision] invite email failed', r.status, await r.text().catch(() => ''));
  } catch (e) {
    console.error('[supervision] invite email error', e && e.message);
  }
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

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
async function fetchRow(url) {
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) ? rows[0] : null;
}
// Client display name from the coach's pattern map (pattern_map.display_name), email fallback.
async function clientDisplayName(email) {
  if (!email) return '';
  const row = await fetchRow(`${SUPABASE_URL}/rest/v1/coach_client_patterns?client_email=eq.${encodeURIComponent(email)}&select=dn:pattern_map->>display_name&limit=1`);
  return (row && row.dn) ? row.dn : email;
}
// Human label naming the annotated artifact, for the notification email.
async function resolveArtifactLabel(targetType, targetId) {
  if (targetType === 'coach_dna') return 'your Coach DNA';
  if (targetType === 'effectiveness_map') return 'your Effectiveness Map';
  if (targetType === 'session' && targetId) {
    const s = await fetchRow(`${SUPABASE_URL}/rest/v1/coach_session_notes?id=eq.${encodeURIComponent(targetId)}&select=client_email,created_at&limit=1`);
    if (s) {
      const name = await clientDisplayName(s.client_email);
      const d = s.created_at ? new Date(s.created_at) : null;
      const date = (d && !isNaN(d.getTime())) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      return 'your session with ' + (name || 'a client') + (date ? ' on ' + date : '');
    }
    return 'a session note';
  }
  if (targetType === 'pattern_map' && targetId) {
    const p = await fetchRow(`${SUPABASE_URL}/rest/v1/coach_client_patterns?id=eq.${encodeURIComponent(targetId)}&select=client_email,dn:pattern_map->>display_name&limit=1`);
    if (p) return 'your client pattern for ' + (p.dn || p.client_email || 'a client');
    return 'a client pattern';
  }
  return 'your work';
}
// Best-effort Resend email to the supervisee when a supervisor shares an annotation.
// Never throws (failure is logged); the caller's response is unaffected.
export async function notifySharedAnnotationEmail({ superviseeId, supervisorId, targetType, targetId, annotationType }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY || !superviseeId) { if (!RESEND_API_KEY) console.warn('[supervision] no RESEND_API_KEY; skipping email'); return; }
  try {
    const ids = [superviseeId, supervisorId].filter(Boolean).map(encodeURIComponent).join(',');
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=in.(${ids})&select=id,user_email,display_name,full_name`, { headers: sbHeaders() });
    const profs = pr.ok ? await pr.json().catch(() => []) : [];
    const byId = {}; (profs || []).forEach((p) => { byId[p.id] = p; });
    const supervisee = byId[superviseeId];
    const to = supervisee && supervisee.user_email;
    if (!to) { console.warn('[supervision] no supervisee email; skipping'); return; }
    const supervisor = byId[supervisorId] || {};
    const supName = supervisor.display_name || supervisor.full_name || 'Your supervisor';
    const type = annotationType || 'Comment';
    const label = await resolveArtifactLabel(targetType, targetId);
    const url = 'https://www.ineedcoaching.org/coach-dashboard.html';
    const subject = 'Your supervisor left feedback on your work.';
    const text = `${supName} left ${String(type).toLowerCase()} feedback on ${label}.\n\nView it on your dashboard:\n${url}\n\nThe ineedcoaching.org team`;
    const html = `<p><strong>${escHtml(supName)}</strong> left <strong>${escHtml(type)}</strong> feedback on ${escHtml(label)}.</p>`
      + `<p><a href="${url}" style="color:#c49a3c;font-weight:600;">View it on your dashboard &rarr;</a></p>`
      + `<p style="color:#6b6b6b;">The ineedcoaching.org team</p>`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'ineedcoaching.org <briefs@ineedcoaching.org>', to, subject, text, html }),
    });
    if (!r.ok) console.error('[supervision] shared-annotation email failed', r.status, await r.text().catch(() => ''));
  } catch (e) {
    console.error('[supervision] shared-annotation email error', e && e.message);
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
