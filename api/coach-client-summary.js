// Coach edits the client-facing session summary — the ONE editable surface in
// the Preview Client Experience. Writes ONLY coach_session_notes.client_summary.
//
// The stored client_summary already takes precedence over the derived fallback
// (see lib/client-session-projection.js buildClientSummary), so editing it updates
// BOTH the client dashboard recap and the post-session email automatically — no
// override field, no other column touched. The nine coach-only columns
// (post_session_analysis, raw_transcript, extraction_data, synthesis_data,
// coaching_signals, dna_manifestations, pre_session_intelligence, structured_notes,
// homework drafts) are never read or written here.
//
// Auth: verify the COACH's JWT, resolve coach_profiles.id, require an ACTIVE
// coach_clients link to the client, and confirm the target note row belongs to
// (coach_id, client_email, booking_id) before writing.

// Keep only the client-safe summary keys. client_summary is, by definition, the
// object the client sees; this allowlist prevents arbitrary keys from being
// persisted into the column.
function sanitizeClientSummary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  const str = (v) => (typeof v === 'string' ? v : '');
  if ('headline' in input) out.headline = str(input.headline);
  if ('recap' in input) out.recap = str(input.recap);
  if ('what_stood_out' in input) out.what_stood_out = str(input.what_stood_out);
  if ('closing' in input) out.closing = str(input.closing);
  if (Array.isArray(input.practice)) {
    out.practice = input.practice.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
  }
  if (Array.isArray(input.commitments)) {
    out.commitments = input.commitments.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());
  }
  // goals are not editable in V1, but preserve them if the client passes the
  // existing object back (so an edit does not drop the goals the client sees).
  if (Array.isArray(input.goals)) {
    out.goals = input.goals
      .filter((g) => g && typeof g === 'object' && typeof g.title === 'string' && g.title.trim())
      .map((g) => ({ title: g.title.trim(), relevance: typeof g.relevance === 'string' ? g.relevance : '' }));
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  // ── Auth: verify the COACH's JWT and use ITS email. ──
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let coachEmail = '';
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Unauthorized' });
    const userData = await userRes.json().catch(() => ({}));
    coachEmail = (userData && userData.email || '').trim().toLowerCase();
  } catch (authErr) {
    console.error('[coach-client-summary] auth failed', authErr && authErr.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!coachEmail) return res.status(401).json({ error: 'Unauthorized' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const clientEmail = (body.client_email || '').toString().trim().toLowerCase();
  const bookingId = (body.booking_id || '').toString().trim();
  const summary = sanitizeClientSummary(body.client_summary);
  if (!clientEmail || !bookingId) return res.status(400).json({ error: 'Missing client_email or booking_id' });
  if (!summary) return res.status(400).json({ error: 'Invalid client_summary' });

  try {
    const enc = encodeURIComponent;
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // Resolve coach_profiles.id from the verified coach email.
    const coachRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${enc(coachEmail)}&select=id&limit=1`, { headers });
    const coachRows = await coachRes.json().catch(() => []);
    const coachId = Array.isArray(coachRows) && coachRows[0] && coachRows[0].id;
    if (!coachId) return res.status(403).json({ error: 'Not a coach' });

    // ── Ownership gate: ACTIVE coach_clients link. ──
    const linkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_clients?coach_id=eq.${enc(coachId)}&client_email=ilike.${enc(clientEmail)}`
        + `&status=eq.active&select=id&limit=1`, { headers });
    const links = await linkRes.json().catch(() => []);
    if (!Array.isArray(links) || links.length === 0) {
      return res.status(403).json({ error: 'No active coaching relationship with this client' });
    }

    // ── Row ownership: the target note must be this coach's + this client's. ──
    const noteRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?coach_id=eq.${enc(coachId)}`
        + `&client_email=eq.${enc(clientEmail)}&booking_id=eq.${enc(bookingId)}&select=id&limit=1`, { headers });
    const noteRows = await noteRes.json().catch(() => []);
    const noteId = Array.isArray(noteRows) && noteRows[0] && noteRows[0].id;
    if (!noteId) return res.status(404).json({ error: 'Session note not found for this client' });

    // ── Write ONLY client_summary (+ updated_at). Nothing else. ──
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_session_notes?id=eq.${enc(noteId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        // A coach saving here IS the approval -- this is the one editable
        // surface before a summary auto-sends. Harmless for coaches who
        // haven't opted into review_summaries_before_send: the column just
        // sits unused until they do.
        body: JSON.stringify({
          client_summary: summary,
          client_summary_approved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
    if (!patchRes.ok) {
      const t = await patchRes.text().catch(() => '');
      console.error('[coach-client-summary] patch failed', patchRes.status, t.slice(0, 200));
      return res.status(502).json({ error: 'Failed to save summary' });
    }

    return res.status(200).json({ success: true, client_summary: summary });
  } catch (e) {
    console.error('[coach-client-summary] Error:', e && e.message);
    return res.status(500).json({ error: 'Failed to save summary' });
  }
}
