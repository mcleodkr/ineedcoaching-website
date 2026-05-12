// GET /api/zoom-oauth-callback?code=...&state=...
//
// OAuth redirect target. Two entry paths:
//
//   1. User-initiated (the common case): coach clicks "Connect Zoom Account"
//      on the dashboard. /api/zoom-oauth-auth-url mints an HMAC-signed state
//      tied to coach.id. Zoom redirects back with code + state. We verify
//      state, exchange the code, persist tokens, redirect to dashboard.
//
//   2. Marketplace-initiated: a Zoom user clicks "Add" on the marketplace
//      listing (or a reviewer is evaluating us). Zoom redirects here with
//      code only. No state, because there was no signed flow start. We
//      can't safely auto-link the Zoom account to a coach profile (no
//      session, email-match would silently merge accounts), so we land
//      the user on the coach-signup page with a "please sign in and click
//      Connect Zoom" message. The Zoom-side install still completed; we
//      just defer the token persist to a second user-initiated round-trip.
//
// Either way the page never dead-ends: every branch redirects somewhere
// with a clear status message in the query string.

import { verifyState, saveCoachTokens } from '../lib/zoom-helpers.js';

function redirectToDashboard(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.setHeader('Location', `/coach-dashboard.html?tab=scheduling&${qs}`);
  return res.status(302).end();
}

function redirectToSignIn(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.setHeader('Location', `/coach-signup.html?${qs}`);
  return res.status(302).end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');

  const { code, state, error: oauthError } = req.query || {};
  if (oauthError) {
    console.warn('[zoom-oauth-callback] OAuth error from Zoom:', oauthError);
    return redirectToDashboard(res, { zoom_connected: 'false', reason: 'denied' });
  }
  if (!code) {
    console.warn('[zoom-oauth-callback] missing code in callback');
    return res.status(400).send('Missing code');
  }

  // Marketplace-initiated install: Zoom sends a code with no state.
  // The OAuth handshake on Zoom's side succeeded, but we have no coach to
  // attach the tokens to. Land the user on the signup page so they can
  // create or sign in to their ineedcoaching coach account, then run the
  // user-initiated flow.
  if (!state) {
    console.log('[zoom-oauth-callback] marketplace-initiated install (no state), redirecting to signup');
    return redirectToSignIn(res, {
      zoom_pending: 'true',
      source: 'marketplace',
    });
  }

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
