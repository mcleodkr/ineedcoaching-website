// lib/map-link.js
//
// Signed Effectiveness Map intake links (brief v1.1, Step 2). Lives in /lib so
// Vercel does not deploy it as a serverless function. All exports are named.
//
// Mirrors the OAUTH_STATE_SECRET pattern in lib/zoom-helpers.js /
// lib/google-calendar-helpers.js: a dot-delimited payload with an appended hex
// HMAC-SHA256, checked with a constant-time compare. Prevents an attacker from
// minting a link for someone else's coach/client/session or forging one
// wholesale. Distinct secret (MAP_LINK_SECRET) — NOT the Supabase JWT secret.
//
// Token shape: `${coachId}.${emailB64}.${sessionId}.${expiresAt}.${sig}`
//   - emailB64 = base64url(client_email). Unlike the OAUTH state payload (a UUID
//     + timestamp, both dot-free), this token carries an email, which can contain
//     '.' and would break the delimiter — so that one free-text field is encoded.
//     The UUIDs and the numeric expiry stay raw, exactly like the OAUTH payload.
//   - expiresAt is absolute ms-epoch, supplied by the caller (the assign
//     endpoint) so the token and effectiveness_map_assignments.expires_at are the
//     SAME value and can't drift. The 14-day window lives in the caller.

import { createHmac, timingSafeEqual } from 'crypto';

function mapLinkSecret() {
  const secret = process.env.MAP_LINK_SECRET;
  if (!secret) throw new Error('MAP_LINK_SECRET not configured');
  return secret;
}

// Sign an intake link. `expiresAt` is absolute ms-epoch (e.g. Date.now()+14d),
// computed once by the assign endpoint and stored on the assignment row.
export function signMapLink({ coachId, clientEmail, sessionId, expiresAt }) {
  const secret = mapLinkSecret();
  const emailB64 = Buffer.from(String(clientEmail), 'utf8').toString('base64url');
  const payload = `${coachId}.${emailB64}.${sessionId}.${expiresAt}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

// Verify + decode. Returns { coachId, clientEmail, sessionId, expiresAt } on a
// valid, unexpired, untampered token; null otherwise. Never throws on bad input
// (only on a missing secret), mirroring verifyState.
//
// opts.allowExpired (default false) skips ONLY the expiry check — the HMAC
// signature is always verified. Pass it ONLY from a caller that enforces its own
// post-expiry gate (e.g. map-results-read lets a *completed* Map stay readable
// past the 14-day window, then re-checks expiry against assignment status). Never
// pass it from a mutation path: map-intake-validate/submit call verifyMapLink(token)
// with the default so an expired link stays dead.
export function verifyMapLink(token, { allowExpired = false } = {}) {
  const secret = mapLinkSecret();
  if (typeof token !== 'string') return null;
  if (token.length > 1024) return null; // legit tokens are ~300 chars; bound the HMAC input
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [coachId, emailB64, sessionId, expStr, sig] = parts;

  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt)) return null;
  if (!allowExpired && Date.now() > expiresAt) return null; // expired (unless caller gates on status instead)

  const expected = createHmac('sha256', secret)
    .update(`${coachId}.${emailB64}.${sessionId}.${expStr}`)
    .digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let clientEmail;
  try {
    clientEmail = Buffer.from(emailB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!clientEmail) return null;

  return { coachId, clientEmail, sessionId, expiresAt };
}
