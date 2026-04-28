// GET /api/zoom-oauth-callback?code=...&state=...
//
// OAuth redirect target. Verifies HMAC state, exchanges code for tokens,
// fetches the Zoom user id, persists, redirects to the dashboard.

import { verifyState, saveCoachTokens } from '../lib/zoom-helpers.js';

function redirectToDashboard(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.setHeader('Location', `/coach-dashboard.html?tab=scheduling&${qs}`);
  return res.status(302).end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const { code, state, error: oauthError } = req.query || {};
  if (oauthError) {
    console.warn('[zoom-oauth-callback] OAuth error from Zoom:', oauthError);
    return redirectToDashboard(res, { zoom_connected: 'false', reason: 'denied' });
  }
  if (!code || !state) return res.status(400).send('Missing code or state');

  const verified = verifyState(state);
  if (!verified) {
    console.warn('[zoom-oauth-callback] state verification failed');
    return res.status(403).send('Invalid or expired state');
  }
  const coachId = verified.coachId;

  const CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOOM_OAUTH_CLIENT_SECRET;
  const REDIRECT_URI = process.env.ZOOM_OAUTH_REDIRECT_URI;
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).send('Zoom user-OAuth not configured');
  }

  try {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || tokens.error) {
      throw new Error(tokens.reason || tokens.error || `status ${tokenRes.status}`);
    }

    // Fetch the Zoom user id for the connected account so we can show it in
    // the dashboard ("Connected to <email>") and so future debugging knows
    // which user the tokens belong to.
    let zoomUserId = null;
    try {
      const userRes = await fetch('https://api.zoom.us/v2/users/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (userRes.ok) {
        const u = await userRes.json();
        zoomUserId = u.id || u.email || null;
      }
    } catch (e) {
      console.warn('[zoom-oauth-callback] users/me lookup failed (non-fatal):', e.message);
    }

    await saveCoachTokens(coachId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      zoomUserId,
    });

    return redirectToDashboard(res, { zoom_connected: 'true' });
  } catch (e) {
    console.error('[zoom-oauth-callback] error:', e.message);
    return redirectToDashboard(res, { zoom_connected: 'false', reason: 'exchange_failed' });
  }
}
