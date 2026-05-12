// POST /api/zoom-deauthorization
//
// Webhook called by Zoom when a user uninstalls our app from
// marketplace.zoom.us. Distinct from /api/zoom-oauth-disconnect (the in-app
// disconnect button). Two events flow through this handler:
//
//   - endpoint.url_validation: Zoom dashboard initial URL handshake. We echo
//     back the HMAC of payload.plainToken. This event is NOT HMAC-signed
//     (Zoom uses it to confirm the secret works in the first place), so it
//     MUST be handled before the signature check or the dashboard cannot
//     register the endpoint.
//   - app_deauthorized: user removed the app from their Zoom marketplace
//     account. HMAC-verified, then we clear local tokens and POST a
//     compliance acknowledgement back to Zoom.
//
// Raw body access is required for HMAC verification, so Vercel's default
// JSON parser is disabled and the stream is read manually.

import { createHmac, timingSafeEqual } from 'crypto';
import { clearTokensByZoomUserId } from '../lib/zoom-helpers.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function verifyZoomSignature(rawBody, headers, secret) {
  const sig = headers['x-zm-signature'] || '';
  const ts = headers['x-zm-request-timestamp'] || '';
  if (!sig || !ts) return false;
  const expected =
    'v0=' +
    createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function sendComplianceAck(payload) {
  const CLIENT_ID = process.env.ZOOM_OAUTH_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOOM_OAUTH_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('[zoom-deauthorization] missing Zoom OAuth creds; skipping compliance POST');
    return;
  }
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.zoom.us/oauth/data/compliance', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      user_id: payload.user_id,
      account_id: payload.account_id,
      deauthorization_event_received: payload,
      compliance_completed: true,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.warn(
      `[zoom-deauthorization] compliance ack failed: ${res.status} ${txt.slice(0, 200)}`
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (!secret) {
    console.error('[zoom-deauthorization] ZOOM_WEBHOOK_SECRET_TOKEN not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    console.error('[zoom-deauthorization] body read failed:', e.message);
    return res.status(400).json({ error: 'Invalid body' });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // URL validation handshake. Zoom sends this before the secret is confirmed
  // to work, so it is intentionally unsigned. Must respond before any
  // signature check or the dashboard cannot register the endpoint.
  if (body && body.event === 'endpoint.url_validation') {
    const plainToken = body.payload && body.payload.plainToken;
    if (!plainToken) return res.status(400).json({ error: 'Missing plainToken' });
    const encryptedToken = createHmac('sha256', secret).update(plainToken).digest('hex');
    return res.status(200).json({ plainToken, encryptedToken });
  }

  // Every other event requires HMAC verification.
  if (!req.headers['x-zm-signature']) {
    return res.status(401).json({ error: 'Missing signature' });
  }
  if (!verifyZoomSignature(rawBody, req.headers, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (body.event === 'app_deauthorized') {
    const payload = body.payload || {};
    const zoomUserId = payload.user_id;
    if (!zoomUserId) {
      return res.status(400).json({ error: 'Missing payload.user_id' });
    }

    try {
      const cleared = await clearTokensByZoomUserId(zoomUserId);
      console.log(
        `[zoom-deauthorization] cleared tokens for zoom user ${zoomUserId}: ${cleared} row(s)`
      );
    } catch (e) {
      // Still return 200 — Zoom retries non-200, and our local clear is
      // recoverable through other channels (manual SQL, disconnect endpoint).
      console.error('[zoom-deauthorization] clear failed:', e.message);
    }

    try {
      await sendComplianceAck(payload);
    } catch (e) {
      console.warn('[zoom-deauthorization] compliance ack threw:', e.message);
    }

    res.status(200).end();
    return;
  }

  // Unrecognized event — acknowledge so Zoom does not retry, but do nothing.
  res.status(200).end();
}
