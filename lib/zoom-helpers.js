// Zoom user-OAuth helpers (PR 5.B).
//
// Mirror of lib/google-calendar-helpers.js for Zoom. Lives in /lib so Vercel
// does not deploy it as a serverless function. All exports are named.
//
// Coexists with /api/zoom-meeting (Server-to-Server OAuth on a single
// platform Zoom account). booking-confirmation.js prefers user-OAuth when
// the coach has connected, falls back to S2S otherwise.

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

// Signed OAuth state: `${coachId}.${ts}.${hmac}`. Same pattern as
// lib/google-calendar-helpers.js — prevents an attacker from minting a state
// for someone else's coach_id, OR forging one wholesale. 10-minute TTL.
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

// Validate Supabase JWT and return the linked coach_profiles row, or null.
// Coach link is by email, matching coach-dashboard.html resolution. Note the
// SELECT explicitly excludes the secret token columns — even though service
// role can read them, we never want to bring them into a request handler that
// might echo them back.
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
    `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(email)}&select=id,user_email,timezone,zoom_oauth_enabled&limit=1`,
    { headers: sbHeaders() }
  );
  if (!profileRes.ok) return null;
  const rows = await profileRes.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function fetchCoachTokens(coachId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}&select=id,timezone,zoom_oauth_enabled,zoom_oauth_access_token,zoom_oauth_refresh_token,zoom_oauth_token_expires_at,zoom_oauth_user_id&limit=1`,
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error(`coach lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export async function refreshZoomToken(coachId) {
  const CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOOM_OAUTH_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Zoom user-OAuth not configured');

  const coach = await fetchCoachTokens(coachId);
  if (!coach || !coach.zoom_oauth_refresh_token) throw new Error('No refresh token available');

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: coach.zoom_oauth_refresh_token,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || tokens.error) {
    throw new Error(`zoom refresh failed: ${tokens.reason || tokens.error || tokenRes.status}`);
  }

  const expiresAt = new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000).toISOString();
  // Zoom rotates the refresh token on every use — must persist the new one.
  await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}`,
    {
      method: 'PATCH',
      headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        zoom_oauth_access_token: tokens.access_token,
        zoom_oauth_refresh_token: tokens.refresh_token || coach.zoom_oauth_refresh_token,
        zoom_oauth_token_expires_at: expiresAt,
      }),
    }
  );
  return tokens.access_token;
}

export async function getValidAccessToken(coachId) {
  const coach = await fetchCoachTokens(coachId);
  if (!coach) throw new Error('Coach not found');
  if (!coach.zoom_oauth_enabled || !coach.zoom_oauth_access_token) {
    throw new Error('Zoom not connected');
  }
  const expiresAt = coach.zoom_oauth_token_expires_at ? new Date(coach.zoom_oauth_token_expires_at) : new Date(0);
  if (expiresAt.getTime() <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return await refreshZoomToken(coachId);
  }
  return coach.zoom_oauth_access_token;
}

// Create a scheduled meeting on the coach's own Zoom account.
// Returns { meeting_id, join_url, password, start_url } or null when the
// coach hasn't connected. Throws on Zoom API failures so callers can decide
// whether to fall back to the S2S flow.
export async function createZoomMeeting(coachId, { topic, startTime, durationMinutes }) {
  const coach = await fetchCoachTokens(coachId);
  if (!coach || !coach.zoom_oauth_enabled) return null;
  const accessToken = await getValidAccessToken(coachId);
  const tz = coach.timezone || 'America/Chicago';

  const res = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: topic || 'Coaching Session',
      type: 2, // scheduled
      start_time: startTime,
      duration: durationMinutes || 60,
      timezone: tz,
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: false,
        mute_upon_entry: true,
        waiting_room: true,
        audio: 'both',
        // Coach controls recording from the Zoom UI — we never auto-record.
        auto_recording: 'none',
      },
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`zoom meeting create failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const meeting = await res.json();
  return {
    meeting_id: meeting.id ? String(meeting.id) : null,
    join_url: meeting.join_url || '',
    password: meeting.password || '',
    start_url: meeting.start_url || '',
  };
}

export async function revokeZoomToken(token) {
  if (!token) return false;
  const CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOOM_OAUTH_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) return false;
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://zoom.us/oauth/revoke', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token }),
  });
  return res.ok;
}

export async function saveCoachTokens(coachId, { accessToken, refreshToken, expiresIn, zoomUserId }) {
  const expiresAt = new Date(Date.now() + (Number(expiresIn) || 3600) * 1000).toISOString();
  const body = {
    zoom_oauth_enabled: true,
    zoom_oauth_access_token: accessToken,
    zoom_oauth_refresh_token: refreshToken,
    zoom_oauth_token_expires_at: expiresAt,
    zoom_oauth_connected_at: new Date().toISOString(),
  };
  if (zoomUserId) body.zoom_oauth_user_id = zoomUserId;
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
        zoom_oauth_enabled: false,
        zoom_oauth_access_token: null,
        zoom_oauth_refresh_token: null,
        zoom_oauth_token_expires_at: null,
        zoom_oauth_user_id: null,
        zoom_oauth_connected_at: null,
      }),
    }
  );
  if (!res.ok) throw new Error(`token clear failed: ${res.status}`);
}

// Fetch tokens directly (service-role) for the disconnect endpoint to revoke.
// Never expose this output to the client.
export async function fetchTokensForRevoke(coachId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}&select=zoom_oauth_access_token,zoom_oauth_refresh_token&limit=1`,
    { headers: sbHeaders() }
  );
  if (!res.ok) return { accessToken: null, refreshToken: null };
  const rows = await res.json();
  const r = (rows && rows[0]) || {};
  return { accessToken: r.zoom_oauth_access_token || null, refreshToken: r.zoom_oauth_refresh_token || null };
}
