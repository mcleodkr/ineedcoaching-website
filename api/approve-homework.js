// Stage A homework approval — service role.
//
// POST actions:
//   approve  { coachId, clientEmail, bookingId, draftId, assignment_text, type }
//     → INSERT client_homework (source:'ai', status:'assigned'), then flip the
//       matching draft on coach_session_notes.homework to handled:true.
//   dismiss  { bookingId, draftId }
//     → flip the matching draft to handled:true. No client_homework row.
//   add      { coachId, clientEmail, bookingId?, assignment_text, type }
//     → INSERT client_homework (source:'manual', status:'assigned'). No draft.
//
// Modeled on api/approve-goal-proposal.js. Bypasses RLS so the coach UI can
// write without a client_homework INSERT/UPDATE policy (Stage A reads only).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { action, coachId, clientEmail, bookingId, draftId, type } = body;
    const assignmentText = typeof body.assignment_text === 'string' ? body.assignment_text.trim() : '';

    if (!action || !['approve', 'dismiss', 'add'].includes(action)) {
      return res.status(400).json({ error: `Invalid action: ${action}` });
    }

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };
    const readHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // ── Helper: read homework array off the session note, flip the draft,
    //    write it back. Used by approve + dismiss. Read-modify-write keeps
    //    other drafts untouched.
    async function flipDraftHandled(noteBookingId, targetDraftId) {
      const noteRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${noteBookingId}&select=id,homework&limit=1`,
        { headers: readHeaders }
      );
      const rows = await noteRes.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return { ok: false, status: 404, error: 'Source session not found' };
      }
      const note = rows[0];
      const drafts = Array.isArray(note.homework) ? note.homework : [];
      const draft = drafts.find(d => d && d.id === targetDraftId);
      if (!draft) {
        return { ok: false, status: 404, error: 'Draft not found on session' };
      }
      if (draft.handled === true) {
        return { ok: false, status: 409, error: 'Draft already handled' };
      }
      const nowIso = new Date().toISOString();
      const updated = drafts.map(d =>
        d && d.id === targetDraftId
          ? { ...d, handled: true, handled_action: action, handled_at: nowIso }
          : d
      );
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${noteBookingId}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ homework: updated }),
        }
      );
      if (!patchRes.ok) {
        const errBody = await patchRes.text().catch(() => '');
        return { ok: false, status: 500, error: 'Failed to mark draft handled', detail: errBody.slice(0, 300) };
      }
      return { ok: true, draft };
    }

    // ── action: dismiss ────────────────────────────────────────────────
    if (action === 'dismiss') {
      if (!bookingId || !draftId) {
        return res.status(400).json({ error: 'Missing required fields: bookingId, draftId' });
      }
      const flip = await flipDraftHandled(bookingId, draftId);
      if (!flip.ok) return res.status(flip.status).json({ error: flip.error, detail: flip.detail });
      return res.status(200).json({ ok: true, action: 'dismiss', draftId });
    }

    // ── action: approve ────────────────────────────────────────────────
    if (action === 'approve') {
      if (!coachId || !clientEmail || !bookingId || !draftId || !assignmentText) {
        return res.status(400).json({ error: 'Missing required fields: coachId, clientEmail, bookingId, draftId, assignment_text' });
      }
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/client_homework`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          coach_id: coachId,
          client_email: clientEmail,
          booking_id: bookingId,
          assignment_text: assignmentText,
          type: type || 'other',
          source: 'ai',
          status: 'assigned',
        }),
      });
      const inserted = await insertRes.json().catch(() => null);
      if (!insertRes.ok) {
        console.error('[approve-homework] client_homework insert failed:', inserted);
        return res.status(500).json({ error: 'Failed to insert homework', detail: inserted });
      }
      const id = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;

      const flip = await flipDraftHandled(bookingId, draftId);
      if (!flip.ok) {
        // Insert already landed — surface the partial failure but don't roll back.
        console.warn('[approve-homework] draft flip failed after insert:', flip.error);
        return res.status(200).json({ ok: true, action: 'approve', id, draft_flip_error: flip.error });
      }
      return res.status(200).json({ ok: true, action: 'approve', id });
    }

    // ── action: add (manual entry) ─────────────────────────────────────
    if (action === 'add') {
      if (!coachId || !clientEmail || !assignmentText) {
        return res.status(400).json({ error: 'Missing required fields: coachId, clientEmail, assignment_text' });
      }
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/client_homework`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          coach_id: coachId,
          client_email: clientEmail,
          booking_id: bookingId || null,
          assignment_text: assignmentText,
          type: type || 'other',
          source: 'manual',
          status: 'assigned',
        }),
      });
      const inserted = await insertRes.json().catch(() => null);
      if (!insertRes.ok) {
        console.error('[approve-homework] manual insert failed:', inserted);
        return res.status(500).json({ error: 'Failed to add homework', detail: inserted });
      }
      const id = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
      return res.status(200).json({ ok: true, action: 'add', id });
    }

    return res.status(400).json({ error: 'Unhandled action' });
  } catch (e) {
    console.error('[approve-homework] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
