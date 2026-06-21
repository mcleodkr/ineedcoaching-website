// api/get-agenda.js
//
// POST /api/get-agenda — current supervision agenda for a relationship. Body:
// { relationship_id }. Role-aware: the supervisor sees the latest agenda in any
// status; the supervisee sees the latest agenda ONLY once it has been sent (drafts
// are never returned to the supervisee). Authorization is by party membership on the
// relationship, enforced here under the service role.
//
// Returns: { ok:true, agenda } | { ok:false, error }   (agenda may be null)

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, isUuid, SB_URL, getRelationshipById } from '../lib/supervision.js';

const FAIL = 'Could not load the agenda.';
const SELECT = 'id,relationship_id,supervisor_id,supervisee_id,snapshot_id,items,status,sent_at,completed_at,created_at,updated_at';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[get-agenda] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const body = parseBody(req);
    const relId = body.relationship_id;
    if (!isUuid(relId)) return res.status(400).json({ ok: false, error: 'MISSING_RELATIONSHIP_ID' });

    const rel = await getRelationshipById(relId);
    if (!rel) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    const isSupervisor = rel.supervisor_id === me;
    const isSupervisee = rel.supervisee_id === me;
    if (!isSupervisor && !isSupervisee) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });

    // Supervisee never sees a draft.
    let url = `${SB_URL}/rest/v1/supervision_agendas?relationship_id=eq.${encodeURIComponent(relId)}&select=${SELECT}&order=created_at.desc&limit=1`;
    if (isSupervisee && !isSupervisor) url += '&status=in.(sent,complete)';

    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[get-agenda] read', r.status, t.slice(0, 160)); return res.status(500).json({ ok: false, error: FAIL }); }
    const rows = await r.json().catch(() => []);
    const agenda = (Array.isArray(rows) && rows[0]) || null;

    return res.status(200).json({ ok: true, agenda });
  } catch (e) {
    console.error('[get-agenda]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
