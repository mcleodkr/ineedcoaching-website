// GET /api/zoom-oauth-auth-url
//
// Returns the Zoom OAuth consent URL for the *authenticated* coach. State is
// HMAC-signed and tied to the coach.id from the Supabase session — the
// callback verifies it before persisting tokens.

import { signState, verifyCoachSession } from '../lib/zoom-helpers.js';

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

  const CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID;
  const REDIRECT_URI = process.env.ZOOM_OAUTH_REDIRECT_URI;
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).json({ error: 'Zoom user-OAuth not configured' });
  }

  let coach;
  try {
    coach = await verifyCoachSession(req);
  } catch (e) {
    console.error('[zoom-oauth-auth-url] session check failed:', e.message);
    return res.status(401).json({ error: 'Auth check failed' });
  }
  if (!coach) return res.status(401).json({ error: 'Not signed in as a coach' });

  let state;
  try {
    state = signState(coach.id);
  } catch (e) {
    console.error('[zoom-oauth-auth-url] state mint failed:', e.message);
    return res.status(500).json({ error: 'Server not configured' });
  }

  // Zoom OAuth URL. Scopes are passed at the app level (configured in
  // marketplace.zoom.us); requesting them in the URL is unnecessary for
  // user-managed apps. Just response_type=code + redirect_uri + state.
  const url = 'https://zoom.us/oauth/authorize?'
    + 'response_type=code'
    + `&client_id=${encodeURIComponent(CLIENT_ID)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&state=${encodeURIComponent(state)}`;

  return res.status(200).json({ url });
}
