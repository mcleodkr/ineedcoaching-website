// POST /api/booking-cancelled { booking_id }
//
// Sends the cancellation email to the client (and a parallel notice to the
// coach) via /api/send-email. Called by coach-dashboard.html when a coach
// hits the Cancel action in the calendar event modal (PR 2.A).
//
// Status patch on coach_bookings happens client-side BEFORE this endpoint
// fires; this endpoint only reads the booking and sends mail. Idempotent
// from the email side — Resend will accept multiple sends, and the
// coach UI guards against double-clicks via the modal close.

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
        + `&select=id,client_email,client_name,scheduled_at,notes,service_name,payment_amount_cents,refund_id,refund_amount_cents,refund_status,`
        +   `coach_profiles(display_name,full_name,user_email,slug,timezone),`
        +   `coach_services(title)`
        + `&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed', status: lookup.status });
    const rows = await lookup.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const coach = booking.coach_profiles || {};
    const service = booking.coach_services || {};
    const tz = coach.timezone || 'America/Chicago';
    const labels = formatScheduledLabels(booking.scheduled_at, tz);
    const coachName = coach.display_name || coach.full_name || 'Your Coach';
    const coachSlug = coach.slug || '';
    const clientName = clientDisplayName(booking);
    const serviceName = service.title || booking.service_name || 'Coaching Session';
    const paid = Number(booking.payment_amount_cents || 0) > 0;
    // Refund line surfaces ONLY when /api/process-refund landed and stamped
    // the row. cancelBooking in coach-dashboard.html runs the refund call
    // before this endpoint, so by the time we read the booking those
    // columns are populated for paid sessions. For paid bookings without
    // a successful refund (refund failed, manual handling needed), we fall
    // back to the softer 'will be processed' line so the client doesn't
    // wonder where their money went.
    const hasRefund = !!booking.refund_id && Number(booking.refund_amount_cents || 0) > 0;
    const refundDollars = hasRefund ? (booking.refund_amount_cents / 100).toFixed(2).replace(/\.00$/, '') : null;

    const clientSubject = `Your session with ${coachName} has been cancelled`;
    const clientHtml = `
      <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.8rem;color:#1a3a52;margin-bottom:16px;">Session Cancelled</h1>
        <p style="font-size:0.95rem;line-height:1.6;">Hi ${escapeHtml(clientName)},</p>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Your coaching session with ${escapeHtml(coachName)} has been cancelled.</p>
        <div style="background:#f7f4ee;border-radius:8px;padding:20px;margin:20px 0;">
          <p style="margin:6px 0;font-size:0.9rem;"><strong>Session:</strong> ${escapeHtml(serviceName)}</p>
          <p style="margin:6px 0;font-size:0.9rem;"><strong>Was scheduled for:</strong> ${escapeHtml(labels.day)} at ${escapeHtml(labels.time)}</p>
          ${hasRefund
            ? `<p style="margin:6px 0;font-size:0.9rem;color:#4a7c59;">💳 A full refund of $${escapeHtml(refundDollars)} has been processed to your original payment method. It may take 5–10 business days to appear on your statement.</p>`
            : (paid ? `<p style="margin:6px 0;font-size:0.9rem;color:#4a7c59;">💳 Your refund is being processed by ${escapeHtml(coachName)}'s practice. Reach out if you don't see it within 10 business days.</p>` : '')}
        </div>
        <p style="font-size:0.88rem;line-height:1.6;color:#6b6b60;">If you'd like to reschedule, <a href="https://www.ineedcoaching.org/book?coach=${encodeURIComponent(coachSlug)}" style="color:#c49a3c;text-decoration:none;font-weight:600;">book another session here</a>.</p>
        <p style="font-size:0.78rem;color:#6b6b60;margin-top:24px;">— The <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a> team</p>
      </div>
    `;

    const coachSubject = `Cancellation: ${clientName} on ${labels.day}`;
    const coachHtml = `
      <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">A session has been cancelled</h1>
        <p style="font-size:0.95rem;line-height:1.6;">Hi ${escapeHtml(coachName)},</p>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">${escapeHtml(clientName)}'s session has been marked cancelled in your dashboard.</p>
        <div style="background:#f7f4ee;border-radius:8px;padding:20px;margin:20px 0;">
          <p style="margin:6px 0;font-size:0.9rem;"><strong>Client:</strong> ${escapeHtml(clientName)}</p>
          <p style="margin:6px 0;font-size:0.9rem;"><strong>Session:</strong> ${escapeHtml(serviceName)}</p>
          <p style="margin:6px 0;font-size:0.9rem;"><strong>Was scheduled for:</strong> ${escapeHtml(labels.day)} at ${escapeHtml(labels.time)}</p>
        </div>
        <p style="font-size:0.85rem;color:#6b6b60;"><a href="https://www.ineedcoaching.org/coach-dashboard.html" style="color:#c49a3c;text-decoration:none;font-weight:600;">Open dashboard &rarr;</a></p>
      </div>
    `;

    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const sends = await Promise.allSettled([
      booking.client_email ? fetch(`${origin}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: booking.client_email, subject: clientSubject, html: clientHtml }),
      }) : Promise.resolve({ ok: true }),
      coach.user_email ? fetch(`${origin}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: coach.user_email, subject: coachSubject, html: coachHtml }),
      }) : Promise.resolve({ ok: true }),
    ]);
    const clientFailed = sends[0].status === 'rejected';
    const coachFailed = sends[1].status === 'rejected';
    if (clientFailed) console.error('[booking-cancelled] client send failed', sends[0].reason);
    if (coachFailed) console.error('[booking-cancelled] coach send failed', sends[1].reason);

    return res.status(200).json({
      sent: !clientFailed,
      client_email: booking.client_email,
      coach_email: coach.user_email || null,
    });
  } catch (e) {
    console.error('[booking-cancelled] error', e);
    return res.status(500).json({ error: e.message });
  }
}
