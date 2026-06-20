// api/get-annotations.js
//
// POST /api/get-annotations — the caller's (supervisor's) annotations on one
// artifact. Body: { target_type, target_id }. Returns annotations where
// supervisor_id = caller AND target_type/target_id match, each with the
// supervisee's reflection (if any) attached.
//
// Returns: { ok:true, annotations:[ {...annotation, reflection } ] } | { ok:false, error }

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, normalizeTargetType, isUuid, SB_URL } from '../lib/supervision.js';

const FAIL = 'Could not load annotations.';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[get-annotations] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const b = parseBody(req);
    const targetType = normalizeTargetType(b.target_type);
    if (!targetType) return res.status(400).json({ ok: false, error: 'INVALID_TARGET_TYPE' });
    const targetId = b.target_id;
    if (!isUuid(targetId)) return res.status(400).json({ ok: false, error: 'MISSING_TARGET_ID' });

    const aRes = await fetch(
      `${SB_URL}/rest/v1/supervision_annotations?supervisor_id=eq.${encodeURIComponent(me)}`
      + `&target_type=eq.${encodeURIComponent(targetType)}&target_id=eq.${encodeURIComponent(targetId)}`
      + `&select=id,supervisee_id,target_type,target_id,body,visibility,created_at,updated_at&order=created_at.desc`,
      { headers: sbHeaders() }
    );
    if (!aRes.ok) { const t = await aRes.text().catch(() => ''); console.error('[get-annotations] read', aRes.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
    const annotations = await aRes.json().catch(() => []);

    const ids = (annotations || []).map((a) => a.id).filter(Boolean);
    const reflByAnnotation = {};
    if (ids.length) {
      const rRes = await fetch(
        `${SB_URL}/rest/v1/supervisee_reflections?annotation_id=in.(${ids.map(encodeURIComponent).join(',')})`
        + `&select=id,annotation_id,content,created_at,updated_at`,
        { headers: sbHeaders() }
      );
      if (rRes.ok) { const rows = await rRes.json().catch(() => []); (rows || []).forEach((r) => { reflByAnnotation[r.annotation_id] = r; }); }
    }

    const out = (annotations || []).map((a) => ({ ...a, reflection: reflByAnnotation[a.id] || null }));
    return res.status(200).json({ ok: true, annotations: out });
  } catch (e) {
    console.error('[get-annotations]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
