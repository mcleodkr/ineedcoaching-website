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
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${booking_id}&select=*,coach_profiles(display_name,user_email,zoom_meeting_link,slug)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const bookings = await bRes.json();
    if (!bookings.length) return res.status(404).json({ error: 'Booking not found' });

    const booking = bookings[0];
    const coach = booking.coach_profiles;
    const clientName = booking.client_name || booking.client_email;
    const coachName = coach.display_name || 'Your Coach';
    const serviceName = booking.service_name || 'Coaching Session';
    const sessionDate = booking.scheduled_at
      ? new Date(booking.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
      : 'TBD';
    const notes = booking.notes || 'None';

    // Generate Zoom meeting if no link exists yet
    let zoomLink = booking.zoom_link || coach.zoom_meeting_link || '';
    if (!zoomLink) {
      try {
        const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
        const zoomRes = await fetch(`${origin}/api/zoom-meeting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_id }),
        });
        if (zoomRes.ok) {
          const zoomData = await zoomRes.json();
          zoomLink = zoomData.zoom_link || '';
        }
      } catch (zoomErr) {
        console.log('Zoom meeting creation skipped:', zoomErr.message);
      }
    }
    if (!zoomLink) zoomLink = 'Will be provided before the session';

    // Client email
    const clientSubject = `Your session with ${coachName} is confirmed`;
    const clientBody = `Hi ${clientName},\n\nYour coaching session is confirmed.\n\nCoach: ${coachName}\nService: ${serviceName}\nDate and Time: ${sessionDate}\nZoom Link: ${zoomLink}\n\nIf you need to reschedule, reply to this email.\n\nWe're glad you're here.\n\nThe ineedcoaching.org team`;

    console.log('=== CLIENT EMAIL ===');
    console.log('To:', booking.client_email);
    console.log('Subject:', clientSubject);
    console.log('Body:', clientBody);

    // Coach email
    const coachSubject = `New booking request from ${clientName}`;
    const coachBody = `Hi ${coachName},\n\nYou have a new booking request.\n\nClient: ${clientName}\nService: ${serviceName}\nRequested Date: ${sessionDate}\nNotes: ${notes}\n\nLog in to your dashboard to confirm or decline.\nhttps://www.ineedcoaching.org/coach-dashboard.html\n\nThe ineedcoaching.org team`;

    console.log('=== COACH EMAIL ===');
    console.log('To:', coach.user_email);
    console.log('Subject:', coachSubject);
    console.log('Body:', coachBody);

    return res.status(200).json({ sent: true, to: booking.client_email, subject: clientSubject });
  } catch (e) {
    console.error('booking-confirmation error:', e);
    return res.status(500).json({ error: e.message });
  }
}
