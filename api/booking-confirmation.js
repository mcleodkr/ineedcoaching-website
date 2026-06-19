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
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${booking_id}&select=*,coach_profiles(display_name,user_email,zoom_meeting_link,zoom_oauth_enabled,slug,timezone,coach_phone,booking_sms_alerts_enabled),coach_services(title,duration)`,
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
    // Phase 3c: track the expiry too so this endpoint can hand the token + expiry
    // back to the booker in its response (the only client-side delivery channel
    // for the reschedule link once RLS blocks the old anon read by booking_id).
    let rescheduleExpiry = booking.reschedule_token_expires_at || null;
    if (!rescheduleToken) {
      try {
        const { randomBytes } = await import('crypto');
        rescheduleToken = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        rescheduleExpiry = expiresAt;
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
          rescheduleExpiry = null;
        }
      } catch (tokErr) {
        console.warn('[booking-confirmation] reschedule token mint failed', tokErr && tokErr.message);
        rescheduleToken = '';
        rescheduleExpiry = null;
      }
    }
    const rescheduleLink = rescheduleToken
      ? `https://www.ineedcoaching.org/reschedule?booking_id=${encodeURIComponent(booking_id)}&token=${encodeURIComponent(rescheduleToken)}`
      : '';
    const clientName = booking.client_name || booking.client_email;
    const coachName = coach.display_name || 'Your Coach';
    const serviceName = booking.service_name || 'Coaching Session';
    const sessionDate = booking.scheduled_at
      ? new Date(booking.scheduled_at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: coach.timezone || 'America/Chicago' })
      : 'TBD';
    const notes = booking.notes || 'None';

    // Resolve a Zoom URL for the booking. Priority:
    //   1. existing booking.zoom_link (re-confirmations skip re-resolution)
    //   2. coach's user-OAuth Zoom (when zoom_oauth_enabled): unique meeting
    //      per booking, lands on the coach's own account. Failure falls
    //      through silently to (3).
    //   3. coach's static zoom_meeting_link (one-link-per-coach approach):
    //      same recurring URL reused, no per-meeting id/password.
    //   4. log warning, leave booking.zoom_link null. Email shows a
    //      placeholder; coach coordinates manually.
    //
    // The previous /api/zoom-meeting (Server-to-Server) fallback was
    // removed: it depended on a platform marketplace app that can be in
    // any state, and bookings were losing their meeting link entirely
    // when it 500'd. Manual coordination is strictly better than risking
    // the booking flow on a flaky integration.
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
      // Persist onto the booking row so the email below + Google Calendar
      // event below + any later read-paths see the same URL. zoom_meeting_id
      // and password are explicitly null because static links carry no
      // per-meeting identifiers (one URL reused across bookings).
      try {
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
              zoom_link: zoomLink,
              zoom_meeting_id: null,
              zoom_meeting_password: null,
            }),
          }
        );
      } catch (patchErr) {
        console.warn('[booking-confirmation] static zoom_link patch failed:', patchErr && patchErr.message);
      }
    }

    if (!zoomLink) {
      // No OAuth coach + no static link saved. We deliberately do not fall
      // back to /api/zoom-meeting (S2S) — see comment block above.
      // Booking row's zoom_link stays null; email below shows a placeholder
      // so the coach can coordinate manually rather than the booking
      // failing on a flaky integration.
      console.warn('[booking-confirmation] no Zoom URL available for booking', booking_id);
      zoomLink = 'Will be provided before the session';
    }

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

    // Phase 3: keep the coach_clients relationship authoritative. A confirmed
    // booking attaches the client to this coach when they have no active coach;
    // if they're already active with a different coach it records an archived
    // link rather than silently switching them. Best-effort — never blocks the
    // confirmation email below.
    if (booking.coach_id && booking.client_email) {
      try {
        const { attachOnBooking } = await import('../lib/coach-clients.js');
        await attachOnBooking(booking.coach_id, booking.client_email);
      } catch (linkErr) {
        console.warn('[booking-confirmation] coach_clients attach skipped:', linkErr.message);
      }
    }

    // Part 4: turn the client email's "Access your coaching space" button into a
    // real one-click magic link. Pre-create/confirm the auth user (422 = already
    // exists, treated as success) so the link is immediately usable, then mint the
    // magic link. We do NOT pass redirect_to: admin generate_link ignores the
    // redirect allowlist and forces redirect_to to the project Site URL
    // (ineedtherapy.org on this shared Supabase project), which would bounce the
    // client to the therapy site. Instead we extract the one-time token_hash from
    // the returned action_link and hand the client a coaching-domain link; the
    // existing client-dashboard.html callback verifies it against /auth/v1/verify
    // and establishes the session on this domain. Both calls use the service-role
    // key. Best-effort: any failure falls back to the bare dashboard URL so the
    // confirmation email still sends.
    let clientSpaceUrl = 'https://www.ineedcoaching.org/client-dashboard.html';
    if (booking.client_email) {
      try {
        const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: booking.client_email, email_confirm: true }),
        });
        if (!createRes.ok && createRes.status !== 422) {
          console.warn('[booking-confirmation] magic-link user create failed', createRes.status);
        }
        const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'magiclink',
            email: booking.client_email,
          }),
        });
        if (linkRes.ok) {
          const linkData = await linkRes.json().catch(() => ({}));
          const actionLink = linkData && linkData.action_link;
          if (actionLink) {
            const parsed = new URL(actionLink);
            const tokenHash = parsed.searchParams.get('token');
            const otpType = parsed.searchParams.get('type') || 'magiclink';
            if (tokenHash) {
              clientSpaceUrl = `https://www.ineedcoaching.org/client-dashboard.html?token_hash=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(otpType)}`;
            } else {
              console.warn('[booking-confirmation] magic-link had no token_hash');
            }
          } else {
            console.warn('[booking-confirmation] magic-link generate returned no action_link');
          }
        } else {
          console.warn('[booking-confirmation] magic-link generate failed', linkRes.status);
        }
      } catch (mlErr) {
        console.warn('[booking-confirmation] magic-link skipped:', mlErr && mlErr.message);
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
        <div style="margin:24px 0;padding:18px 20px;background:#f7f4ee;border-radius:8px;">
          <p style="margin:0 0 12px;font-size:0.9rem;line-height:1.5;color:#6b6b60;">Your private coaching space is ready. Sign in to see your sessions, track your goals, journal between sessions, and message ${coachName}.</p>
          <a href="${clientSpaceUrl}" style="display:inline-block;background:#c49a3c;color:#fff;text-decoration:none;font-weight:600;font-size:0.85rem;padding:10px 22px;border-radius:50px;">Access your coaching space &rarr;</a>
          <p style="margin:10px 0 0;font-size:0.78rem;color:#9a9a8e;">You'll sign in with a magic link sent to this email address (${booking.client_email}) — no password needed.</p>
        </div>
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

    // Best-effort: text the coach about the new booking when they've opted in
    // (booking_sms_alerts_enabled + a destination coach_phone). Never blocks or
    // fails the confirmation response — Twilio errors are logged only. Time is
    // formatted in the coach's timezone (Vercel runtime is UTC).
    try {
      const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
      const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
      const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;
      if (coach.booking_sms_alerts_enabled && coach.coach_phone && TWILIO_SID && TWILIO_AUTH && TWILIO_PHONE) {
        const toPhone = toE164(coach.coach_phone);
        if (!toPhone) {
          console.warn('Coach booking SMS skipped: unparseable coach_phone for', coach.user_email);
        } else {
          const tz = coach.timezone || 'America/Chicago';
          const when = booking.scheduled_at ? new Date(booking.scheduled_at) : null;
          const smsDate = when ? when.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }) : 'TBD';
          const smsTime = when ? when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }) : '';
          const smsBody = `New booking: ${clientName} — ${serviceName} on ${smsDate}${smsTime ? ` at ${smsTime}` : ''}. ineedcoaching.org/coach-dashboard`;
          const twRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
            method: 'POST',
            headers: {
              Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64'),
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ To: toPhone, From: TWILIO_PHONE, Body: smsBody })
          });
          if (!twRes.ok) console.error('Coach booking SMS failed:', twRes.status, await twRes.text().catch(() => ''));
        }
      }
    } catch (smsErr) {
      console.error('Coach booking SMS error:', smsErr.message);
    }

    return res.status(200).json({
      sent: true,
      to: booking.client_email,
      subject: clientSubject,
      // Phase 3c: hand the booker their reschedule token so book.html can build
      // the manage link without an anon read of coach_bookings.
      reschedule_token: rescheduleToken || null,
      reschedule_token_expires_at: rescheduleExpiry || null,
    });
  } catch (e) {
    console.error('booking-confirmation error:', e);
    return res.status(500).json({ error: e.message });
  }
}

// Normalize a phone number to E.164 for Twilio. US 10-digit -> +1NXXNXXXXXX,
// 11-digit leading 1 -> +1..., an existing '+' is trusted (non-digits stripped);
// returns null when the number can't be coerced so the caller skips the send.
function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^\d+]/g, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}
