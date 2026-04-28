// GET /api/google-calendar-auth-url
//
// Returns the Google OAuth consent URL for the *authenticated* coach. The
// state parameter is HMAC-signed and tied to the coach.id derived from the
// Supabase session — the callback verifies it before persisting tokens, so
// an attacker cannot cause the callback to overwrite another coach's row.

import { signState, verifyCoachSession } from '../lib/google-calendar-helpers.js';

const ALLOWED_ORIGINS = new Set([
  'https://www.ineedcoaching.org',
  'https://ineedcoaching.org',
  'http://localhost:3000',
]);

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const REDIRECT_URI = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).json({ error: 'Google Calendar not configured' });
  }

  let coach;
  try {
    coach = await verifyCoachSession(req);
  } catch (e) {
    console.error('[google-calendar-auth-url] session check failed:', e.message);
    return res.status(401).json({ error: 'Auth check failed' });
  }
  if (!coach) return res.status(401).json({ error: 'Not signed in as a coach' });

  let state;
  try {
    state = signState(coach.id);
  } catch (e) {
    console.error('[google-calendar-auth-url] state mint failed:', e.message);
    return res.status(500).json({ error: 'Server not configured' });
  }

  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ].join(' ');

  const url = 'https://accounts.google.com/o/oauth2/v2/auth?'
    + `client_id=${encodeURIComponent(CLIENT_ID)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + '&response_type=code'
    + `&scope=${encodeURIComponent(scopes)}`
    + '&access_type=offline'
    + '&prompt=consent'
    + `&state=${encodeURIComponent(state)}`;

  return res.status(200).json({ url });
}
