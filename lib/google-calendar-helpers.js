// Google Calendar sync helpers (PR 5.A).
//
// Lives in /lib so Vercel does not deploy it as a serverless function.
// All exports are named — call sites import what they need.

import { createHmac, timingSafeEqual } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5min early

function sbHeaders(extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...(extra || {}),
  };
}

// Coerce "60 minutes" / "1 hour" / "1.5 hr" / "45" → integer minutes.
// Min 5 to avoid zero-length events from bad data; default 60.
export function parseDurationMinutes(s) {
  if (s == null) return 60;
  const str = String(s).toLowerCase();
  const m = str.match(/(\d+(?:\.\d+)?)/);
  if (!m) return 60;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 60;
  if (/hour|hr/.test(str)) return Math.max(5, Math.round(n * 60));
  return Math.max(5, Math.round(n));
}

// Signed OAuth state: `${coachId}.${ts}.${hmac}` — prevents an attacker from
// asking the auth-url endpoint for a state on someone else's behalf, OR
// from forging one wholesale. Token is short-lived (10min) to bound replay.
export function signState(coachId) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error('OAUTH_STATE_SECRET not configured');
  const payload = `${coachId}.${Date.now()}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyState(state) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error('OAUTH_STATE_SECRET not configured');
  if (typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [coachId, tsStr, sig] = parts;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return null;
  if (Date.now() - ts > STATE_TTL_MS) return null;
  const expected = createHmac('sha256', secret).update(`${coachId}.${tsStr}`).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { coachId };
}

// Validate a Supabase access token from the dashboard and return the linked
// coach_profiles row, or null if missing/invalid. Coach link is by email,
// matching how coach-dashboard.html resolves it (user_email).
export async function verifyCoachSession(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  const email = (user.email || '').toLowerCase();
  if (!email) return null;

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(email)}&select=id,user_email,timezone,google_calendar_enabled,google_calendar_id&limit=1`,
    { headers: sbHeaders() }
  );
  if (!profileRes.ok) return null;
  const rows = await profileRes.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchCoachTokens(coachId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}&select=id,timezone,google_calendar_enabled,google_calendar_id,google_access_token,google_refresh_token,google_token_expires_at&limit=1`,
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error(`coach lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export async function refreshGoogleToken(coachId) {
  const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Google Calendar not configured');

  const coach = await fetchCoachTokens(coachId);
  if (!coach || !coach.google_refresh_token) throw new Error('No refresh token available');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: coach.google_refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokens.error) {
    // Keep the Google error CODE (e.g. invalid_grant) in the message — Google
    // buries a dead/revoked refresh token under error_description:"Bad Request",
    // so callers that only saw the description couldn't tell auth death apart
    // from a transient failure.
    const detail = [tokens.error, tokens.error_description].filter(Boolean).join(': ') || `HTTP ${tokenRes.status}`;
    throw new Error(`refresh failed: ${detail}`);
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}`,
    {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        google_access_token: tokens.access_token,
        google_token_expires_at: expiresAt,
      }),
    }
  );
  return tokens.access_token;
}

// Returns a non-expired access token, refreshing if needed. Throws if the
// coach has not connected.
export async function getValidAccessToken(coachId) {
  const coach = await fetchCoachTokens(coachId);
  if (!coach) throw new Error('Coach not found');
  if (!coach.google_calendar_enabled || !coach.google_access_token) {
    throw new Error('Calendar not connected');
  }
  const expiresAt = coach.google_token_expires_at ? new Date(coach.google_token_expires_at) : new Date(0);
  if (expiresAt.getTime() <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return await refreshGoogleToken(coachId);
  }
  return coach.google_access_token;
}

function buildEvent(booking, coach) {
  const start = new Date(booking.scheduled_at);
  const durationMin = parseDurationMinutes(booking.duration || booking.service_duration || '60 minutes');
  const end = new Date(start.getTime() + durationMin * 60000);
  const tz = (coach && coach.timezone) || 'America/Chicago';
  const clientName = booking.client_name || booking.client_email || 'Client';
  const serviceName = booking.service_name || 'Coaching Session';

  return {
    summary: `${serviceName} - ${clientName}`,
    description: [
      `Client: ${clientName}`,
      booking.client_email ? `Email: ${booking.client_email}` : '',
      booking.zoom_link ? `Zoom: ${booking.zoom_link}` : '',
      booking.notes ? `Notes: ${booking.notes}` : '',
    ].filter(Boolean).join('\n'),
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    location: booking.zoom_link || '',
    attendees: booking.client_email ? [{ email: booking.client_email }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
  };
}

function calendarEndpoint(coach, suffix) {
  const calId = (coach && coach.google_calendar_id) || 'primary';
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events${suffix || ''}`;
}

