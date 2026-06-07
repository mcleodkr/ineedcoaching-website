// GET (or POST) /api/process-reminders
//
// Cron-driven orchestrator. Vercel cron hits this every 15 minutes
// (configured in vercel.json). Scans coach_bookings for sessions due for
// each reminder window and fires the corresponding email or SMS endpoint
// for any row that hasn't already had that reminder sent.
//
// Idempotency lives in the *_sent_at columns on coach_bookings:
//   email_reminder_48h_sent_at
//   email_reminder_24h_sent_at
//   email_reminder_1h_sent_at
//   sms_reminder_sent_at
//
// Each window is a 30-minute scan (cron interval ±15 min) so a booking
// lands in at most two consecutive crons; the second cron sees the
// timestamp set and skips. POST is also accepted so the endpoint can be
// hit manually from a curl during testing.

const EMAIL_WINDOWS = [
  { kind: '48h', minutesAhead: 48 * 60, col: 'email_reminder_48h_sent_at' },
  { kind: '24h', minutesAhead: 24 * 60, col: 'email_reminder_24h_sent_at' },
  { kind: '1h',  minutesAhead: 60,      col: 'email_reminder_1h_sent_at' },
];

const SMS_TIMINGS = [30, 15];

const HALF_WIDTH_MIN = 15;

// Post-session email (Phase 2b). Scans bookings whose session is already past
// and sends the client their homework + commitments. MIN_AFTER keeps us from
// emailing while a session is still running; LOOKBACK bounds how long we keep
// retrying a booking that has no post-session content yet (coach hasn't run
// analysis / approved homework). Idempotency: coach_bookings.post_session_email_sent_at.
const POST_SESSION_MIN_AFTER_MIN = 90;
const POST_SESSION_LOOKBACK_MIN = 14 * 24 * 60;

