export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const { booking_id } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!booking_id) return res.status(400).json({ error: 'Missing booking_id' });

    const bRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${booking_id}&select=*,coach_profiles(display_name,user_email,zoom_meeting_link,zoom_oauth_enabled,slug,timezone),coach_services(title,duration)`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const bookings = await bRes.json();
    if (!bookings.length) return res.status(404).json({ error: 'Booking not found' });

    const booking = bookings[0];
    const coach = booking.coach_profiles;

    // PR 3.A: mint a self-serve reschedule token if one isn't already on the
    // row. Token is rotated only by re-firing this endpoint AND the column
    // being NULL — re-confirmations don't reset the token, so a single
    // booking has a stable reschedule URL. 30-day TTL.
    let rescheduleToken = booking.reschedule_token;
    if (!rescheduleToken) {
      try {
        const { randomBytes } = await import('crypto');
        rescheduleToken = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const tokenPatch = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${booking_id}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ reschedule_token: rescheduleToken, reschedule_token_expires_at: expiresAt }),
          }
        );
        if (!tokenPatch.ok) {
          console.warn('[booking-confirmation] reschedule token patch failed', tokenPatch.status);
          rescheduleToken = '';
        }
      } catch (tokErr) {
        console.warn('[booking-confirmation] reschedule token mint failed', tokErr && tokErr.message);
        rescheduleToken = '';
      }
    }
    const rescheduleLink = rescheduleToken
      ? `https://www.ineedcoaching.org/reschedule?booking_id=${encodeURIComponent(booking_id)}&token=${encodeURIComponent(rescheduleToken)}`
      : '';
    const clientName = booking.client_name || booking.client_email;
    const coachName = coach.display_name || 'Your Coach';
    const serviceName = booking.service_name || 'Coaching Session';
    const sessionDate = booking.scheduled_at
      ? new Date(booking.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })
      : 'TBD';
    const notes = booking.notes || 'None';

    // Generate Zoom meeting if no link exists yet.
    // Fallback chain (PR 5.B, reordered after symptom report):
    //   1. existing booking.zoom_link (re-confirmations of already-synced rows)
    //   2. coach's user-OAuth Zoom (when zoom_oauth_enabled) — meeting lands
    //      on the coach's own account; coach controls recording from Zoom UI
    //   3. coach's recurring zoom_meeting_link (manual fallback for un-OAuthed coaches)
    //   4. platform Server-to-Server Zoom via /api/zoom-meeting (legacy)
    //   5. placeholder text
    //
    // Reordering matters: when a coach has BOTH a recurring link saved AND
    // OAuth connected, OAuth wins so each booking gets its own unique meeting
    // (which is the whole point of connecting OAuth).
    let zoomLink = booking.zoom_link || '';

    if (!zoomLink && coach.zoom_oauth_enabled && booking.coach_id) {
      try {
        const { createZoomMeeting } = await import('../lib/zoom-helpers.js');
        const { parseDurationMinutes } = await import('../lib/google-calendar-helpers.js');
        const durationMin = parseDurationMinutes(
          (booking.coach_services && booking.coach_services.duration) || booking.duration || '60 minutes'
        );
        const meeting = await createZoomMeeting(booking.coach_id, {
          topic: `${serviceName} — ${clientName}`,
          startTime: booking.scheduled_at,
          durationMinutes: durationMin,
        });
        if (meeting && meeting.join_url) {
          zoomLink = meeting.join_url;
          await fetch(
            `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(booking_id)}`,
            {
              method: 'PATCH',
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
              },
              body: JSON.stringify({
                zoom_link: meeting.join_url,
                zoom_meeting_id: meeting.meeting_id,
                zoom_meeting_password: meeting.password || null,
              }),
            }
          );
        }
      } catch (oauthErr) {
        console.warn('[booking-confirmation] user-OAuth Zoom skipped:', oauthErr.message);
      }
    }

    if (!zoomLink && coach.zoom_meeting_link) {
      zoomLink = coach.zoom_meeting_link;
    }

    if (!zoomLink) {
      try {
        const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
        const zoomRes = await fetch(`${origin}/api/zoom-meeting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_id }),
        });
        if (zoomRes.ok) {
          const zoomData = await zoomRes.json();
          zoomLink = zoomData.zoom_link || '';
        }
      } catch (zoomErr) {
        console.log('Zoom meeting creation skipped:', zoomErr.message);
      }
    }
    if (!zoomLink) zoomLink = 'Will be provided before the session';

    // PR 5.A: sync to coach's Google Calendar (best-effort).
    // - Skips silently when the coach hasn't connected their calendar.
    // - Failures never block the booking confirmation email below.
    // - Re-confirmations: only create an event if we don't already have one.
    if (!booking.google_calendar_event_id && booking.coach_id) {
      try {
        const { createCalendarEvent } = await import('../lib/google-calendar-helpers.js');
        const eventId = await createCalendarEvent(booking.coach_id, {
          ...booking,
          zoom_link: zoomLink && zoomLink.startsWith('http') ? zoomLink : '',
          service_name: serviceName,
          service_duration: booking.coach_services && booking.coach_services.duration,
          client_name: clientName,
        });
        if (eventId) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(booking_id)}`,
            {
              method: 'PATCH',
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
              },
              body: JSON.stringify({ google_calendar_event_id: eventId }),
            }
          );
        }
      } catch (calErr) {
        console.warn('[booking-confirmation] Google Calendar sync skipped:', calErr.message);
      }
    }

    // Client email
    const clientSubject = `Your session with ${coachName} is confirmed`;
    const clientHtml = `
      <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">Your session is confirmed</h1>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Hi ${clientName},</p>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Your coaching session has been confirmed.</p>
        <div style="background:#f7f4ee;border-radius:8px;padding:20px;margin:20px 0;">
          <p style="margin:4px 0;font-size:0.9rem;"><strong>Coach:</strong> ${coachName}</p>
          <p style="margin:4px 0;font-size:0.9rem;"><strong>Service:</strong> ${serviceName}</p>
          <p style="margin:4px 0;font-size:0.9rem;"><strong>Date & Time:</strong> ${sessionDate}</p>
          <p style="margin:4px 0;font-size:0.9rem;"><strong>Meeting Link:</strong> ${zoomLink.startsWith('http') ? `<a href="${zoomLink}" style="color:#c49a3c;">${zoomLink}</a>` : zoomLink}</p>
        </div>
        <p style="font-size:0.85rem;color:#6b6b60;">${rescheduleLink ? `Need a different time? <a href="${rescheduleLink}" style="color:#c49a3c;text-decoration:none;font-weight:600;">Reschedule here</a> &mdash; or just reply to this email.` : 'If you need to reschedule, reply to this email.'}</p>
        <p style="font-size:0.82rem;color:#6b6b60;margin-top:24px;">— The <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a> team</p>
      </div>`;

    // Coach email
    const coachSubject = `Booking confirmed: ${clientName}`;
    const coachHtml = `
      <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">Booking confirmed</h1>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">Hi ${coachName},</p>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">A session has been confirmed with your client.</p>
        <div style="background:#f7f4ee;border-radius:8px;padding:20px;margin:20px 0;">
          <p style="margin:4px 0;font-size:0.9rem;"><strong>Client:</strong> ${clientName}</p>
          <p style="margin:4px 0;font-size:0.9rem;"><strong>Service:</strong> ${serviceName}</p>
          <p style="margin:4px 0;font-size:0.9rem;"><strong>Date & Time:</strong> ${sessionDate}</p>
          <p style="margin:4px 0;font-size:0.9rem;"><strong>Notes:</strong> ${notes}</p>
        </div>
        <p style="font-size:0.85rem;color:#6b6b60;"><a href="https://www.ineedcoaching.org/coach-dashboard.html" style="color:#c49a3c;text-decoration:none;font-weight:600;">Go to Dashboard &rarr;</a></p>
      </div>`;

    // Send both emails via Resend
    const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
    const emailResults = await Promise.allSettled([
      fetch(`${origin}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: booking.client_email, subject: clientSubject, html: clientHtml })
      }),
      coach.user_email ? fetch(`${origin}/api/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: coach.user_email, subject: coachSubject, html: coachHtml })
      }) : Promise.resolve({ ok: true })
    ]);

    const clientResult = emailResults[0];
    if (clientResult.status === 'rejected') console.error('Client email failed:', clientResult.reason);
    const coachResult = emailResults[1];
    if (coachResult.status === 'rejected') console.error('Coach email failed:', coachResult.reason);

    return res.status(200).json({ sent: true, to: booking.client_email, subject: clientSubject });
  } catch (e) {
    console.error('booking-confirmation error:', e);
    return res.status(500).json({ error: e.message });
  }
}
