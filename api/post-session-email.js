// POST /api/post-session-email { booking_id }
//
// Sends one post-session email to the client: the homework they were assigned
// + the commitments they made this session, so they don't lose traction.
// Called by the /api/process-reminders cron orchestrator, which owns
// idempotency via coach_bookings.post_session_email_sent_at and only stamps
// it when this endpoint reports the email actually went out (sent:true) or the
// booking is a terminal skip (terminal:true). Modeled on api/booking-reminder.js.
//
// Content sources (both client-safe):
//   commitments — coach_session_notes.post_session_analysis.commitments[].text
//   homework    — client_homework rows for this booking, status='assigned'
// If neither exists yet (the coach hasn't run post-session analysis or approved
// homework), this returns { sent:false, terminal:false, reason:'not_ready' } so
// the orchestrator leaves the row unstamped and a later cron retries.

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Parse `Name: <name>` out of coach_bookings.notes — same regex used by
// booking-reminder, coach-mirror, intervention-plan-panel, and book.html.
function clientDisplayName(booking) {
  if (booking.client_name) return booking.client_name;
  const notes = booking.notes || '';
  const match = notes.match(/^Name:\s*(.+)/m);
  return match ? match[1].trim() : (booking.client_email || 'there');
}

function wrap(inner) {
  return `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">${inner}<p style="font-size:0.78rem;color:#6b6b60;margin-top:24px;">— The <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a> team</p></div>`;
}

function listBlock(title, items) {
  if (!items.length) return '';
  const lis = items.map((t) =>
    `<li style="margin:8px 0;font-size:0.92rem;line-height:1.55;color:#1a3a52;">${escapeHtml(t)}</li>`
  ).join('');
  return `
    <div style="background:#f7f4ee;border-radius:8px;padding:18px 22px;margin:18px 0;">
      <p style="margin:0 0 8px;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.1em;color:#c49a3c;font-weight:600;">${escapeHtml(title)}</p>
      <ul style="margin:0;padding-left:20px;">${lis}</ul>
    </div>`;
}

function buildEmail({ clientName, coachName, commitments, homework }) {
  const subject = `What you're carrying forward from your session with ${coachName}`;
  const html = wrap(`
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">Carrying this forward</h1>
    <p style="font-size:0.95rem;line-height:1.6;color:#1a3a52;">Hi ${escapeHtml(clientName)},</p>
    <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Here's what came out of your session with ${escapeHtml(coachName)} to keep close between now and next time.</p>
    ${listBlock('What you committed to', commitments)}
    ${listBlock('Your practice this week', homework)}
    <p style="font-size:0.9rem;line-height:1.6;color:#1a3a52;margin-top:24px;">One small step at a time — you might return to this whenever you need a nudge.</p>
    <p style="font-size:0.9rem;line-height:1.6;color:#1a3a52;margin-top:8px;">With you,<br>${escapeHtml(coachName)}</p>
  `);
  return { subject, html };
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

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // ── Booking + coach ──
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
        + `?id=eq.${encodeURIComponent(bookingId)}`
        + `&select=id,client_email,client_name,notes,coach_id,coach_profiles(display_name,full_name)`
        + `&limit=1`,
      { headers }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed', status: lookup.status });
    const rows = await lookup.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const coach = booking.coach_profiles || {};
    const coachName = coach.display_name || coach.full_name || 'Your Coach';
    const clientName = clientDisplayName(booking);

    // No client email is terminal — we can never send, so let the orchestrator
    // stamp the row and stop retrying.
    if (!booking.client_email) {
      return res.status(200).json({ sent: false, terminal: true, reason: 'no_client_email' });
    }

    // ── Commitments (from the post-session output for this booking) ──
    let commitments = [];
    try {
      const noteRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_session_notes?booking_id=eq.${encodeURIComponent(bookingId)}&select=post_session_analysis&limit=1`,
        { headers }
      );
      if (noteRes.ok) {
        const noteRows = await noteRes.json();
        const analysis = Array.isArray(noteRows) && noteRows[0] && noteRows[0].post_session_analysis;
        const raw = analysis && typeof analysis === 'object' && Array.isArray(analysis.commitments) ? analysis.commitments : [];
        commitments = raw
          .map((c) => (typeof c === 'string' ? c : (c && (c.text || c.title || c.commitment)) || ''))
          .map((t) => String(t).trim())
          .filter(Boolean);
      }
    } catch (e) {
      console.error('[post-session-email] commitments lookup failed', bookingId, e.message);
    }

    // ── Homework assigned this session ──
    let homework = [];
    try {
      const hwRes = await fetch(
        `${SUPABASE_URL}/rest/v1/client_homework`
          + `?coach_id=eq.${encodeURIComponent(booking.coach_id)}`
          + `&client_email=eq.${encodeURIComponent(booking.client_email)}`
          + `&booking_id=eq.${encodeURIComponent(bookingId)}`
          + `&status=eq.assigned`
          + `&select=assignment_text`,
        { headers }
      );
      if (hwRes.ok) {
        const hwRows = await hwRes.json();
        homework = (Array.isArray(hwRows) ? hwRows : [])
          .map((h) => (h && h.assignment_text ? String(h.assignment_text).trim() : ''))
          .filter(Boolean);
      }
    } catch (e) {
      console.error('[post-session-email] homework lookup failed', bookingId, e.message);
    }

    // Nothing to send yet — not an error. Leave unstamped so a later cron
    // retries once the coach has run analysis / approved homework.
    if (commitments.length === 0 && homework.length === 0) {
      return res.status(200).json({ sent: false, terminal: false, reason: 'not_ready' });
    }

    const { subject, html } = buildEmail({ clientName, coachName, commitments, homework });

    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const sendRes = await fetch(`${origin}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: booking.client_email, subject, html }),
    });
    if (!sendRes.ok) {
      const t = await sendRes.text().catch(() => '');
      console.error('[post-session-email] send-email failed', sendRes.status, t);
      return res.status(502).json({ sent: false, terminal: false, error: 'send_failed', status: sendRes.status });
    }

    return res.status(200).json({ sent: true, booking_id: bookingId, commitments: commitments.length, homework: homework.length });
  } catch (e) {
    console.error('[post-session-email] error', e);
    return res.status(500).json({ error: e.message });
  }
}
