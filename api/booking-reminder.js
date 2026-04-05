export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const now = new Date();
    const from = new Date(now.getTime() + 23 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();

    const bRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?status=eq.confirmed&scheduled_at=gte.${from}&scheduled_at=lte.${to}&select=*,coach_profiles(display_name,user_email,zoom_meeting_link)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const bookings = await bRes.json();

    if (!Array.isArray(bookings) || !bookings.length) {
      return res.status(200).json({ sent: true, reminders: 0 });
    }

    const results = [];

    for (const booking of bookings) {
      const coach = booking.coach_profiles;
      const clientName = booking.client_name || booking.client_email;
      const coachName = coach.display_name || 'Your Coach';
      const serviceName = booking.service_name || 'Coaching Session';
      const sessionDate = booking.scheduled_at
        ? new Date(booking.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
        : 'TBD';
      const zoomLink = coach.zoom_meeting_link || booking.zoom_link || 'Will be provided before the session';

      // Client email
      const clientSubject = 'Your session is tomorrow';
      const clientBody = `Hi ${clientName},\n\nJust a reminder that your session with ${coachName} is tomorrow.\n\nService: ${serviceName}\nDate and Time: ${sessionDate}\nZoom Link: ${zoomLink}\n\nTake a few minutes tonight to think about what you want to focus on. You'll get more out of it.\n\nSee you tomorrow.\n\nThe ineedcoaching.org team`;

      console.log('=== CLIENT REMINDER EMAIL ===');
      console.log('To:', booking.client_email);
      console.log('Subject:', clientSubject);
      console.log('Body:', clientBody);

      // Coach email
      const coachSubject = `You have a session tomorrow with ${clientName}`;
      const coachBody = `Hi ${coachName},\n\nA reminder that ${clientName} has a session with you tomorrow.\n\nService: ${serviceName}\nDate and Time: ${sessionDate}\n\nTheir intake form responses are available in your dashboard if you'd like to review before the session.\n\nThe ineedcoaching.org team`;

      console.log('=== COACH REMINDER EMAIL ===');
      console.log('To:', coach.user_email);
      console.log('Subject:', coachSubject);
      console.log('Body:', coachBody);

      results.push({ client: booking.client_email, coach: coach.user_email });
    }

    return res.status(200).json({ sent: true, reminders: results.length, details: results });
  } catch (e) {
    console.error('booking-reminder error:', e);
    return res.status(500).json({ error: e.message });
  }
}
