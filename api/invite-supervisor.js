// api/invite-supervisor.js
//
// POST /api/invite-supervisor — a coach (supervisee) requests supervision from a
// registered supervisor by email. Body: { supervisor_email }. The supervisor email
// is resolved to coach_profiles.id and must hold the 'supervisor' role; a PENDING
// supervision_relationships row is created (supervisor_id resolved, supervisee_id =
// caller). No invited_supervisor_email column is used — supervisor_id is stored
// directly. The supervisor is notified via coach_notifications.
//
// Returns: { ok:true, relationship_id, status:'pending' } | { ok:false, error }

import {
  applyCors, parseBody, serviceConfigured, sbHeaders, deriveEmail, resolveCoachIdByEmail,
  resolveCoachByEmail, isSupervisor, notifyCoach, isEmail, SB_URL,
} from '../lib/supervision.js';

const FAIL = 'Could not send the supervision request.';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[invite-supervisor] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const myEmail = await deriveEmail(req);
    if (!myEmail) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    const me = await resolveCoachIdByEmail(myEmail);
    if (!me) return res.status(403).json({ ok: false, error: 'NO_COACH_PROFILE' });

    const body = parseBody(req);
    const supEmail = typeof body.supervisor_email === 'string' ? body.supervisor_email.trim().toLowerCase() : '';
    if (!isEmail(supEmail)) return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
    if (supEmail === myEmail) return res.status(400).json({ ok: false, error: 'CANNOT_SUPERVISE_SELF' });

    const supervisor = await resolveCoachByEmail(supEmail);
    if (!supervisor) return res.status(404).json({ ok: false, error: 'No coach with that email was found.' });
    if (!(await isSupervisor(supervisor.id))) return res.status(400).json({ ok: false, error: 'That email is not a registered supervisor.' });
    if (supervisor.id === me) return res.status(400).json({ ok: false, error: 'CANNOT_SUPERVISE_SELF' });

    // Don't create a duplicate (unique(supervisor_id, supervisee_id)); surface state instead.
    const existRes = await fetch(
      `${SB_URL}/rest/v1/supervision_relationships?supervisor_id=eq.${encodeURIComponent(supervisor.id)}`
      + `&supervisee_id=eq.${encodeURIComponent(me)}&select=id,status&limit=1`,
      { headers: sbHeaders() }
    );
    if (existRes.ok) {
      const existing = (await existRes.json().catch(() => []))[0];
      if (existing && existing.status === 'active') return res.status(409).json({ ok: false, error: 'This supervisor already supervises you.' });
      if (existing && existing.status === 'pending') return res.status(409).json({ ok: false, error: 'A request to this supervisor is already pending.' });
      // archived → fall through and re-invite by reactivating to pending.
      if (existing && existing.status === 'archived') {
        const reUpd = await fetch(
          `${SB_URL}/rest/v1/supervision_relationships?id=eq.${encodeURIComponent(existing.id)}`,
          { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ status: 'pending', archived_at: null }) }
        );
        if (!reUpd.ok) { const t = await reUpd.text().catch(() => ''); console.error('[invite-supervisor] reactivate', reUpd.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
        const row = (await reUpd.json().catch(() => []))[0];
        await notifyCoach(supervisor.id, { type: 'supervision_request', title: 'New supervision request', body: 'A coach requested supervision.', link_url: '/supervisor-dashboard.html' });
        return res.status(200).json({ ok: true, relationship_id: row && row.id, status: 'pending' });
      }
    }

    const ins = await fetch(`${SB_URL}/rest/v1/supervision_relationships`, {
      method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ supervisor_id: supervisor.id, supervisee_id: me, status: 'pending' }),
    });
    if (!ins.ok) { const t = await ins.text().catch(() => ''); console.error('[invite-supervisor] insert', ins.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
    const created = (await ins.json().catch(() => []))[0];

    await notifyCoach(supervisor.id, { type: 'supervision_request', title: 'New supervision request', body: 'A coach requested supervision.', link_url: '/supervisor-dashboard.html' });
    return res.status(200).json({ ok: true, relationship_id: created && created.id, status: 'pending' });
  } catch (e) {
    console.error('[invite-supervisor]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
