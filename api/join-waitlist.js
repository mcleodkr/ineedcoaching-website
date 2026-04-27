// POST /api/join-waitlist
//   { coach_id, client_email, client_name?, service_id?,
//     requested_date?, requested_time?, notes? }
//
// Inserts a booking_waitlist row. Anonymous insert via service-role here
// (rather than the dashboard's anon-key insert) so we can de-dupe by
// (coach_id, client_email, service_id) — same person joining twice
// upserts in place rather than producing duplicates.

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
    const coachId = String(body.coach_id || '').trim();
    const clientEmail = String(body.client_email || '').trim().toLowerCase();
    const clientName = String(body.client_name || '').trim();
    const serviceId = String(body.service_id || '').trim();
    const requestedDate = String(body.requested_date || '').trim();
    const requestedTime = String(body.requested_time || '').trim();
    const notesText = String(body.notes || '').trim();
    if (!coachId || !clientEmail) return res.status(400).json({ error: 'Missing coach_id or client_email' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const writeHeaders = { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' };

    // De-dupe: if the same (coach, email, service) is already on the list,
    // refresh the joined_at + notes rather than insert a second row.
    let dupCheckUrl = `${SUPABASE_URL}/rest/v1/booking_waitlist`
      + `?coach_id=eq.${encodeURIComponent(coachId)}`
      + `&client_email=eq.${encodeURIComponent(clientEmail)}`
      + `&select=id&limit=1`;
    if (serviceId) dupCheckUrl += `&service_id=eq.${encodeURIComponent(serviceId)}`;
    else dupCheckUrl += `&service_id=is.null`;
    const dupRes = await fetch(dupCheckUrl, { headers });
    const dupRows = await dupRes.json();
    if (Array.isArray(dupRows) && dupRows.length) {
      const id = dupRows[0].id;
      await fetch(`${SUPABASE_URL}/rest/v1/booking_waitlist?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...writeHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          client_name: clientName || null,
          requested_date: requestedDate || null,
          requested_time: requestedTime || null,
          notes: notesText || null,
          joined_at: new Date().toISOString(),
          notified_at: null,
        }),
      });
      return res.status(200).json({ updated: true, id });
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/booking_waitlist`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        coach_id: coachId,
        client_email: clientEmail,
        client_name: clientName || null,
        service_id: serviceId || null,
        requested_date: requestedDate || null,
        requested_time: requestedTime || null,
        notes: notesText || null,
      }),
    });
    if (!insertRes.ok) {
      const t = await insertRes.text().catch(() => '');
      return res.status(500).json({ error: 'insert_failed', detail: t });
    }
    const rows = await insertRes.json();
    return res.status(200).json({ added: true, id: rows && rows[0] ? rows[0].id : null });
  } catch (e) {
    console.error('[join-waitlist] error', e);
    return res.status(500).json({ error: e.message });
  }
}