function isoOffset(now, minutes) {
  return new Date(now.getTime() + minutes * 60000).toISOString();
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  // Optional auth — if CRON_SECRET is set in Vercel, require it. Vercel cron
  // populates `Authorization: Bearer <CRON_SECRET>` automatically.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers && req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const writeHeaders = { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
  const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
  const now = new Date();
  const counts = { emails_sent: 0, emails_failed: 0, sms_sent: 0, sms_failed: 0, sms_skipped: 0, post_session_sent: 0, post_session_not_ready: 0, post_session_failed: 0 };
  const errors = [];

  // ── Email windows ──
  for (const win of EMAIL_WINDOWS) {
    const fromIso = isoOffset(now, win.minutesAhead - HALF_WIDTH_MIN);
    const toIso = isoOffset(now, win.minutesAhead + HALF_WIDTH_MIN);
    const url = `${SUPABASE_URL}/rest/v1/coach_bookings`
      + `?status=eq.confirmed`
      + `&${win.col}=is.null`
      + `&scheduled_at=gte.${encodeURIComponent(fromIso)}`
      + `&scheduled_at=lte.${encodeURIComponent(toIso)}`
      + `&select=id`;
    let rows = [];
    try {
      const lookup = await fetch(url, { headers });
      if (!lookup.ok) throw new Error(`status ${lookup.status}`);
      rows = await lookup.json();
    } catch (e) {
      console.error('[process-reminders] email lookup failed', win.kind, e.message);
      errors.push({ stage: 'email_lookup', window: win.kind, error: e.message });
      continue;
    }
    for (const row of rows) {
      try {
        const sendRes = await fetch(`${origin}/api/booking-reminder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_id: row.id, window: win.kind }),
        });
        if (!sendRes.ok) throw new Error(`booking-reminder ${sendRes.status}`);
        // Mark sent only after successful send so a transient failure
        // gets retried on the next cron (per brief: log but retry).
        const patchRes = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(row.id)}`,
          {
            method: 'PATCH',
            headers: writeHeaders,
            body: JSON.stringify({ [win.col]: now.toISOString() }),
          }
        );
        if (!patchRes.ok) {
          // Email went out but we couldn't record it. Log loudly so we can
          // hand-fix; the next cron may resend if the row stays in-window.
          console.error('[process-reminders] email patch failed', win.kind, row.id, patchRes.status);
          errors.push({ stage: 'email_patch', window: win.kind, booking_id: row.id, status: patchRes.status });
        }
        counts.emails_sent++;
      } catch (e) {
        console.error('[process-reminders] email send failed', win.kind, row.id, e.message);
        counts.emails_failed++;
        errors.push({ stage: 'email_send', window: win.kind, booking_id: row.id, error: e.message });
      }
    }
  }

  // ── SMS windows ──
  for (const timing of SMS_TIMINGS) {
    const fromIso = isoOffset(now, timing - HALF_WIDTH_MIN);
    const toIso = isoOffset(now, timing + HALF_WIDTH_MIN);
    const url = `${SUPABASE_URL}/rest/v1/coach_bookings`
      + `?status=eq.confirmed`
      + `&sms_opt_in=eq.true`
      + `&client_phone=not.is.null`
      + `&sms_reminder_sent_at=is.null`
      + `&sms_reminder_timing=eq.${timing}`
      + `&scheduled_at=gte.${encodeURIComponent(fromIso)}`
      + `&scheduled_at=lte.${encodeURIComponent(toIso)}`
      + `&select=id,coach_profiles(sms_reminders_enabled)`;
    let rows = [];
    try {
      const lookup = await fetch(url, { headers });
      if (!lookup.ok) throw new Error(`status ${lookup.status}`);
      rows = await lookup.json();
    } catch (e) {
      console.error('[process-reminders] sms lookup failed', timing, e.message);
      errors.push({ stage: 'sms_lookup', timing, error: e.message });
      continue;
    }
    // Coach-level gate happens client-side because PostgREST embedded
    // filtering doesn't compose cleanly with the row-level filters above.
    for (const row of rows) {
      const coachEnabled = row.coach_profiles && row.coach_profiles.sms_reminders_enabled;
      if (!coachEnabled) {
        counts.sms_skipped++;
        // Mark sent so we don't keep checking this row every 15 min for the
        // life of its window.
        await markSmsSent(SUPABASE_URL, writeHeaders, row.id, now).catch(() => {});
        continue;
      }
      let sent = false;
      try {
        const sendRes = await fetch(`${origin}/api/send-sms-reminder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_id: row.id }),
        });
        const sendData = await sendRes.json().catch(() => ({}));
        sent = sendRes.ok && sendData && sendData.sent === true;
        if (sent) counts.sms_sent++;
        else {
          counts.sms_failed++;
          errors.push({ stage: 'sms_send', booking_id: row.id, status: sendRes.status, reason: sendData && sendData.error });
        }
      } catch (e) {
        console.error('[process-reminders] sms send failed', row.id, e.message);
        counts.sms_failed++;
        errors.push({ stage: 'sms_send', booking_id: row.id, error: e.message });
      }
      // Per brief: 'log and mark as sent (don't spam retry)'. We mark
      // sms_reminder_sent_at regardless of success so a flaky carrier or
      // bad number doesn't burn 15-minute retries forever.
      await markSmsSent(SUPABASE_URL, writeHeaders, row.id, now).catch((e) => {
        console.error('[process-reminders] sms patch failed', row.id, e.message);
      });
    }
  }

  // ── Post-session email (Phase 2b) ──
  // Past-session window: scheduled_at between (now - LOOKBACK) and
  // (now - MIN_AFTER). Only rows with post_session_email_sent_at still null.
  {
    const fromIso = isoOffset(now, -POST_SESSION_LOOKBACK_MIN);
    const toIso = isoOffset(now, -POST_SESSION_MIN_AFTER_MIN);
    const url = `${SUPABASE_URL}/rest/v1/coach_bookings`
      + `?status=eq.confirmed`
      + `&post_session_email_sent_at=is.null`
      + `&scheduled_at=gte.${encodeURIComponent(fromIso)}`
      + `&scheduled_at=lte.${encodeURIComponent(toIso)}`
      + `&select=id`;
    let rows = [];
    try {
      const lookup = await fetch(url, { headers });
      if (!lookup.ok) throw new Error(`status ${lookup.status}`);
      rows = await lookup.json();
    } catch (e) {
      console.error('[process-reminders] post-session lookup failed', e.message);
      errors.push({ stage: 'post_session_lookup', error: e.message });
      rows = [];
    }
    for (const row of rows) {
      try {
        const sendRes = await fetch(`${origin}/api/post-session-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {}),
          },
          body: JSON.stringify({ booking_id: row.id }),
        });
        const sendData = await sendRes.json().catch(() => ({}));
        // Stamp the row only when the email went out (sent:true) or it's a
        // terminal skip (e.g. no client_email) that can never succeed. A
        // not-ready row (no post-session content yet) is left unstamped so a
        // later cron retries once the coach has run analysis / approved homework.
        const shouldMark = sendRes.ok && sendData && (sendData.sent === true || sendData.terminal === true);
        if (sendData && sendData.sent === true) counts.post_session_sent++;
        else if (sendData && sendData.reason === 'not_ready') counts.post_session_not_ready++;
        else if (!shouldMark) {
          counts.post_session_failed++;
          errors.push({ stage: 'post_session_send', booking_id: row.id, status: sendRes.status, reason: sendData && (sendData.error || sendData.reason) });
        }
        if (shouldMark) {
          const patchRes = await fetch(
            `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(row.id)}`,
            {
              method: 'PATCH',
              headers: writeHeaders,
              body: JSON.stringify({ post_session_email_sent_at: now.toISOString() }),
            }
          );
          if (!patchRes.ok) {
            console.error('[process-reminders] post-session patch failed', row.id, patchRes.status);
            errors.push({ stage: 'post_session_patch', booking_id: row.id, status: patchRes.status });
          }
        }
      } catch (e) {
        console.error('[process-reminders] post-session send failed', row.id, e.message);
        counts.post_session_failed++;
        errors.push({ stage: 'post_session_send', booking_id: row.id, error: e.message });
      }
    }
  }

  return res.status(200).json({ ok: true, ran_at: now.toISOString(), counts, errors });
}

async function markSmsSent(SUPABASE_URL, writeHeaders, bookingId, now) {
  return fetch(
    `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}`,
    {
      method: 'PATCH',
      headers: writeHeaders,
      body: JSON.stringify({ sms_reminder_sent_at: now.toISOString() }),
    }
  );
}
