// api/update-agenda.js
//
// POST /api/update-agenda — mutate a supervision agenda. Body: { relationship_id,
// action, ... }. Operates on the latest agenda for the relationship. Role + status are
// enforced here under the service role.
//
// Supervisor actions:
//   action 'edit'     (draft)          -> replace items (add/remove/reorder/edit text)
//   action 'send'     (draft -> sent)  -> set sent_at, notify supervisee (in-app + email)
//   action 'discuss'  (sent|complete)  -> set one item's `discussed` flag
//   action 'complete' (sent -> complete) -> set completed_at
// Supervisee action:
//   action 'reflect'  (sent)           -> set one item's supervisee_reflection (+ discussed);
//                                          CANNOT change item text or source
//
// Returns: { ok:true, agenda } | { ok:false, error }

import {
  applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, isUuid, SB_URL,
  getRelationshipById, notifyCoach, coachContactsByIds, sendSupervisionAgendaEmail,
} from '../lib/supervision.js';
import { sanitizeItems } from '../lib/agenda.js';

const FAIL = 'Could not update the agenda.';
const SELECT = 'id,relationship_id,supervisor_id,supervisee_id,snapshot_id,items,status,sent_at,completed_at,created_at,updated_at';
const REFLECTION_MAX = 2000;

async function latestAgenda(relId) {
  const r = await fetch(`${SB_URL}/rest/v1/supervision_agendas?relationship_id=eq.${encodeURIComponent(relId)}&select=${SELECT}&order=created_at.desc&limit=1`, { headers: sbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return (Array.isArray(rows) && rows[0]) || null;
}

async function patchAgenda(id, patch) {
  const r = await fetch(`${SB_URL}/rest/v1/supervision_agendas?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[update-agenda] patch', r.status, t.slice(0, 200)); return null; }
  return (await r.json().catch(() => []))[0] || null;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[update-agenda] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const body = parseBody(req);
    const relId = body.relationship_id;
    const action = String(body.action || '');
    if (!isUuid(relId)) return res.status(400).json({ ok: false, error: 'MISSING_RELATIONSHIP_ID' });

    const rel = await getRelationshipById(relId);
    if (!rel) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const isSupervisor = rel.supervisor_id === me;
    const isSupervisee = rel.supervisee_id === me;
    if (!isSupervisor && !isSupervisee) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    const agenda = await latestAgenda(relId);
    if (!agenda) return res.status(404).json({ ok: false, error: 'NO_AGENDA' });

    // ── Supervisor: edit (draft only) ──
    if (action === 'edit') {
      if (!isSupervisor) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      if (agenda.status !== 'draft') return res.status(409).json({ ok: false, error: 'Only a draft agenda can be edited.' });
      const items = sanitizeItems(body.items, 'supervisor');
      const saved = await patchAgenda(agenda.id, { items });
      if (!saved) return res.status(500).json({ ok: false, error: FAIL });
      return res.status(200).json({ ok: true, agenda: saved });
    }

    // ── Supervisor: send (draft -> sent) ──
    if (action === 'send') {
      if (!isSupervisor) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      if (agenda.status !== 'draft') return res.status(409).json({ ok: false, error: 'This agenda has already been sent.' });
      if (!Array.isArray(agenda.items) || !agenda.items.length) return res.status(400).json({ ok: false, error: 'Add at least one agenda item before sending.' });
      const saved = await patchAgenda(agenda.id, { status: 'sent', sent_at: new Date().toISOString() });
      if (!saved) return res.status(500).json({ ok: false, error: FAIL });

      // Notify the supervisee (best-effort; never blocks the response).
      const contacts = await coachContactsByIds([rel.supervisee_id, rel.supervisor_id]);
      const supervisee = contacts[rel.supervisee_id] || {};
      const supervisor = contacts[rel.supervisor_id] || {};
      const supName = supervisor.display_name || supervisor.full_name || 'Your supervisor';
      await notifyCoach(rel.supervisee_id, {
        type: 'supervision_agenda',
        title: 'Supervision agenda shared',
        body: supName + ' shared an agenda for your next session. Add your reflections before you meet.',
        link_url: '/coach-dashboard.html',
      });
      await sendSupervisionAgendaEmail({ toEmail: supervisee.user_email, supervisorName: supName });

      return res.status(200).json({ ok: true, agenda: saved });
    }

    // ── Supervisor: mark one item discussed (sent or complete) ──
    if (action === 'discuss') {
      if (!isSupervisor) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      if (agenda.status === 'draft') return res.status(409).json({ ok: false, error: 'Send the agenda first.' });
      const itemId = body.item_id;
      const items = (Array.isArray(agenda.items) ? agenda.items : []).map((it) =>
        (it && it.id === itemId) ? { ...it, discussed: !!body.discussed } : it);
      const saved = await patchAgenda(agenda.id, { items });
      if (!saved) return res.status(500).json({ ok: false, error: FAIL });
      return res.status(200).json({ ok: true, agenda: saved });
    }

    // ── Supervisor: complete (sent -> complete) ──
    if (action === 'complete') {
      if (!isSupervisor) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      if (agenda.status !== 'sent') return res.status(409).json({ ok: false, error: 'Only a sent agenda can be completed.' });
      const saved = await patchAgenda(agenda.id, { status: 'complete', completed_at: new Date().toISOString() });
      if (!saved) return res.status(500).json({ ok: false, error: FAIL });
      return res.status(200).json({ ok: true, agenda: saved });
    }

    // ── Supervisee: reflect on one item (sent only) ──
    if (action === 'reflect') {
      if (!isSupervisee) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      if (agenda.status !== 'sent') return res.status(409).json({ ok: false, error: 'You can only add reflections once the agenda is shared.' });
      const itemId = body.item_id;
      const reflection = typeof body.reflection === 'string' ? body.reflection.trim().slice(0, REFLECTION_MAX) : '';
      let found = false;
      // Copy each item; only the matched item's reflection/discussed are touched — text
      // and source are preserved exactly, so a supervisee can never rewrite an item.
      const items = (Array.isArray(agenda.items) ? agenda.items : []).map((it) => {
        if (!it || it.id !== itemId) return it;
        found = true;
        return {
          ...it,
          supervisee_reflection: reflection || null,
          discussed: (body.discussed === undefined) ? !!it.discussed : !!body.discussed,
        };
      });
      if (!found) return res.status(404).json({ ok: false, error: 'ITEM_NOT_FOUND' });
      const saved = await patchAgenda(agenda.id, { items });
      if (!saved) return res.status(500).json({ ok: false, error: FAIL });
      return res.status(200).json({ ok: true, agenda: saved });
    }

    return res.status(400).json({ ok: false, error: 'UNKNOWN_ACTION' });
  } catch (e) {
    console.error('[update-agenda]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
