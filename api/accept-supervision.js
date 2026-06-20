// api/accept-supervision.js
//
// POST /api/accept-supervision — the supervisor accepts or declines a PENDING
// supervision request. Body: { relationship_id, action:'accept'|'decline' }.
// Accept → status 'active'; decline → status 'archived'. Caller must be the
// supervisor on the row and the row must still be pending.
//
// Returns: { ok:true, status } | { ok:false, error }

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, isUuid, SB_URL } from '../lib/supervision.js';

const FAIL = 'Could not update this request.';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[accept-supervision] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const body = parseBody(req);
    const relId = body.relationship_id;
    const action = body.action === 'decline' ? 'decline' : 'accept';
    if (!isUuid(relId)) return res.status(400).json({ ok: false, error: 'MISSING_RELATIONSHIP_ID' });

    const r = await fetch(
      `${SB_URL}/rest/v1/supervision_relationships?id=eq.${encodeURIComponent(relId)}&select=id,supervisor_id,status&limit=1`,
      { headers: sbHeaders() }
    );
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[accept-supervision] read', r.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
    const rows = await r.json().catch(() => []);
    const rel = Array.isArray(rows) ? rows[0] : null;
    if (!rel) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (rel.supervisor_id !== me) return res.status(403).json({ ok: false, error: 'NOT_YOUR_REQUEST' });
    if (rel.status !== 'pending') return res.status(409).json({ ok: false, error: 'NOT_PENDING' });

    const newStatus = action === 'accept' ? 'active' : 'archived';
    const patch = action === 'accept' ? { status: newStatus } : { status: newStatus, archived_at: new Date().toISOString() };
    const upd = await fetch(
      `${SB_URL}/rest/v1/supervision_relationships?id=eq.${encodeURIComponent(relId)}`,
      { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(patch) }
    );
    if (!upd.ok) { const t = await upd.text().catch(() => ''); console.error('[accept-supervision] patch', upd.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }

    return res.status(200).json({ ok: true, status: newStatus });
  } catch (e) {
    console.error('[accept-supervision]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
