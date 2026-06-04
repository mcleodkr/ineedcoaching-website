// Zoom Marketplace functional review login.
// Single-purpose endpoint that logs the reviewer into the existing
// ineedcoaching.zoomreview@gmail.com coach account by generating + returning
// a Supabase admin magic link. Gated by ZOOM_REVIEWER_SECRET (the same value
// is required in the query string of /zoom-reviewer-login.html).
// Remove this file, the matching HTML page, and the env var after Zoom approval.

import crypto from 'node:crypto';

const REVIEWER_EMAIL = 'ineedcoaching.zoomreview@gmail.com';

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

async function writeAudit(url, key, row) {
  try {
    await fetch(`${url}/rest/v1/zoom_reviewer_login_audit`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.error('[zoom-reviewer-login] audit write failed:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-reviewer-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const REVIEWER_SECRET = process.env.ZOOM_REVIEWER_SECRET;
  if (!SERVICE_KEY || !REVIEWER_SECRET) {
    console.error('[zoom-reviewer-login] missing env vars');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const ip = clientIp(req);
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500);
  const provided = req.headers['x-reviewer-secret'];
  const providedStr = Array.isArray(provided) ? provided[0] : provided;

  if (!providedStr || !constantTimeEqual(providedStr, REVIEWER_SECRET)) {
    await writeAudit(SUPABASE_URL, SERVICE_KEY, {
      ip_address: ip,
      user_agent: userAgent,
      outcome: 'unauthorized',
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Generate a magic link for the reviewer account (server-side only).
    const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'magiclink',
        email: REVIEWER_EMAIL,
      }),
    });

    if (!linkRes.ok) {
      const detail = await linkRes.text().catch(() => '');
      console.error('[zoom-reviewer-login] generate_link failed:', linkRes.status, detail.slice(0, 300));
      await writeAudit(SUPABASE_URL, SERVICE_KEY, { ip_address: ip, user_agent: userAgent, outcome: 'error' });
      return res.status(502).json({ error: 'Could not generate sign-in link' });
    }

    const linkData = await linkRes.json();
    const hashedToken =
      linkData?.properties?.hashed_token ||
      linkData?.hashed_token ||
      null;

    if (!hashedToken) {
      console.error('[zoom-reviewer-login] no hashed_token in response. top keys:', Object.keys(linkData || {}), 'props keys:', Object.keys(linkData?.properties || {}));
      await writeAudit(SUPABASE_URL, SERVICE_KEY, { ip_address: ip, user_agent: userAgent, outcome: 'error' });
      return res.status(502).json({ error: 'No hashed_token returned' });
    }

    // 2. Verify the token server-side to mint a real session (access + refresh).
    //    The verify endpoint only needs a valid apikey header; service key is accepted.
    const VERIFY_APIKEY = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;
    const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'apikey': VERIFY_APIKEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
    });

    if (!verifyRes.ok) {
      const detail = await verifyRes.text().catch(() => '');
      console.error('[zoom-reviewer-login] verify failed:', verifyRes.status, detail.slice(0, 300));
      await writeAudit(SUPABASE_URL, SERVICE_KEY, { ip_address: ip, user_agent: userAgent, outcome: 'error' });
      return res.status(502).json({ error: 'Could not establish session' });
    }

    const session = await verifyRes.json();
    const accessToken = session?.access_token;
    const refreshToken = session?.refresh_token;

    if (!accessToken || !refreshToken) {
      console.error('[zoom-reviewer-login] session missing tokens. keys:', Object.keys(session || {}));
      await writeAudit(SUPABASE_URL, SERVICE_KEY, { ip_address: ip, user_agent: userAgent, outcome: 'error' });
      return res.status(502).json({ error: 'Session missing tokens' });
    }

    await writeAudit(SUPABASE_URL, SERVICE_KEY, { ip_address: ip, user_agent: userAgent, outcome: 'success' });

    return res.status(200).json({ access_token: accessToken, refresh_token: refreshToken });
  } catch (e) {
    console.error('[zoom-reviewer-login] unexpected error:', e.message);
    await writeAudit(SUPABASE_URL, SERVICE_KEY, { ip_address: ip, user_agent: userAgent, outcome: 'error' });
    return res.status(500).json({ error: 'Internal error' });
  }
}
