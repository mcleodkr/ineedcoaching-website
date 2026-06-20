// api/save-reflection.js
//
// POST /api/save-reflection — a supervisee responds to a shared annotation.
// Body: { annotation_id, content }. The annotation must be visible to the caller
// (visibility 'shared_with_supervisee' AND supervisee_id = caller). One reflection
// per annotation (unique) — an existing reflection is updated. The supervisor is
// notified best-effort.
//
// Returns: { ok:true, reflection } | { ok:false, error }

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, notifyCoach, isUuid, SB_URL } from '../lib/supervision.js';

const FAIL = 'Could not save your reflection.';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[save-reflection] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const b = parseBody(req);
    const annotationId = b.annotation_id;
    const content = typeof b.content === 'string' ? b.content.trim() : '';
    if (!isUuid(annotationId)) return res.status(400).json({ ok: false, error: 'MISSING_ANNOTATION_ID' });
    if (content.length < 2) return res.status(400).json({ ok: false, error: 'Please write a reflection before saving.' });

    // The annotation must be shared with THIS caller (they are its supervisee).
    const aRes = await fetch(
      `${SB_URL}/rest/v1/supervision_annotations?id=eq.${encodeURIComponent(annotationId)}`
      + `&select=id,supervisor_id,supervisee_id,visibility&limit=1`,
      { headers: sbHeaders() }
    );
    if (!aRes.ok) { const t = await aRes.text().catch(() => ''); console.error('[save-reflection] ann read', aRes.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
    const ann = (await aRes.json().catch(() => []))[0];
    if (!ann) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    if (ann.supervisee_id !== me || ann.visibility !== 'shared_with_supervisee') {
      return res.status(403).json({ ok: false, error: 'NOT_YOURS' });
    }

    // One reflection per annotation: update if present, else insert.
    const existRes = await fetch(
      `${SB_URL}/rest/v1/supervisee_reflections?annotation_id=eq.${encodeURIComponent(annotationId)}&select=id&limit=1`,
      { headers: sbHeaders() }
    );
    const existing = existRes.ok ? (await existRes.json().catch(() => []))[0] : null;

    let reflection;
    if (existing) {
      const upd = await fetch(
        `${SB_URL}/rest/v1/supervisee_reflections?id=eq.${encodeURIComponent(existing.id)}`,
        { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=representation' }), body: JSON.stringify({ content }) }
      );
      if (!upd.ok) { const t = await upd.text().catch(() => ''); console.error('[save-reflection] update', upd.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
      reflection = (await upd.json().catch(() => []))[0] || null;
    } else {
      const ins = await fetch(`${SB_URL}/rest/v1/supervisee_reflections`, {
        method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({ annotation_id: annotationId, coach_id: me, content }),
      });
      if (!ins.ok) { const t = await ins.text().catch(() => ''); console.error('[save-reflection] insert', ins.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
      reflection = (await ins.json().catch(() => []))[0] || null;
      // Notify the supervisor only on first reflection.
      await notifyCoach(ann.supervisor_id, {
        type: 'supervisee_reflection',
        title: 'Supervisee responded',
        body: 'Your supervisee responded to your feedback.',
        link_url: '/supervisor-dashboard.html',
      });
    }

    return res.status(200).json({ ok: true, reflection });
  } catch (e) {
    console.error('[save-reflection]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
