// api/get-supervisees.js
//
// POST/GET /api/get-supervisees — the caller's supervisees. Caller must hold the
// 'supervisor' role. Returns active + pending relationships where supervisor_id is
// the caller, each enriched with the supervisee's coach profile (display_name etc.).
//
// Returns: { ok:true, active:[...], pending:[...] } | { ok:false, error }

import { applyCors, serviceConfigured, sbHeaders, deriveCoachId, isSupervisor, SB_URL } from '../lib/supervision.js';

const FAIL = 'Could not load your supervisees.';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[get-supervisees] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    if (!(await isSupervisor(me))) return res.status(403).json({ ok: false, error: 'NOT_A_SUPERVISOR' });

    const relRes = await fetch(
      `${SB_URL}/rest/v1/supervision_relationships?supervisor_id=eq.${encodeURIComponent(me)}`
      + `&status=in.(active,pending)&select=id,status,supervisee_id,created_at&order=created_at.desc`,
      { headers: sbHeaders() }
    );
    if (!relRes.ok) { const t = await relRes.text().catch(() => ''); console.error('[get-supervisees] rel read', relRes.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
    const rels = await relRes.json().catch(() => []);

    const ids = [...new Set((rels || []).map((r) => r.supervisee_id).filter(Boolean))];
    const profiles = {};
    if (ids.length) {
      const pRes = await fetch(
        `${SB_URL}/rest/v1/coach_profiles?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,display_name,full_name,user_email`,
        { headers: sbHeaders() }
      );
      if (pRes.ok) { const rows = await pRes.json().catch(() => []); (rows || []).forEach((p) => { profiles[p.id] = p; }); }
    }

    const shape = (r) => ({
      relationship_id: r.id,
      status: r.status,
      created_at: r.created_at,
      supervisee: profiles[r.supervisee_id] || { id: r.supervisee_id },
    });
    const active = (rels || []).filter((r) => r.status === 'active').map(shape);
    const pending = (rels || []).filter((r) => r.status === 'pending').map(shape);
    return res.status(200).json({ ok: true, active, pending });
  } catch (e) {
    console.error('[get-supervisees]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
