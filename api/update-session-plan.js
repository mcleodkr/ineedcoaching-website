// PATCH/POST { plan_id, updates, edited_by? }
// Free-edit a session plan after generation. Updates the column values directly
// (no AI cost) and appends one entry per changed field to coach_edits[]. The
// server reads existing coach_edits, appends, and writes back so concurrent
// edits from two coach tabs cannot race over each other.
//
// Allowed fields:
//  Top-level columns: opening, key_questions, body_cues_to_watch,
//                     turning_points, branches, time_flow
//  coaching_data keys: today_priority, do_not_miss, close_with,
//                     commitments_to_test
//
// updates: { [field]: new_value } — any subset.

const TOP_LEVEL_FIELDS = new Set([
  'opening','key_questions','body_cues_to_watch','turning_points','branches','time_flow',
]);
const COACHING_DATA_FIELDS = new Set([
  'today_priority','do_not_miss','close_with','commitments_to_test',
]);

function truncate(value, max) {
  if (value == null) return value;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { plan_id, updates, edited_by } = body;
    if (!plan_id || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'Missing required fields: plan_id, updates (object)' });
    }
    const updateKeys = Object.keys(updates);
    if (!updateKeys.length) {
      return res.status(400).json({ error: 'updates must contain at least one field' });
    }
    const unknown = updateKeys.filter(k => !TOP_LEVEL_FIELDS.has(k) && !COACHING_DATA_FIELDS.has(k));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown editable field(s): ' + unknown.join(', ') });
    }

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    // Load existing row to read previous_value + current coach_edits + coaching_data.
    const planRes = await fetch(`${SUPABASE_URL}/rest/v1/session_plans?id=eq.${plan_id}&select=*&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const planRows = await planRes.json();
    if (!Array.isArray(planRows) || planRows.length === 0) {
      return res.status(404).json({ error: 'Session plan not found' });
    }
    const existing = planRows[0];
    if (existing.archived_at) {
      return res.status(409).json({ error: 'Cannot edit an archived session plan' });
    }

    // Build PATCH body. Top-level fields go directly; coaching_data fields get
    // merged into the existing coaching_data jsonb so we don't clobber siblings
    // (source_attribution, source_intervention_plan_id, etc).
    const patchBody = {};
    const newCoachingData = { ...(existing.coaching_data || {}) };
    let coachingDataChanged = false;

    const editEntries = [];
    const nowIso = new Date().toISOString();

    for (const key of updateKeys) {
      const newVal = updates[key];
      const oldVal = TOP_LEVEL_FIELDS.has(key) ? existing[key] : (existing.coaching_data || {})[key];
      // Skip no-op writes — JSON.stringify equality is good enough here
      if (JSON.stringify(oldVal ?? null) === JSON.stringify(newVal ?? null)) continue;
      if (TOP_LEVEL_FIELDS.has(key)) {
        patchBody[key] = newVal;
      } else {
        newCoachingData[key] = newVal;
        coachingDataChanged = true;
      }
      editEntries.push({
        field: key,
        old_value: truncate(oldVal, 500),
        new_value: truncate(newVal, 500),
        edited_at: nowIso,
        coach_id: edited_by || null,
      });
    }

    if (editEntries.length === 0) {
      return res.status(200).json({ ok: true, no_changes: true });
    }

    if (coachingDataChanged) patchBody.coaching_data = newCoachingData;

    const currentEdits = Array.isArray(existing.coach_edits) ? existing.coach_edits : [];
    patchBody.coach_edits = currentEdits.concat(editEntries);

    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/session_plans?id=eq.${plan_id}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(patchBody),
    });
    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error('[update-session-plan] PATCH failed:', err);
      return res.status(500).json({ error: 'Failed to update session plan', detail: err.slice(0, 400) });
    }
    const updated = await patchRes.json();
    const row = Array.isArray(updated) ? updated[0] : updated;

    // Log one analytics row per Save event with the list of fields touched.
    // Best-effort — do not block or rollback on logging failure.
    fetch(`${SUPABASE_URL}/rest/v1/session_plan_actions`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        session_plan_id: plan_id,
        coach_id: edited_by || existing.coach_id || null,
        client_email: existing.client_email || null,
        booking_id: existing.booking_id || null,
        action: 'edit',
        edited_fields: editEntries.map(e => e.field),
      }),
    }).catch(e => console.error('[update-session-plan] analytics log failed:', e.message));

    return res.status(200).json({ ...row, ...(row?.coaching_data || {}) });
  } catch (e) {
    console.error('[update-session-plan] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