// Returns the created event id, or null on any failure (caller logs and continues).
export async function createCalendarEvent(coachId, booking) {
  const coach = await fetchCoachTokens(coachId);
  if (!coach || !coach.google_calendar_enabled) return null;
  const accessToken = await getValidAccessToken(coachId);
  const res = await fetch(calendarEndpoint(coach), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEvent(booking, coach)),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`calendar create failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const evt = await res.json();
  return evt.id || null;
}

export async function updateCalendarEvent(coachId, eventId, booking) {
  if (!eventId) return false;
  const coach = await fetchCoachTokens(coachId);
  if (!coach || !coach.google_calendar_enabled) return false;
  const accessToken = await getValidAccessToken(coachId);
  const start = new Date(booking.scheduled_at);
  const durationMin = parseDurationMinutes(booking.duration || booking.service_duration || '60 minutes');
  const end = new Date(start.getTime() + durationMin * 60000);
  const tz = coach.timezone || 'America/Chicago';
  const patch = {
    start: { dateTime: start.toISOString(), timeZone: tz },
    end: { dateTime: end.toISOString(), timeZone: tz },
    location: booking.zoom_link || '',
  };
  const res = await fetch(calendarEndpoint(coach, `/${encodeURIComponent(eventId)}`), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`calendar update failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return true;
}

// Returns true on success or 410 (already gone). 404 is also treated as success.
export async function deleteCalendarEvent(coachId, eventId) {
  if (!eventId) return false;
  const coach = await fetchCoachTokens(coachId);
  if (!coach || !coach.google_calendar_enabled) return false;
  const accessToken = await getValidAccessToken(coachId);
  const res = await fetch(calendarEndpoint(coach, `/${encodeURIComponent(eventId)}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404 || res.status === 410 || res.ok) return true;
  const txt = await res.text().catch(() => '');
  throw new Error(`calendar delete failed: ${res.status} ${txt.slice(0, 200)}`);
}

// Best-effort revoke at Google. Failures are logged by caller but do not
// block the local DB clear.
export async function revokeGoogleToken(token) {
  if (!token) return false;
  const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return res.ok;
}

// Persist tokens after the OAuth code exchange. Used by the callback only.
export async function saveCoachTokens(coachId, { accessToken, refreshToken, expiresIn }) {
  const expiresAt = new Date(Date.now() + (Number(expiresIn) || 3600) * 1000).toISOString();
  const body = {
    google_calendar_enabled: true,
    google_access_token: accessToken,
    google_token_expires_at: expiresAt,
  };
  // Only overwrite the refresh token when Google sends a new one — `prompt=consent`
  // makes that reliable, but Google may still omit it on re-link.
  if (refreshToken) body.google_refresh_token = refreshToken;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}`,
    {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`token persist failed: ${res.status}`);
}

export async function clearCoachTokens(coachId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}`,
    {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        google_calendar_enabled: false,
        google_access_token: null,
        google_refresh_token: null,
        google_token_expires_at: null,
      }),
    }
  );
  if (!res.ok) throw new Error(`token clear failed: ${res.status}`);
}
