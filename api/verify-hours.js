// api/verify-hours.js
//
// POST /api/verify-hours — a supervisor marks a logged hours row as verified.
// Body: { hours_id }. Authorization: the caller must be the supervisor_id on the
// row and it must be unverified. Sets verified_at = now(), verified_by = caller.
//
// Returns: { ok:true, verified_at } | { ok:false, error }

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, isUuid, SB_URL } from '../lib/supervision.js';

const FAIL = 'Could not verify these hours.';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[verify-hours] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const b = parseBody(req);
    const hoursId = b.hours_id;
    if (!isUuid(hoursId)) return res.status(400).json({ ok: false, error: 'MISSING_HOURS_ID' });

    const r = await fetch(
      `${SB_URL}/rest/v1/supervision_hours?id=eq.${encodeURIComponent(hoursId)}&select=id,supervisor_id,verified_at&limit=1`,
      { headers: sbHeaders() }
    );
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[verify-hours] read', r.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
    const row = (await r.json().catch(() => []))[0];
    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (row.supervisor_id !== me) return res.status(403).json({ ok: false, error: 'NOT_YOURS' });
    if (row.verified_at) return res.status(409).json({ ok: false, error: 'ALREADY_VERIFIED' });

    const verifiedAt = new Date().toISOString();
    const upd = await fetch(
      `${SB_URL}/rest/v1/supervision_hours?id=eq.${encodeURIComponent(hoursId)}`,
      { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ verified_at: verifiedAt, verified_by: me }) }
    );
    if (!upd.ok) { const t = await upd.text().catch(() => ''); console.error('[verify-hours] patch', upd.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }

    return res.status(200).json({ ok: true, verified_at: verifiedAt });
  } catch (e) {
    console.error('[verify-hours]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
