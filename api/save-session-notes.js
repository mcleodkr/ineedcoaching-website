// Server-side endpoint to save session notes (bypasses RLS)
// POST { bookingId, coachId, clientEmail, notes, format, structuredNotes, shareWithClient }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('[save-session-notes] SUPABASE_SERVICE_ROLE_KEY not set');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { bookingId, coachId, clientEmail, notes, format, structuredNotes, shareWithClient, rawTranscript } = body;

    if (!bookingId || !coachId) {
      return res.status(400).json({ error: 'Missing bookingId or coachId' });
    }

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    // Check if notes exist for this booking
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${bookingId}&select=id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const existing = await checkRes.json();

    // Build payload — only include fields that were provided (don't overwrite existing fields with null)
    const payload = {
      booking_id: bookingId,
      coach_id: coachId,
      updated_at: new Date().toISOString()
    };
    if (clientEmail !== undefined) payload.client_email = clientEmail || null;
    if (notes !== undefined) payload.notes = notes || null;
    if (format !== undefined) payload.format = format || 'grow';
    if (structuredNotes !== undefined) payload.structured_notes = structuredNotes || null;
    if (shareWithClient !== undefined) payload.share_with_client = shareWithClient || false;
    if (rawTranscript !== undefined) payload.raw_transcript = rawTranscript || null;

    let saveRes;
    if (existing && existing.length > 0) {
      console.log('[save-session-notes] Updating existing note:', existing[0].id);
      saveRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_session_notes?id=eq.${existing[0].id}`,
        { method: 'PATCH', headers, body: JSON.stringify(payload) }
      );
    } else {
      console.log('[save-session-notes] Creating new note');
      saveRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_session_notes`,
        { method: 'POST', headers, body: JSON.stringify(payload) }
      );
    }

    if (!saveRes.ok) {
      const errText = await saveRes.text();
      console.error('[save-session-notes] Save failed:', saveRes.status, errText);
      return res.status(500).json({ error: 'Failed to save notes', details: errText });
    }

    console.log('[save-session-notes] Success');
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[save-session-notes] Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
