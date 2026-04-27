// POST /api/send-sms-reminder { booking_id }
//
// Sends one SMS reminder for one booking via Twilio. Called by the
// /api/process-reminders cron orchestrator. The orchestrator owns
// idempotency via coach_bookings.sms_reminder_sent_at.
//
// SMS format (per PR 1.E spec):
//   "Hi! Your [SessionType] with [CoachName] starts at [Time]. Join: [ZoomLink]"
//
// Twilio call uses the REST API directly (no SDK) — same pattern as the
// legacy api/send-session-reminder.js scaffold so we keep the dependency
// surface minimal.

function formatTimeLabel(utcIso, tz) {
  if (!utcIso) return 'soon';
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return 'soon';
  try {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz || 'America/Chicago',
    });
  } catch (e) {
    return d.toISOString();
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
  const PLATFORM_TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured (supabase)' });
  if (!TWILIO_SID || !TWILIO_AUTH || !PLATFORM_TWILIO_PHONE) {
    return res.status(503).json({ error: 'twilio_not_configured' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const bookingId = body.booking_id;
    if (!bookingId) return res.status(400).json({ error: 'Missing booking_id' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
        + `?id=eq.${encodeURIComponent(bookingId)}`
        + `&select=id,client_phone,sms_opt_in,scheduled_at,zoom_link,service_name,`
        +   `coach_profiles(display_name,full_name,zoom_meeting_link,timezone,twilio_phone_number,sms_reminders_enabled),`
        +   `coach_services(title)`
        + `&limit=1`,
      { headers }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed', status: lookup.status });
    const rows = await lookup.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'booking_not_found' });
    if (!booking.client_phone) return res.status(200).json({ skipped: true, reason: 'no_phone' });
    if (!booking.sms_opt_in) return res.status(200).json({ skipped: true, reason: 'not_opted_in' });

    const coach = booking.coach_profiles || {};
    if (!coach.sms_reminders_enabled) {
      return res.status(200).json({ skipped: true, reason: 'coach_sms_disabled' });
    }

    const service = booking.coach_services || {};
    const sessionType = service.title || booking.service_name || 'session';
    const coachName = coach.display_name || coach.full_name || 'your coach';
    const timeLabel = formatTimeLabel(booking.scheduled_at, coach.timezone);
    const zoomLink = booking.zoom_link || coach.zoom_meeting_link || '';

    let messageBody = `Hi! Your ${sessionType} with ${coachName} starts at ${timeLabel}.`;
    if (zoomLink && /^https?:\/\//.test(zoomLink)) messageBody += ` Join: ${zoomLink}`;
    messageBody += ' — ineedcoaching.org';

    // Per-coach Twilio number override falls back to the platform sender.
    const fromNumber = coach.twilio_phone_number || PLATFORM_TWILIO_PHONE;

    const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: booking.client_phone,
        From: fromNumber,
        Body: messageBody,
      }),
    });
    const twData = await tw.json().catch(() => ({}));
    if (!tw.ok) {
      console.error('[send-sms-reminder] twilio failed', tw.status, twData && twData.message);
      return res.status(502).json({ error: 'twilio_failed', status: tw.status, message: twData && twData.message });
    }

    return res.status(200).json({ sent: true, booking_id: bookingId, sid: twData.sid });
  } catch (e) {
    console.error('[send-sms-reminder] error', e);
    return res.status(500).json({ error: e.message });
  }
}
