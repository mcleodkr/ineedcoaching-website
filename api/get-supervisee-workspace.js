// api/get-supervisee-workspace.js
//
// POST /api/get-supervisee-workspace — all of one supervisee's coaching intelligence
// for the supervisor workspace. Body: { supervisee_id }. Authorization: the caller
// must have an ACTIVE supervision relationship over the supervisee (enforced here,
// since this is a cross-coach service-role read). Returns DNA, session notes, client
// patterns, and the supervision hours the caller has logged for this supervisee
// (with totals).
//
// Returns: { ok:true, dna, sessions, clients, hours, totals } | { ok:false, error }

import { applyCors, parseBody, serviceConfigured, sbHeaders, deriveCoachId, supervises, isUuid, SB_URL } from '../lib/supervision.js';

const FAIL = 'Could not load this supervisee.';

async function getJson(url) {
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[get-supervisee-workspace] read', r.status, t.slice(0, 160)); return null; }
  return r.json().catch(() => null);
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!serviceConfigured()) { console.error('[get-supervisee-workspace] not configured'); return res.status(500).json({ ok: false, error: FAIL }); }

  try {
    const me = await deriveCoachId(req);
    if (!me) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });

    const body = parseBody(req);
    const sid = body.supervisee_id;
    if (!isUuid(sid)) return res.status(400).json({ ok: false, error: 'MISSING_SUPERVISEE_ID' });
    if (!(await supervises(me, sid))) return res.status(403).json({ ok: false, error: 'NOT_SUPERVISING' });

    const enc = encodeURIComponent(sid);
    const [dnaRows, sessions, clients, hours] = await Promise.all([
      getJson(`${SB_URL}/rest/v1/coach_dna_profiles?coach_id=eq.${enc}&select=id,declared_orientation,framework_distribution,signal_patterns,growth_edges,session_count,last_analyzed&limit=1`),
      getJson(`${SB_URL}/rest/v1/coach_session_notes?coach_id=eq.${enc}&select=id,client_email,created_at,post_session_analysis,coaching_signals,dna_manifestations&order=created_at.desc`),
      getJson(`${SB_URL}/rest/v1/coach_client_patterns?coach_id=eq.${enc}&select=id,client_email,pattern_map,session_count,last_analyzed&order=last_analyzed.desc`),
      getJson(`${SB_URL}/rest/v1/supervision_hours?supervisor_id=eq.${encodeURIComponent(me)}&supervisee_id=eq.${enc}&select=id,session_date,duration_minutes,hours_type,notes,verified_at,verified_by,created_at&order=session_date.desc`),
    ]);

    const hoursList = Array.isArray(hours) ? hours : [];
    const sumMin = (type) => hoursList.filter((h) => h.hours_type === type).reduce((a, h) => a + (Number(h.duration_minutes) || 0), 0);
    const indMin = sumMin('individual');
    const grpMin = sumMin('group');
    const totalMin = hoursList.reduce((a, h) => a + (Number(h.duration_minutes) || 0), 0);
    const toHours = (m) => Math.round((m / 60) * 10) / 10;
    const totals = {
      individual_hours: toHours(indMin),
      group_hours: toHours(grpMin),
      total_hours: toHours(totalMin),
      verified_count: hoursList.filter((h) => h.verified_at).length,
      entry_count: hoursList.length,
    };

    return res.status(200).json({
      ok: true,
      dna: (Array.isArray(dnaRows) && dnaRows[0]) || null,
      sessions: Array.isArray(sessions) ? sessions : [],
      clients: Array.isArray(clients) ? clients : [],
      hours: hoursList,
      totals,
    });
  } catch (e) {
    console.error('[get-supervisee-workspace]', e && e.message);
    return res.status(500).json({ ok: false, error: FAIL });
  }
}
