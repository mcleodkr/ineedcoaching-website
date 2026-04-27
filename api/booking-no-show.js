// POST /api/booking-no-show { booking_id }
//
// Sends a "we missed you" email to the client when a coach marks a session
// no-show from the calendar event modal (PR 2.A). Status patch on
// coach_bookings happens client-side before this endpoint fires; this
// endpoint only reads the booking and sends mail.

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatScheduledLabels(utcIso, tz) {
  if (!utcIso) return { day: 'TBD', time: 'TBD' };
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return { day: 'TBD', time: 'TBD' };
  const opts = { timeZone: tz || 'America/Chicago' };
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', ...opts });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...opts });
  return { day, time };
}

function clientDisplayName(booking) {
  if (booking.client_name) return booking.client_name;
  const notes = booking.notes || '';
  const m = notes.match(/^Name:\s*(.+)/m);
  return m ? m[1].trim() : (booking.client_email || 'there');
}

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
    const bookingId = body.booking_id;
    if (!bookingId) return res.status(400).json({ error: 'Missing booking_id' });

    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
        + `?id=eq.${encodeURIComponent(bookingId)}`
        + `&select=id,client_email,client_name,scheduled_at,notes,service_name,`
        +   `coach_profiles(display_name,full_name,slug,timezone),`
        +   `coach_services(title)`
        + `&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed', status: lookup.status });
    const rows = await lookup.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.client_email) return res.status(200).json({ skipped: true, reason: 'no_client_email' });

    const coach = booking.coach_profiles || {};
    const service = booking.coach_services || {};
    const tz = coach.timezone || 'America/Chicago';
    const labels = formatScheduledLabels(booking.scheduled_at, tz);
    const coachName = coach.display_name || coach.full_name || 'Your Coach';
    const coachSlug = coach.slug || '';
    const clientName = clientDisplayName(booking);
    const serviceName = service.title || booking.service_name || 'Coaching Session';

    const subject = `Missed session with ${coachName}`;
    const html = `
      <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.8rem;color:#1a3a52;margin-bottom:16px;">We missed you</h1>
        <p style="font-size:0.95rem;line-height:1.6;">Hi ${escapeHtml(clientName)},</p>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">You had a scheduled session with ${escapeHtml(coachName)} that you didn't attend.</p>
        <div style="background:#f7f4ee;border-radius:8px;padding:20px;margin:20px 0;">
          <p style="margin:6px 0;font-size:0.9rem;"><strong>Session:</strong> ${escapeHtml(serviceName)}</p>
          <p style="margin:6px 0;font-size:0.9rem;"><strong>Time:</strong> ${escapeHtml(labels.day)} at ${escapeHtml(labels.time)}</p>
        </div>
        <p style="font-size:0.88rem;line-height:1.6;color:#6b6b60;">Life happens. If you'd like to reschedule, <a href="https://www.ineedcoaching.org/book?coach=${encodeURIComponent(coachSlug)}" style="color:#c49a3c;text-decoration:none;font-weight:600;">book another session here</a>.</p>
        <p style="font-size:0.78rem;color:#6b6b60;margin-top:24px;">— The <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a> team</p>
      </div>
    `;

    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const sendRes = await fetch(`${origin}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: booking.client_email, subject, html }),
    });
    if (!sendRes.ok) {
      const t = await sendRes.text().catch(() => '');
      console.error('[booking-no-show] send-email failed', sendRes.status, t);
      return res.status(502).json({ error: 'send_failed', status: sendRes.status });
    }

    return res.status(200).json({ sent: true, to: booking.client_email });
  } catch (e) {
    console.error('[booking-no-show] error', e);
    return res.status(500).json({ error: e.message });
  }
}
