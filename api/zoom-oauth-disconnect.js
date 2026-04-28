// POST /api/zoom-oauth-disconnect
//
// Authenticated. Calls Zoom /oauth/revoke (best-effort), then clears the
// stored tokens locally. Future bookings will skip user-OAuth meeting
// creation; the existing /api/zoom-meeting (S2S) remains as the fallback
// for un-connected coaches.

import { verifyCoachSession, fetchTokensForRevoke, revokeZoomToken, clearCoachTokens } from '../lib/zoom-helpers.js';

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let coach;
  try {
    coach = await verifyCoachSession(req);
  } catch (e) {
    console.error('[zoom-oauth-disconnect] session check failed:', e.message);
    return res.status(401).json({ error: 'Auth check failed' });
  }
  if (!coach) return res.status(401).json({ error: 'Not signed in as a coach' });

  let tokens = { accessToken: null, refreshToken: null };
  try {
    tokens = await fetchTokensForRevoke(coach.id);
  } catch (e) {
    console.warn('[zoom-oauth-disconnect] token lookup failed:', e.message);
  }

  // Revoke the refresh token first (kills the whole grant); fall back to
  // access_token if the refresh token is missing. Failures are non-fatal —
  // the local clear is what the coach actually sees.
  try {
    const ok = await revokeZoomToken(tokens.refreshToken || tokens.accessToken);
    if (!ok) console.warn('[zoom-oauth-disconnect] Zoom revoke returned non-OK');
  } catch (e) {
    console.warn('[zoom-oauth-disconnect] revoke failed:', e.message);
  }

  try {
    await clearCoachTokens(coach.id);
  } catch (e) {
    console.error('[zoom-oauth-disconnect] clear failed:', e.message);
    return res.status(500).json({ error: 'Failed to disconnect' });
  }

  return res.status(200).json({ ok: true });
}
