// POST /api/booking-status { booking_id }  →  { booking: {...non-secret fields...} }
//
// Phase 3c: the public booking page polls a booking by id after Stripe payment
// to detect status='confirmed'. book.html used to read coach_bookings directly
// with the anon key; this moves that read server-side (service role) so RLS can
// be enabled. The booking_id (an unguessable uuid the booker just created) is the
// scoping key — there is no JWT on the public page.
//
// SECURITY: this is a booking_id-only read, so it returns ONLY non-secret fields.
// It MUST NEVER return reschedule_token (or any other secret) — the manage-link
// token is delivered through the booking-confirmation response instead. Fields
// here are the booker's own booking data + public coach/service info.

const SELECT = 'id,status,scheduled_at,zoom_link,client_email,service_name,service_price,'
  + 'coach_profiles(id,slug,display_name,full_name,timezone,zoom_meeting_link),'
  + 'coach_services(id,title,duration,price)';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const bookingId = body.booking_id;
    if (!bookingId) return res.status(400).json({ error: 'Missing booking_id' });

    const readRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}&select=${encodeURIComponent(SELECT)}&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!readRes.ok) {
      const t = await readRes.text().catch(() => '');
      console.error('[booking-status] read failed', readRes.status, t.slice(0, 200));
      return res.status(502).json({ error: 'Failed to load booking' });
    }
    const rows = await readRes.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    return res.status(200).json({ booking });
  } catch (e) {
    console.error('[booking-status] error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
}
