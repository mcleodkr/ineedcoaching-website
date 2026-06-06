// Shared server-side validator for the public, anonymous reschedule flow.
// The reschedule_token (from the booker's confirmation email) is the capability:
// there is no JWT. Both /api/reschedule-info (read) and /api/reschedule-booking
// (write) MUST validate identically, so the check lives here once.
//
// Returns { ok:true, booking } or { ok:false, httpStatus, error }. Never returns
// the token to callers — endpoints strip it before responding.

const RESCHEDULABLE = new Set(['confirmed', 'manual']);

// Fields both endpoints need (plus the token + expiry for validation). Endpoints
// strip reschedule_token / reschedule_token_expires_at before responding.
const SELECT = 'id,client_email,client_name,scheduled_at,service_id,service_name,status,'
  + 'reschedule_token,reschedule_token_expires_at,coach_id,'
  + 'coach_profiles(id,slug,display_name,full_name,timezone),'
  + 'coach_services(id,title,duration)';

export async function validateRescheduleToken(SUPABASE_URL, SERVICE_KEY, bookingId, token) {
  if (!bookingId || !token) {
    return { ok: false, httpStatus: 400, error: 'Missing booking_id or token' };
  }
  let rows;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}&select=${encodeURIComponent(SELECT)}&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[reschedule-token] lookup failed', res.status, t.slice(0, 200));
      return { ok: false, httpStatus: 502, error: 'Lookup failed' };
    }
    rows = await res.json();
  } catch (e) {
    console.error('[reschedule-token] lookup error', e && e.message);
    return { ok: false, httpStatus: 502, error: 'Lookup failed' };
  }

  const booking = Array.isArray(rows) && rows[0];
  // Same opaque response whether the booking is missing or the token is wrong —
  // don't let a caller probe which booking_ids exist.
  if (!booking) return { ok: false, httpStatus: 403, error: 'Invalid reschedule link' };
  if (!booking.reschedule_token || booking.reschedule_token !== token) {
    return { ok: false, httpStatus: 403, error: 'Invalid reschedule link' };
  }
  if (booking.reschedule_token_expires_at
      && new Date(booking.reschedule_token_expires_at).getTime() < Date.now()) {
    return { ok: false, httpStatus: 410, error: 'This reschedule link has expired' };
  }
  if (!RESCHEDULABLE.has(booking.status)) {
    return { ok: false, httpStatus: 409, error: 'This booking can no longer be rescheduled' };
  }
  return { ok: true, booking };
}

// Strip the secret fields before returning a booking to the client.
export function publicBooking(booking) {
  if (!booking) return null;
  const { reschedule_token, reschedule_token_expires_at, ...safe } = booking;
  return safe;
}
