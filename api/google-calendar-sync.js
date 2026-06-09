// POST /api/google-calendar-sync
//
// Internal, email-free sync of a single coach_bookings row to the coach's
// Google Calendar. The booking-confirmation / -rescheduled / -cancelled
// endpoints already sync inline (PR 5.A) as part of their email flows; this
// endpoint exists for the cases those don't cover:
//
//   - Backfilling a booking whose inline sync failed (e.g. the coach's token
//     was expired at confirmation time) WITHOUT re-sending the client a
//     confirmation email.
//   - A directly-callable, fire-and-forget sync target for any future flow.
//
// It is NOT a public endpoint — no auth is enforced here because it only ever
// acts on the calendar of the coach that owns the referenced booking, and it
// reads/writes through the service role. Do not link it from client code that
// passes an attacker-controlled booking_id without an upstream gate.
//
// Unlike the inline callers, on a hard auth failure (Google 401 / revoked or
// expired refresh token) this flips coach_profiles.google_calendar_enabled to
// false and clears the tokens, so the coach sees "Disconnected" in the
// dashboard and re-links — rather than every future booking failing silently.

import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  clearCoachTokens,
} from '../lib/google-calendar-helpers.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VALID_ACTIONS = new Set(['create', 'update', 'delete']);

function sbHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...(extra || {}),
  };
}

// A hard auth failure means the stored Google grant is dead — the coach must
// re-link. Distinguish it from transient/config errors so we only disconnect
// the coach when the credential itself is the problem.
function isAuthDead(message) {
  const m = String(message || '');
  return (
    /\b401\b/.test(m) ||
    /invalid_grant/i.test(m) ||
    /No refresh token/i.test(m) ||
    // A refresh-grant rejection (the helper throws "refresh failed: ...") means
    // the stored Google grant itself is dead — config errors are thrown earlier
    // with a different message ("Google Calendar not configured"), so this only
    // fires on an actual Google rejection of the refresh token.
    /refresh failed/i.test(m)
  );
}

async function patchBooking(bookingId, body) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}`,
    {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`booking patch failed: ${res.status} ${t.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const bookingId = body.booking_id;
    const action = body.action;
    if (!bookingId || !VALID_ACTIONS.has(action)) {
      return res.status(400).json({ error: 'Missing or invalid booking_id / action' });
    }

    // Pull the booking plus the service row, mirroring how booking-confirmation
    // enriches the event (duration + service title come from coach_services).
    const bRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*,coach_services(title,duration)`,
      { headers: sbHeaders() }
    );
    if (!bRes.ok) {
      return res.status(502).json({ error: `booking lookup failed: ${bRes.status}` });
    }
    const rows = await bRes.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.coach_id) return res.status(422).json({ error: 'Booking has no coach_id' });

    const serviceName = booking.service_name || 'Coaching Session';
    const serviceDuration = booking.coach_services && booking.coach_services.duration;
    const eventBooking = {
      ...booking,
      // Only forward a real meeting URL — never the "Will be provided" placeholder.
      zoom_link: booking.zoom_link && /^https?:\/\//.test(booking.zoom_link) ? booking.zoom_link : '',
      service_name: serviceName,
      service_duration: serviceDuration,
      client_name: booking.client_name || booking.client_email,
    };

    let result;
    try {
      if (action === 'create') {
        // Re-confirmations / double-fires must not create duplicate events.
        if (booking.google_calendar_event_id) {
          return res.status(200).json({
            ok: true,
            skipped: true,
            reason: 'already_synced',
            event_id: booking.google_calendar_event_id,
          });
        }
        const eventId = await createCalendarEvent(booking.coach_id, eventBooking);
        if (!eventId) {
          // Helper returns null only when the coach hasn't connected / disabled.
          return res.status(200).json({ ok: true, skipped: true, reason: 'calendar_not_enabled' });
        }
        await patchBooking(bookingId, { google_calendar_event_id: eventId });
        result = { ok: true, action, event_id: eventId };
      } else if (action === 'update') {
        if (!booking.google_calendar_event_id) {
          return res.status(200).json({ ok: true, skipped: true, reason: 'no_event_to_update' });
        }
        const ok = await updateCalendarEvent(booking.coach_id, booking.google_calendar_event_id, eventBooking);
        result = { ok: !!ok, action, event_id: booking.google_calendar_event_id };
      } else {
        // delete
        if (!booking.google_calendar_event_id) {
          return res.status(200).json({ ok: true, skipped: true, reason: 'no_event_to_delete' });
        }
        await deleteCalendarEvent(booking.coach_id, booking.google_calendar_event_id);
        await patchBooking(bookingId, { google_calendar_event_id: null });
        result = { ok: true, action, event_id: null };
      }
    } catch (calErr) {
      const message = calErr && calErr.message ? calErr.message : String(calErr);
      // Dead grant → disconnect the coach so the dashboard prompts a re-link
      // and we stop silently failing on every future booking.
      let disconnected = false;
      if (isAuthDead(message)) {
        try {
          await clearCoachTokens(booking.coach_id);
          disconnected = true;
        } catch (clearErr) {
          console.error('[google-calendar-sync] token clear failed:', clearErr && clearErr.message);
        }
      }
      console.warn(`[google-calendar-sync] ${action} failed for ${bookingId}:`, message);
      // Non-fatal by contract — callers fire-and-forget. We still report the
      // detail in the body so a manual/backfill caller can see what happened.
      return res.status(200).json({
        ok: false,
        action,
        error: message,
        auth_dead: isAuthDead(message),
        coach_disconnected: disconnected,
      });
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error('[google-calendar-sync] error', e);
    return res.status(500).json({ error: e && e.message ? e.message : 'sync failed' });
  }
}
