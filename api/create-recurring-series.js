// POST /api/create-recurring-series
//   { coach_id, client_email, client_name?, client_phone?, service_id,
//     start_iso, frequency: 'weekly'|'biweekly'|'monthly', total_sessions,
//     notes? }
//
// Creates a recurring_bookings parent row and generates the full series of
// coach_bookings — first occurrence at start_iso, each subsequent one at
// +7 / +14 / +1 month. Free-flow only (status='confirmed'). Paid recurring
// series can be added by branching on coach_services.price > 0 in a future
// PR; the current Phase 4 flow keeps recurring restricted to free types.

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
    const clientPhone = String(body.client_phone || '').trim();
    const serviceId = String(body.service_id || '').trim();
    const startIso = String(body.start_iso || '').trim();
    const frequency = String(body.frequency || 'weekly').trim();
    const totalSessions = Math.max(1, Math.min(52, parseInt(body.total_sessions, 10) || 4));
    const notesText = String(body.notes || '').trim();
    if (!coachId || !clientEmail || !serviceId || !startIso) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['weekly', 'biweekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency' });
    }
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) return res.status(400).json({ error: 'Invalid start_iso' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const writeHeaders = { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' };

    // Service lookup — need title + price (gate on free) + duration.
    const svcRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_services`
        + `?id=eq.${encodeURIComponent(serviceId)}`
        + `&select=id,title,duration,price,is_active&limit=1`,
      { headers }
    );
    const svcRows = await svcRes.json();
    const service = Array.isArray(svcRows) && svcRows[0];
    if (!service) return res.status(404).json({ error: 'service_not_found' });
    if (service.is_active === false) return res.status(409).json({ error: 'service_inactive' });
    if (Number(service.price || 0) > 0) {
      return res.status(409).json({ error: 'recurring_paid_not_supported' });
    }

    // Day-of-week + clock time for the recurring_bookings record. Computed
    // in the SERVER's local zone, which is UTC on Vercel — the client side
    // has already produced an ISO with the desired offset baked in.
    const dayOfWeek = start.getUTCDay();
    const hh = String(start.getUTCHours()).padStart(2, '0');
    const mm = String(start.getUTCMinutes()).padStart(2, '0');
    const timeOfDay = `${hh}:${mm}:00`;
    const startDate = start.toISOString().slice(0, 10);

    const parentInsert = await fetch(`${SUPABASE_URL}/rest/v1/recurring_bookings`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        coach_id: coachId,
        client_email: clientEmail,
        client_name: clientName || null,
        service_id: serviceId,
        start_date: startDate,
        day_of_week: dayOfWeek,
        time_of_day: timeOfDay,
        frequency: frequency,
        total_sessions: totalSessions,
        sessions_created: totalSessions,
        is_active: true,
      }),
    });
    if (!parentInsert.ok) {
      const t = await parentInsert.text().catch(() => '');
      return res.status(500).json({ error: 'parent_insert_failed', detail: t });
    }
    const parentRows = await parentInsert.json();
    const parent = Array.isArray(parentRows) && parentRows[0];
    if (!parent) return res.status(500).json({ error: 'parent_insert_returned_no_row' });

    // Generate child bookings.
    const noteLines = ['Name: ' + (clientName || clientEmail), 'Service: ' + (service.title || 'Coaching session')];
    if (notesText) { noteLines.push('', notesText); }
    const sessions = [];
    for (let i = 0; i < totalSessions; i++) {
      const slot = new Date(start.getTime());
      if (frequency === 'weekly') slot.setUTCDate(slot.getUTCDate() + i * 7);
      else if (frequency === 'biweekly') slot.setUTCDate(slot.getUTCDate() + i * 14);
      else slot.setUTCMonth(slot.getUTCMonth() + i); // monthly (calendar month)
      sessions.push({
        coach_id: coachId,
        client_email: clientEmail,
        client_name: clientName || null,
        client_phone: clientPhone || null,
        service_id: serviceId,
        service_name: service.title || 'Coaching Session',
        service_price: 0,
        scheduled_at: slot.toISOString(),
        notes: noteLines.join('\n'),
        status: 'confirmed',
        recurring_booking_id: parent.id,
      });
    }
    const childInsert = await fetch(`${SUPABASE_URL}/rest/v1/coach_bookings`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify(sessions),
    });
    if (!childInsert.ok) {
      const t = await childInsert.text().catch(() => '');
      return res.status(500).json({ error: 'children_insert_failed', detail: t });
    }
    const childRows = await childInsert.json();

    // Fire booking-confirmation for the FIRST session only (single email
    // covering the recurring schedule keeps the inbox clean).
    if (Array.isArray(childRows) && childRows[0]) {
      try {
        const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
        await fetch(`${origin}/api/booking-confirmation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_id: childRows[0].id }),
        });
      } catch (mailErr) {
        console.warn('[create-recurring-series] confirmation email failed', mailErr.message);
      }
    }

    return res.status(200).json({
      recurring_id: parent.id,
      sessions_created: childRows.length,
      first_booking_id: childRows[0] ? childRows[0].id : null,
    });
  } catch (e) {
    console.error('[create-recurring-series] error', e);
    return res.status(500).json({ error: e.message });
  }
}
