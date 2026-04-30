// POST /api/booking-cancel-self { booking_id, token }
//
// Client self-serve cancellation (Brief 1). Validates the reschedule_token,
// runs the existing /api/process-refund pipeline (which already does
// policy-aware fee math), patches status='cancelled' and fires the
// existing /api/booking-cancelled email. On Stripe refund failure for a
// paid booking, the row is left as 'confirmed' with needs_manual_review=true
// and the coach gets an action-required email — never a half-cancelled state.
//
// Why split from /api/process-refund: that endpoint accepts only booking_id
// and uses the service-role key. Exposing it directly to anonymous clients
// would let anyone refund any booking. This endpoint adds the token gate.

function tokensEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

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
  return m ? m[1].trim() : (booking.client_email || 'a client');
}

async function sendCoachActionRequired({ origin, coach, booking, attemptedRefundCents, errorReason }) {
  if (!coach || !coach.user_email) return;
  const tz = coach.timezone || 'America/Chicago';
  const labels = formatScheduledLabels(booking.scheduled_at, tz);
  const coachName = coach.display_name || coach.full_name || 'Coach';
  const clientName = clientDisplayName(booking);
  const refundDollars = (Number(attemptedRefundCents || 0) / 100).toFixed(2).replace(/\.00$/, '');
  // Sanitize the Stripe error — strip raw stack-style content, keep one line.
  const safeReason = String(errorReason || 'unknown error').split('\n')[0].slice(0, 240);
  const dashboardUrl = `https://www.ineedcoaching.org/coach-dashboard.html?booking=${encodeURIComponent(booking.id)}`;
  const subject = `Action required: cancellation failed for ${clientName} (${labels.day})`;
  const html = `
    <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
      <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.5rem;color:#1a3a52;margin-bottom:14px;">Action required: cancellation failed</h1>
      <p style="font-size:0.95rem;line-height:1.6;">Hi ${escapeHtml(coachName)},</p>
      <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">${escapeHtml(clientName)} tried to cancel their session, but the refund didn't go through. The booking is still marked as confirmed and is flagged in your dashboard for manual handling.</p>
      <div style="background:#fdf6e7;border-left:3px solid #c49a3c;border-radius:8px;padding:18px 20px;margin:20px 0;">
        <p style="margin:6px 0;font-size:0.9rem;"><strong>Booking ID:</strong> ${escapeHtml(booking.id)}</p>
        <p style="margin:6px 0;font-size:0.9rem;"><strong>Client:</strong> ${escapeHtml(clientName)}${booking.client_email ? ` &lt;${escapeHtml(booking.client_email)}&gt;` : ''}</p>
        <p style="margin:6px 0;font-size:0.9rem;"><strong>Session:</strong> ${escapeHtml(labels.day)} at ${escapeHtml(labels.time)}</p>
        <p style="margin:6px 0;font-size:0.9rem;"><strong>Attempted refund:</strong> $${escapeHtml(refundDollars)}</p>
        <p style="margin:6px 0;font-size:0.9rem;"><strong>Reason:</strong> ${escapeHtml(safeReason)}</p>
      </div>
      <p style="font-size:0.88rem;line-height:1.6;color:#1a3a52;">Please review and either issue the refund manually in Stripe or reach out to ${escapeHtml(clientName)} directly.</p>
      <p style="font-size:0.85rem;color:#6b6b60;margin-top:18px;"><a href="${dashboardUrl}" style="color:#c49a3c;text-decoration:none;font-weight:600;">Open this booking in your dashboard &rarr;</a></p>
      <p style="font-size:0.78rem;color:#6b6b60;margin-top:24px;">— ineedcoaching.org</p>
    </div>
  `;
  try {
    await fetch(`${origin}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: coach.user_email, subject, html }),
    });
  } catch (mailErr) {
    console.error('[booking-cancel-self] coach action-required email failed', mailErr);
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
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const writeHeaders = { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const bookingId = body.booking_id;
    const token = body.token;
    if (!bookingId || !token) return res.status(400).json({ error: 'missing_params' });

    // Re-fetch with the same gates as cancel-preview. We don't trust the
    // client's earlier preview — token still has to validate here.
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
        + `?id=eq.${encodeURIComponent(bookingId)}`
        + `&select=id,status,scheduled_at,payment_amount_cents,stripe_payment_intent_id,reschedule_token,reschedule_token_expires_at,client_email,client_name,notes,`
        +   `coach_profiles(id,display_name,full_name,user_email,timezone)`
        + `&limit=1`,
      { headers }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed' });
    const rows = await lookup.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'not_found' });

    if (!booking.reschedule_token || !tokensEq(booking.reschedule_token, token)) {
      return res.status(403).json({ error: 'invalid_token' });
    }
    const tokenExpiresAt = booking.reschedule_token_expires_at
      ? new Date(booking.reschedule_token_expires_at).getTime()
      : 0;
    const sessionAt = booking.scheduled_at ? new Date(booking.scheduled_at).getTime() : 0;
    const now = Date.now();
    if (tokenExpiresAt && tokenExpiresAt < now) return res.status(410).json({ error: 'token_expired' });
    if (sessionAt && sessionAt < now) return res.status(410).json({ error: 'session_in_past' });
    if (booking.status && booking.status !== 'confirmed' && booking.status !== 'manual') {
      return res.status(409).json({ error: 'not_cancelable', current_status: booking.status });
    }

    const isPaid = !!booking.stripe_payment_intent_id && Number(booking.payment_amount_cents || 0) > 0;

    // For paid bookings, refund FIRST. If it fails, we leave the booking
    // confirmed and flag for manual review — the half-cancelled state the
    // brief explicitly forbids never happens.
    let refundResult = null;
    if (isPaid) {
      try {
        const refundRes = await fetch(`${origin}/api/process-refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_id: bookingId }),
        });
        if (!refundRes.ok) {
          const errBody = await refundRes.text().catch(() => '');
          throw new Error(`refund_endpoint_${refundRes.status}: ${errBody.slice(0, 200)}`);
        }
        refundResult = await refundRes.json().catch(() => ({}));
      } catch (refundErr) {
        console.error('[booking-cancel-self] refund failed, flagging for manual review', refundErr);
        // Re-fetch once: if process-refund stamped refund_id mid-failure
        // (Stripe success but our PATCH failed), we'd double-refund on
        // retry. Idempotency handled by process-refund itself, but the
        // flag-and-bail path here only fires when we have NO refund record.
        const recheck = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}&select=refund_id&limit=1`,
          { headers }
        );
        let alreadyRefunded = false;
        if (recheck.ok) {
          const recheckRows = await recheck.json();
          alreadyRefunded = !!(recheckRows && recheckRows[0] && recheckRows[0].refund_id);
        }
        if (!alreadyRefunded) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}`,
            {
              method: 'PATCH',
              headers: writeHeaders,
              body: JSON.stringify({ needs_manual_review: true }),
            }
          );
          await sendCoachActionRequired({
            origin,
            coach: booking.coach_profiles || {},
            booking,
            attemptedRefundCents: Number(booking.payment_amount_cents || 0),
            errorReason: refundErr.message || String(refundErr),
          });
          const coachEmail = (booking.coach_profiles && booking.coach_profiles.user_email) || '';
          return res.status(502).json({
            error: 'refund_failed',
            needs_manual_review: true,
            coach_email: coachEmail,
            // Client-facing message — book.html surfaces this verbatim.
            message: coachEmail
              ? `We couldn't process your cancellation automatically. Please contact your coach directly at ${coachEmail} to cancel this session.`
              : `We couldn't process your cancellation automatically. Please reply to your booking confirmation email to cancel this session.`,
          });
        }
        // Refund actually went through but our endpoint hiccuped — treat as success.
      }
    }

    // Refund OK (or free booking) — patch the row to cancelled and fan out emails.
    await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}`,
      {
        method: 'PATCH',
        headers: writeHeaders,
        body: JSON.stringify({ status: 'cancelled' }),
      }
    );

    try {
      await fetch(`${origin}/api/booking-cancelled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_id: bookingId }),
      });
    } catch (mailErr) {
      console.warn('[booking-cancel-self] cancellation email failed', mailErr);
    }

    return res.status(200).json({
      ok: true,
      cancelled: true,
      refund_cents: refundResult && refundResult.refunded ? Number(refundResult.amount_cents || 0) : 0,
      refund_id: refundResult && refundResult.refund_id ? refundResult.refund_id : null,
    });
  } catch (e) {
    console.error('[booking-cancel-self] error', e);
    return res.status(500).json({ error: e.message || 'cancel_failed' });
  }
}
