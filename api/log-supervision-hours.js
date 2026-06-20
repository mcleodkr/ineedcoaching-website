// api/log-supervision-hours.js
//
// POST /api/log-supervision-hours — a supervisor logs supervision time for a
// supervisee. Body: { supervisee_id, session_date, duration_minutes, hours_type,
// notes }. Authorization: an ACTIVE relationship over the supervisee. verified_at /
// verified_by are left null (verified separately via /api/verify-hours).
//
// Returns: { ok:true, hours } | { ok:false, error }

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, supervises, isUuid, SB_URL } from '../lib/supervision.js';

const FAIL = 'Could not log these hours.';
const HOURS_TYPES = ['individual', 'group', 'direct', 'indirect'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[log-supervision-hours] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const b = parseBody(req);
    const sid = b.supervisee_id;
    if (!isUuid(sid)) return res.status(400).json({ ok: false, error: 'MISSING_SUPERVISEE_ID' });
    if (!(await supervises(me, sid))) return res.status(403).json({ ok: false, error: 'NOT_SUPERVISING' });

    const sessionDate = typeof b.session_date === 'string' ? b.session_date.trim() : '';
    if (!DATE_RE.test(sessionDate)) return res.status(400).json({ ok: false, error: 'INVALID_DATE' });

    const duration = Number(b.duration_minutes);
    if (!Number.isInteger(duration) || duration <= 0) return res.status(400).json({ ok: false, error: 'Duration must be a positive number of minutes.' });

    const hoursType = HOURS_TYPES.includes(b.hours_type) ? b.hours_type : null;
    if (!hoursType) return res.status(400).json({ ok: false, error: 'INVALID_HOURS_TYPE' });

    const notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null;

    const ins = await fetch(`${SB_URL}/rest/v1/supervision_hours`, {
      method: 'POST', headers: sbHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ supervisor_id: me, supervisee_id: sid, session_date: sessionDate, duration_minutes: duration, hours_type: hoursType, notes }),
    });
    if (!ins.ok) { const t = await ins.text().catch(() => ''); console.error('[log-supervision-hours] insert', ins.status, t.slice(0, 200)); return res.status(200).json({ ok: false, error: FAIL }); }
    const hours = (await ins.json().catch(() => []))[0] || null;

    return res.status(200).json({ ok: true, hours });
  } catch (e) {
    console.error('[log-supervision-hours]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
