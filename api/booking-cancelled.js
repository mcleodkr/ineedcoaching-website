export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const { booking_id } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!booking_id) return res.status(400).json({ error: 'Missing booking_id' });

    const bRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${booking_id}&select=*,coach_profiles(display_name,user_email,slug)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const bookings = await bRes.json();
    if (!bookings.length) return res.status(404).json({ error: 'Booking not found' });

    const booking = bookings[0];
    const coach = booking.coach_profiles;
    const clientName = booking.client_name || booking.client_email;
    const coachName = coach.display_name || 'Your Coach';
    const coachSlug = coach.slug || '';
    const sessionDate = booking.scheduled_at
      ? new Date(booking.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
      : 'the scheduled date';

    // Client email
    const clientSubject = 'Your session has been cancelled';
    const clientBody = `Hi ${clientName},\n\nYour session with ${coachName} on ${sessionDate} has been cancelled.\n\nIf you'd like to reschedule, visit their profile and request a new time. They would love to connect with you when the timing works.\n\nhttps://www.ineedcoaching.org/coach/${coachSlug}\n\nThe ineedcoaching.org team`;

    console.log('=== CLIENT CANCELLATION EMAIL ===');
    console.log('To:', booking.client_email);
    console.log('Subject:', clientSubject);
    console.log('Body:', clientBody);

    // Coach email
    const coachSubject = 'A session has been cancelled';
    const coachBody = `Hi ${coachName},\n\n${clientName}'s session on ${sessionDate} has been cancelled.\n\nYou can view your upcoming bookings anytime in your dashboard.\nhttps://www.ineedcoaching.org/coach-dashboard.html\n\nThe ineedcoaching.org team`;

    console.log('=== COACH CANCELLATION EMAIL ===');
    console.log('To:', coach.user_email);
    console.log('Subject:', coachSubject);
    console.log('Body:', coachBody);

    return res.status(200).json({ sent: true, to: booking.client_email, subject: clientSubject });
  } catch (e) {
    console.error('booking-cancelled error:', e);
    return res.status(500).json({ error: e.message });
  }
}
