// api/resolve-supervisor-invite.js
//
// POST /api/resolve-supervisor-invite — provisions a supervisor on first
// authenticated load and links any Case B invitations addressed to them.
// Identity is derived ONLY from the caller's Supabase JWT email (never the body).
// Idempotent and safe to call on every supervisor-dashboard load:
//   1. ensure a coach_profiles row exists for the verified email (minimal identity)
//   2. ensure the 'supervisor' role is granted
//   3. link pending Case B rows (invited_supervisor_email match, supervisor_id null)
//      by stamping supervisor_id = the resolved coach id (status stays 'pending'
//      so the supervisor still accepts from their dashboard)
//
// Returns: { ok:true, coach_id, linked } | { ok:false, error }

import {
  applyCors, serviceConfigured, sbHeaders, SB_URL,
  ensureCoachProfileByEmail, ensureSupervisorRole, resolveCoachByEmail, isSupervisor,
} from '../lib/supervision.js';

const FAIL = 'Could not set up your supervisor workspace.';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Verified email + full_name (user_metadata) from the caller's JWT, or null.
async function deriveUser(req) {
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    const email = u && u.email ? String(u.email).trim().toLowerCase() : '';
    if (!email) return null;
    const md = (u && u.user_metadata) || {};
    const full_name = md.full_name || md.name || md.display_name || null;
    return { email, full_name };
  } catch { return null; }
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[resolve-supervisor-invite] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const user = await deriveUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    // Only provision when there is a legitimate reason: a pending Case B invitation
    // addressed to this email, or the caller is already a supervisor. A bare visit to
    // the dashboard by an unrelated coach must NOT auto-grant the supervisor role.
    const pendRes = await fetch(
      `${SB_URL}/rest/v1/supervision_relationships?invited_supervisor_email=ilike.${encodeURIComponent(user.email)}`
      + `&supervisor_id=is.null&status=eq.pending&select=id,supervisee_id`,
      { headers: sbHeaders() }
    );
    const pending = pendRes.ok ? (await pendRes.json().catch(() => [])) : [];

    const existingProfile = await resolveCoachByEmail(user.email);
    const alreadySupervisor = existingProfile ? await isSupervisor(existingProfile.id) : false;

    if (!(Array.isArray(pending) && pending.length) && !alreadySupervisor) {
      return res.status(200).json({ ok: true, coach_id: existingProfile ? existingProfile.id : null, linked: 0, provisioned: false });
    }

    const coachId = existingProfile ? existingProfile.id : await ensureCoachProfileByEmail(user.email, { full_name: user.full_name });
    if (!coachId) { console.error('[resolve-supervisor-invite] could not ensure profile for', user.email); return res.status(500).json({ ok: false, error: FAIL }); }

    await ensureSupervisorRole(coachId);
    let linked = 0;
    for (const inv of (Array.isArray(pending) ? pending : [])) {
      // Skip if an active/pending row already ties this supervisor to that supervisee
      // (the UNIQUE(supervisor_id, supervisee_id) would otherwise reject the update).
      if (inv.supervisee_id === coachId) continue;
      const upd = await fetch(`${SB_URL}/rest/v1/supervision_relationships?id=eq.${encodeURIComponent(inv.id)}`, {
        method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ supervisor_id: coachId }),
      });
      if (upd.ok) linked += 1;
      else { const t = await upd.text().catch(() => ''); console.error('[resolve-supervisor-invite] link', upd.status, t.slice(0, 160)); }
    }

    return res.status(200).json({ ok: true, coach_id: coachId, linked });
  } catch (e) {
    console.error('[resolve-supervisor-invite]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
