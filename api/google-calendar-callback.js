// GET /api/google-calendar-callback?code=...&state=...
//
// OAuth redirect target. Validates the HMAC-signed state, exchanges the
// authorization code for tokens, and persists them on the coach row whose
// id was bound into the state when /api/google-calendar-auth-url issued it.

import { verifyState, saveCoachTokens } from '../lib/google-calendar-helpers.js';

function redirectToDashboard(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.setHeader('Location', `/coach-dashboard.html?tab=scheduling&${qs}`);
  return res.status(302).end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const { code, state, error: oauthError } = req.query || {};
  if (oauthError) {
    console.warn('[google-calendar-callback] OAuth error from Google:', oauthError);
    return redirectToDashboard(res, { calendar_connected: 'false', reason: 'denied' });
  }
  if (!code || !state) return res.status(400).send('Missing code or state');

  const verified = verifyState(state);
  if (!verified) {
    console.warn('[google-calendar-callback] state verification failed');
    return res.status(403).send('Invalid or expired state');
  }
  const coachId = verified.coachId;

  const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).send('Google Calendar not configured');
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || tokens.error) {
      throw new Error(tokens.error_description || tokens.error || `status ${tokenRes.status}`);
    }

    await saveCoachTokens(coachId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return redirectToDashboard(res, { calendar_connected: 'true' });
  } catch (e) {
    console.error('[google-calendar-callback] error:', e.message);
    return redirectToDashboard(res, { calendar_connected: 'false', reason: 'exchange_failed' });
  }
}
