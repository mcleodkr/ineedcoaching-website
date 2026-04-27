// POST /api/booking-reminder { booking_id, window: '48h'|'24h'|'1h' }
//
// Sends one email reminder for one booking + one window. Called by the
// /api/process-reminders cron orchestrator. Templates per the PR 1.E spec —
// the orchestrator owns idempotency (skipping rows whose *_sent_at is
// already populated) so this endpoint just sends.

const WINDOWS = new Set(['48h', '24h', '1h']);

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Format scheduled_at into coach-local labels. Falls back to UTC if no tz.
function formatScheduledLabels(utcIso, tz) {
  if (!utcIso) return { day: 'TBD', time: 'TBD', tzLabel: '' };
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return { day: 'TBD', time: 'TBD', tzLabel: '' };
  const opts = { timeZone: tz || 'America/Chicago' };
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', ...opts });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...opts });
  // Short tz label like 'CDT' / 'CST'. Falls back to the IANA name when the
  // short token isn't available.
  let tzLabel = '';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZoneName: 'short' });
    const parts = fmt.formatToParts(d);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    tzLabel = tzPart ? tzPart.value : (tz || '');
  } catch (e) {
    tzLabel = tz || '';
  }
  return { day, time, tzLabel };
}

// Parse `Name: <name>` out of coach_bookings.notes — same regex used by
// coach-mirror, intervention-plan-panel, and book.html. Falls back to the
// client_name column when present.
function clientDisplayName(booking) {
  if (booking.client_name) return booking.client_name;
  const notes = booking.notes || '';
  const match = notes.match(/^Name:\s*(.+)/m);
  return match ? match[1].trim() : (booking.client_email || 'there');
}

function buildEmail({ window, clientName, coachName, sessionDate, sessionTime, tzLabel, durationText, serviceName, zoomLink, paymentLine }) {
  const tzSuffix = tzLabel ? ` ${tzLabel}` : '';
  const zoomBlock = zoomLink && /^https?:\/\//.test(zoomLink)
    ? `<p style="margin:6px 0;font-size:0.9rem;">🔗 <strong>Join:</strong> <a href="${escapeHtml(zoomLink)}" style="color:#c49a3c;text-decoration:none;font-weight:600;">${escapeHtml(zoomLink)}</a></p>`
    : `<p style="margin:6px 0;font-size:0.9rem;color:#6b6b60;">Your join link will be shared when the session is closer.</p>`;

  if (window === '48h') {
    const subject = `Your coaching session with ${coachName} is in 2 days`;
    const html = wrap(`
      <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">Your session is in 2 days</h1>
      <p style="font-size:0.95rem;line-height:1.6;color:#1a3a52;">Hi ${escapeHtml(clientName)},</p>
      <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Heads up — you have a coaching session with ${escapeHtml(coachName)} in two days.</p>
      <div style="background:#f7f4ee;border-radius:8px;padding:20px;margin:20px 0;">
        <p style="margin:6px 0;font-size:0.9rem;">📅 <strong>Date:</strong> ${escapeHtml(sessionDate)}</p>
        <p style="margin:6px 0;font-size:0.9rem;">🕒 <strong>Time:</strong> ${escapeHtml(sessionTime)}${escapeHtml(tzSuffix)}</p>
        ${durationText ? `<p style="margin:6px 0;font-size:0.9rem;">⏱️ <strong>Duration:</strong> ${escapeHtml(durationText)}</p>` : ''}
        <p style="margin:6px 0;font-size:0.9rem;">📋 <strong>Session type:</strong> ${escapeHtml(serviceName)}</p>
        ${zoomBlock}
        ${paymentLine ? `<p style="margin:6px 0;font-size:0.9rem;">💳 ${escapeHtml(paymentLine)}</p>` : ''}
      </div>
      <p style="font-size:0.88rem;line-height:1.6;color:#6b6b60;">Need to reschedule? Just reply to this email.</p>
      <p style="font-size:0.9rem;line-height:1.6;color:#1a3a52;margin-top:24px;">Looking forward to our session,<br>${escapeHtml(coachName)}</p>
    `);
    return { subject, html };
  }

  if (window === '24h') {
    const subject = `Tomorrow: Your session with ${coachName} at ${sessionTime}`;
    const html = wrap(`
      <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">Your session is tomorrow</h1>
      <p style="font-size:0.95rem;line-height:1.6;color:#1a3a52;">Hi ${escapeHtml(clientName)},</p>
      <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Quick reminder — your coaching session is tomorrow.</p>
      <div style="background:#f7f4ee;border-radius:8px;padding:20px;margin:20px 0;">
        <p style="margin:6px 0;font-size:0.9rem;">📅 ${escapeHtml(sessionDate)} at ${escapeHtml(sessionTime)}${escapeHtml(tzSuffix)}</p>
        ${durationText ? `<p style="margin:6px 0;font-size:0.9rem;">⏱️ ${escapeHtml(durationText)} — ${escapeHtml(serviceName)}</p>` : `<p style="margin:6px 0;font-size:0.9rem;">${escapeHtml(serviceName)}</p>`}
        ${zoomBlock}
      </div>
      <p style="font-size:0.9rem;line-height:1.6;color:#1a3a52;margin-top:24px;">See you tomorrow,<br>${escapeHtml(coachName)}</p>
    `);
    return { subject, html };
  }

  // 1h
  const subject = `Starting soon: Your session with ${coachName}`;
  const html = wrap(`
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">Your session starts in 1 hour</h1>
    <p style="font-size:0.95rem;line-height:1.6;color:#1a3a52;">Hi ${escapeHtml(clientName)},</p>
    <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Your coaching session starts in about an hour.</p>
    <div style="background:#f7f4ee;border-radius:8px;padding:20px;margin:20px 0;">
      <p style="margin:6px 0;font-size:0.9rem;">📅 Today at ${escapeHtml(sessionTime)}${escapeHtml(tzSuffix)}</p>
      ${zoomBlock}
    </div>
    <p style="font-size:0.9rem;line-height:1.6;color:#1a3a52;margin-top:24px;">See you soon,<br>${escapeHtml(coachName)}</p>
  `);
  return { subject, html };
}

