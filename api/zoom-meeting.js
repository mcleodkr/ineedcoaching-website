export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
  const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;

  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });
  if (!ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET || !ZOOM_ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing Zoom credentials (ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_ACCOUNT_ID)' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { booking_id } = body;
    if (!booking_id) return res.status(400).json({ error: 'Missing booking_id' });

    const SB_HEADERS = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    };

    // 1. Fetch booking with coach info
    const bRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${booking_id}&select=*,coach_profiles(display_name,user_email)`,
      { headers: SB_HEADERS }
    );
    const bookings = await bRes.json();
    if (!bookings || !bookings.length) return res.status(404).json({ error: 'Booking not found' });

    const booking = bookings[0];

    // Skip if booking already has a zoom link
    if (booking.zoom_link) {
      return res.status(200).json({ zoom_link: booking.zoom_link, already_exists: true });
    }

    const coach = booking.coach_profiles || {};
    const coachName = coach.display_name || 'Coach';
    const serviceName = booking.service_name || 'Coaching Session';
    const scheduledAt = booking.scheduled_at || new Date().toISOString();

    // 2. Get Zoom access token via Server-to-Server OAuth
    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + btoa(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`),
      },
      body: `grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    });

    if (!tokenRes.ok) {
      const tokenErr = await tokenRes.text();
      console.error('Zoom token error:', tokenRes.status, tokenErr);
      return res.status(502).json({ error: 'Failed to authenticate with Zoom' });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // 3. Create Zoom meeting
    const meetingRes = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        topic: `${serviceName} — ${coachName} | ineedcoaching.org`,
        type: 2, // Scheduled meeting
        start_time: scheduledAt,
        duration: 60,
        timezone: 'UTC',
        settings: {
          join_before_host: true,
          waiting_room: false,
          meeting_authentication: false,
          auto_recording: 'none',
        },
      }),
    });

    if (!meetingRes.ok) {
      const meetingErr = await meetingRes.text();
      console.error('Zoom meeting error:', meetingRes.status, meetingErr);
      return res.status(502).json({ error: 'Failed to create Zoom meeting' });
    }

    const meeting = await meetingRes.json();
    const joinUrl = meeting.join_url;

    // 4. Save zoom_link to coach_bookings
    await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${booking_id}`,
      {
        method: 'PATCH',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ zoom_link: joinUrl }),
      }
    );

    console.log(`=== ZOOM MEETING CREATED ===`);
    console.log(`Booking: ${booking_id}`);
    console.log(`Topic: ${serviceName} — ${coachName}`);
    console.log(`Join URL: ${joinUrl}`);
    console.log(`===`);

    return res.status(200).json({
      zoom_link: joinUrl,
      meeting_id: meeting.id,
      start_url: meeting.start_url,
    });
  } catch (e) {
    console.error('zoom-meeting error:', e);
    return res.status(500).json({ error: e.message });
  }
}
