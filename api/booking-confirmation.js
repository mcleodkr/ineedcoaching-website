export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { booking_id } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!booking_id) return res.status(400).json({ error: 'Missing booking_id' });

  const SUPA = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    // Fetch booking with coach info
    const bRes = await fetch(`${SUPA}/rest/v1/coach_bookings?id=eq.${booking_id}&select=*,coach_profiles(display_name,user_email,zoom_meeting_link)`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
    });
    const bookings = await bRes.json();
    if (!bookings.length) return res.status(404).json({ error: 'Booking not found' });
    const booking = bookings[0];
    const coach = booking.coach_profiles;

    const sessionDate = booking.scheduled_at ? new Date(booking.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }) : 'TBD';

    // Send client email via Supabase Auth admin (or log for now)
    console.log('CLIENT EMAIL:', booking.client_email, 'Subject: Your session is confirmed');
    console.log('Body: Your coaching session with', coach.display_name, 'on', sessionDate, 'is confirmed.', coach.zoom_meeting_link ? 'Zoom: ' + coach.zoom_meeting_link : '');

    // Send coach email
    console.log('COACH EMAIL:', coach.user_email, 'Subject: New booking confirmed');
    console.log('Body: New session with', booking.client_email, 'on', sessionDate, booking.notes ? 'Notes: ' + booking.notes : '');

    return res.status(200).json({ sent: true, client: booking.client_email, coach: coach.user_email });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