function wrap(inner) {
  return `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">${inner}<p style="font-size:0.78rem;color:#6b6b60;margin-top:24px;">— The <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a> team</p></div>`;
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
    const win = body.window;
    if (!bookingId) return res.status(400).json({ error: 'Missing booking_id' });
    if (!WINDOWS.has(win)) return res.status(400).json({ error: 'Invalid window (expected 48h, 24h, or 1h)' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
        + `?id=eq.${encodeURIComponent(bookingId)}`
        + `&select=id,client_email,client_name,client_phone,scheduled_at,notes,zoom_link,service_name,payment_amount_cents,`
        +   `coach_profiles(display_name,full_name,user_email,zoom_meeting_link,timezone),`
        +   `coach_services(title,duration)`
        + `&limit=1`,
      { headers }
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
    const clientName = clientDisplayName(booking);
    const serviceName = service.title || booking.service_name || 'Coaching Session';
    const durationText = (service.duration || '').toString().trim();
    const zoomLink = booking.zoom_link || coach.zoom_meeting_link || '';
    let paymentLine = '';
    if (win === '48h') {
      const cents = Number(booking.payment_amount_cents || 0);
      if (cents > 0) paymentLine = `Payment confirmed: $${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
    }

    const { subject, html } = buildEmail({
      window: win,
      clientName,
      coachName,
      sessionDate: labels.day,
      sessionTime: labels.time,
      tzLabel: labels.tzLabel,
      durationText,
      serviceName,
      zoomLink,
      paymentLine,
    });

    if (!booking.client_email) {
      return res.status(200).json({ skipped: true, reason: 'no_client_email' });
    }

    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const sendRes = await fetch(`${origin}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: booking.client_email, subject, html }),
    });
    if (!sendRes.ok) {
      const t = await sendRes.text().catch(() => '');
      console.error('[booking-reminder] send-email failed', sendRes.status, t);
      return res.status(502).json({ error: 'send_failed', status: sendRes.status });
    }

    return res.status(200).json({ sent: true, booking_id: bookingId, window: win });
  } catch (e) {
    console.error('[booking-reminder] error', e);
    return res.status(500).json({ error: e.message });
  }
}
