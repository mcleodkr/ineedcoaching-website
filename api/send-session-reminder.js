// Scaffold for session reminder SMS via Twilio
// Intended to run via Vercel cron or Supabase edge function
// Checks coach_bookings for confirmed sessions within reminder windows
// Sends SMS via Twilio API

export default async function handler(req, res) {
  const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_PHONE) {
    return res.status(200).json({ message: 'Twilio not configured — skipping reminders' });
  }

  try {
    // Fetch confirmed bookings in the next 25 hours
    const now = new Date();
    const soon = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const bookingsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?status=eq.confirmed&scheduled_at=gte.${now.toISOString()}&scheduled_at=lte.${soon.toISOString()}&select=id,client_phone,client_email,scheduled_at,coach_id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const bookings = await bookingsRes.json();

    let sent = 0;
    for (const booking of bookings) {
      if (!booking.client_phone) continue;

      const sessionTime = new Date(booking.scheduled_at);
      const hoursUntil = (sessionTime - now) / (1000 * 60 * 60);

      // Send 24-hour reminder (between 23-25 hours)
      // Send 1-hour reminder (between 0.5-1.5 hours)
      let message = null;
      if (hoursUntil >= 23 && hoursUntil <= 25) {
        message = `Reminder: You have a coaching session tomorrow at ${sessionTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. — ineedcoaching.org`;
      } else if (hoursUntil >= 0.5 && hoursUntil <= 1.5) {
        message = `Your coaching session starts in about 1 hour. See you soon! — ineedcoaching.org`;
      }

      if (message) {
        try {
          await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
            method: 'POST',
            headers: {
              Authorization: 'Basic ' + btoa(TWILIO_SID + ':' + TWILIO_AUTH),
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
              To: booking.client_phone,
              From: TWILIO_PHONE,
              Body: message
            })
          });
          sent++;
        } catch (e) {
          console.log('SMS failed for', booking.id, e.message);
        }
      }
    }

    return res.status(200).json({ checked: bookings.length, sent });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
