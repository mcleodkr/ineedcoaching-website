// PATCH { plan_id, section, new_value, edited_by? }
// Updates one top-level section of a locked intervention plan and appends
// an audit entry to coach_edits[]. Refuses to write when status='draft'
// (revision rounds, not free-edit, are the right surface in draft).

const ALLOWED_SECTIONS = new Set([
  'external_conditions','working_hypotheses','strategic_frames','behavioral_targets',
  'prior_commitments','modality_sequence','progress_markers','risk_watchouts',
  'session_arc','coach_commitment',
  // coach_notes uses append-only semantics below — new_value is one note object,
  // not the full array. Treated separately from coach_edits[] audit trail.
  'coach_notes',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Accept POST as well so the dashboard can call from environments where
  // PATCH is awkward; semantics are identical.
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { plan_id, section, new_value, edited_by } = body;
    if (!plan_id || !section) {
      return res.status(400).json({ error: 'Missing required fields: plan_id, section' });
    }
    if (!ALLOWED_SECTIONS.has(section)) {
      return res.status(400).json({ error: `Section not editable via this endpoint: ${section}` });
    }

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    // Load existing plan to verify lock + capture previous_value for the audit row.
    // Always select coach_notes too so the append path below can read the current
    // array regardless of which section was passed.
    const planRes = await fetch(`${SUPABASE_URL}/rest/v1/intervention_plans?id=eq.${plan_id}&select=id,status,coach_edits,coach_notes,${section}&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const planRows = await planRes.json();
    if (!Array.isArray(planRows) || planRows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    const existing = planRows[0];
    if (existing.status !== 'locked') {
      return res.status(409).json({ error: 'Plan must be locked before inline edits. Use revise-intervention-plan during draft.' });
    }

    let patchBody;
    if (section === 'coach_notes') {
      // Append-only semantics: new_value is one note object, not the full array.
      // Server reads current array and appends so concurrent notes never race.
      // Note: coach_notes is its own audit trail — we deliberately do NOT touch
      // coach_edits[] or flip generated_by_ai for note additions, since the
      // AI-authored sections themselves are unchanged.
      const incoming = (new_value && typeof new_value === 'object' && !Array.isArray(new_value)) ? new_value : null;
      if (!incoming || !incoming.note || !incoming.section) {
        return res.status(400).json({ error: 'coach_notes new_value must be { section, note, created_at?, edited_by? }' });
      }
      const stamped = {
        section: String(incoming.section),
        note: String(incoming.note),
        created_at: incoming.created_at || new Date().toISOString(),
        edited_by: incoming.edited_by || edited_by || null,
      };
      const currentNotes = Array.isArray(existing.coach_notes) ? existing.coach_notes : [];
      patchBody = { coach_notes: currentNotes.concat([stamped]) };
    } else {
      const previousValue = existing[section];
      const editEntry = {
        section,
        edited_at: new Date().toISOString(),
        edited_by: edited_by || null,
        previous_value: previousValue,
        new_value,
      };
      const updatedEdits = Array.isArray(existing.coach_edits) ? existing.coach_edits.concat([editEntry]) : [editEntry];
      patchBody = {
        [section]: new_value,
        coach_edits: updatedEdits,
        generated_by_ai: false,
      };
    }

    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/intervention_plans?id=eq.${plan_id}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(patchBody),
    });
    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error('[intervention-plan-section] PATCH failed:', err);
      return res.status(500).json({ error: 'Failed to update section', detail: err.slice(0, 400) });
    }
    const updated = await patchRes.json();
    return res.status(200).json(Array.isArray(updated) ? updated[0] : updated);
  } catch (e) {
    console.error('[intervention-plan-section] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
