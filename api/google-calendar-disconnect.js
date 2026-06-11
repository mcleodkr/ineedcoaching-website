// POST /api/google-calendar-disconnect
//
// Authenticated. Revokes the coach's refresh token at Google (best-effort)
// then clears the stored tokens locally. Future bookings will skip calendar
// sync until the coach re-connects.

import { verifyCoachSession, clearCoachTokens, revokeGoogleToken } from '../lib/google-calendar-helpers.js';

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

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  let coach;
  try {
    coach = await verifyCoachSession(req);
  } catch (e) {
    console.error('[google-calendar-disconnect] session check failed:', e.message);
    return res.status(401).json({ error: 'Auth check failed' });
  }
  if (!coach) return res.status(401).json({ error: 'Not signed in as a coach' });

  // Pull the refresh token directly so we can revoke at Google. Service-role
  // read against the token vault — these columns moved off coach_profiles into
  // coach_oauth_tokens, which RLS keeps invisible to anon/authenticated.
  let refreshToken = null;
  let accessToken = null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_oauth_tokens?coach_id=eq.${encodeURIComponent(coach.id)}&select=google_refresh_token,google_access_token&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (r.ok) {
      const rows = await r.json();
      refreshToken = rows[0]?.google_refresh_token || null;
      accessToken = rows[0]?.google_access_token || null;
    }
  } catch (e) {
    console.warn('[google-calendar-disconnect] token lookup failed:', e.message);
  }

  // Revoking either token at Google invalidates the grant. Prefer the
  // refresh token; fall back to the access token. Failures are non-fatal —
  // the local clear is what the coach actually sees.
  try {
    const ok = await revokeGoogleToken(refreshToken || accessToken);
    if (!ok) console.warn('[google-calendar-disconnect] Google revoke returned non-OK');
  } catch (e) {
    console.warn('[google-calendar-disconnect] revoke failed:', e.message);
  }

  try {
    await clearCoachTokens(coach.id);
  } catch (e) {
    console.error('[google-calendar-disconnect] clear failed:', e.message);
    return res.status(500).json({ error: 'Failed to disconnect' });
  }

  return res.status(200).json({ ok: true });
}
