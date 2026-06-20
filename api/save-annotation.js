// api/save-annotation.js
//
// POST /api/save-annotation — a supervisor leaves an annotation on a supervisee
// artifact. Body: { supervisee_id, target_type, target_id, body, visibility,
// annotation_type }. Authorization: an ACTIVE relationship over the supervisee.
//
// Notes on the live schema:
//  - There is NO annotation_type column, so the type label is prefixed onto the
//    body, e.g. "[Recommendation] ...".
//  - target_type 'session_note' is normalized to the live CHECK value 'session'.
//  - On a 'shared_with_supervisee' annotation, the supervisee is notified.
//
// Returns: { ok:true, annotation } | { ok:false, error }

import {
  applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, supervises,
  isUuid, normalizeTargetType, notifyCoach, SB_URL,
} from '../lib/supervision.js';

const FAIL = 'Could not save the annotation.';
const TYPES = ['Comment', 'Observation', 'Question', 'Recommendation'];

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[save-annotation] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const b = parseBody(req);
    const sid = b.supervisee_id;
    if (!isUuid(sid)) return res.status(400).json({ ok: false, error: 'MISSING_SUPERVISEE_ID' });
    if (!(await supervises(me, sid))) return res.status(403).json({ ok: false, error: 'NOT_SUPERVISING' });

    const targetType = normalizeTargetType(b.target_type);
    if (!targetType) return res.status(400).json({ ok: false, error: 'INVALID_TARGET_TYPE' });
    const targetId = b.target_id != null && isUuid(b.target_id) ? b.target_id : null;
    if (targetType !== 'general' && !targetId) return res.status(400).json({ ok: false, error: 'MISSING_TARGET_ID' });

    const rawBody = typeof b.body === 'string' ? b.body.trim() : '';
    if (rawBody.length < 10) return res.status(400).json({ ok: false, error: 'Annotation must be at least 10 characters.' });

    const visibility = b.visibility === 'supervisor_only' ? 'supervisor_only' : 'shared_with_supervisee';
    const type = TYPES.includes(b.annotation_type) ? b.annotation_type : 'Comment';
    const finalBody = `[${type}] ${rawBody}`;

    const ins = await fetch(`${SB_URL}/rest/v1/supervision_annotations`, {
      method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({
        supervisor_id: me, supervisee_id: sid,
        target_type: targetType, target_id: targetId,
        body: finalBody, visibility,
      }),
    });
    if (!ins.ok) { const t = await ins.text().catch(() => ''); console.error('[save-annotation] insert', ins.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
    const annotation = (await ins.json().catch(() => []))[0] || null;

    if (visibility === 'shared_with_supervisee') {
      await notifyCoach(sid, {
        type: 'supervisor_feedback',
        title: 'New supervisor feedback',
        body: 'Your supervisor left feedback on your work.',
        link_url: '/coach-dashboard.html?tab=supervision',
      });
    }
    return res.status(200).json({ ok: true, annotation });
  } catch (e) {
    console.error('[save-annotation]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
