// POST /api/invite-client
// Auth: coach Bearer token (the coach's Supabase JWT)
// Body: { client_email, client_name, coach_id }
//
// 1. Verifies the requesting user owns coach_id. Ownership is checked by the
//    JWT-derived email against coach_profiles.user_email — coach_profiles has no
//    user_id column, and matching on the verified email (never a body value) is
//    the same gate every other coach endpoint uses.
// 2. Creates or finds the Supabase auth user for client_email (email pre-confirmed
//    so the magic link is immediately usable).
// 3. Generates a single-use magic link via the admin API.
// 4. Records the coach_clients relationship via attachOnBooking (never steals an
//    active pointer from another coach).
// 5. Sends a branded invite email via Resend.
//
// No DB changes: coach_clients already exists. Magic-link expiry is the Supabase
// default (24 hours).

import { attachOnBooking } from '../lib/coach-clients.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

const CLIENT_DASHBOARD_URL = 'https://www.ineedcoaching.org/client-dashboard.html';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Caller (coach) email from the verified JWT — never from the body.
async function deriveCoachEmail(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    const email = u && u.email ? String(u.email).trim().toLowerCase() : '';
    return email || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Server not configured' });

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const clientEmail = body.client_email ? String(body.client_email).trim().toLowerCase() : '';
  const clientName = body.client_name ? String(body.client_name).trim() : '';
  const coachId = body.coach_id ? String(body.coach_id).trim() : '';
  if (!clientEmail || !coachId) {
    return res.status(400).json({ error: 'client_email and coach_id are required' });
  }
  // Light email-shape validation at the boundary; the auth API is the real gate.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  // Verify the bearer token belongs to a real user.
  const coachEmail = await deriveCoachEmail(req);
  if (!coachEmail) return res.status(401).json({ error: 'Please sign in again.' });

  const SB_SERVICE = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  // Confirm the authenticated user owns this coach_id (email-keyed, never user_id).
  let coach;
  try {
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles`
        + `?id=eq.${encodeURIComponent(coachId)}`
        + `&user_email=ilike.${encodeURIComponent(coachEmail)}`
        + `&select=id,display_name,full_name,slug&limit=1`,
      { headers: SB_SERVICE }
    );
    if (!profileRes.ok) throw new Error(`profile lookup failed: ${profileRes.status}`);
    const profiles = await profileRes.json().catch(() => []);
    coach = Array.isArray(profiles) && profiles[0];
    if (!coach) return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    console.error('[invite-client] ownership check', err.message);
    return res.status(500).json({ error: 'Failed to send invite. Please try again.' });
  }

  const coachName = coach.display_name || coach.full_name || 'Your coach';

  try {
    // Create or find the auth user for the client. 422 = already exists (fine).
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...SB_SERVICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: clientEmail, email_confirm: true }),
    });
    if (!createRes.ok && createRes.status !== 422) {
      const t = await createRes.text().catch(() => '');
      throw new Error(`auth user create failed: ${createRes.status} ${t.slice(0, 200)}`);
    }

    // Generate a single-use magic link. We intentionally DO NOT pass redirect_to:
    // the admin generate_link endpoint ignores the redirect allowlist and always
    // forces redirect_to to the project Site URL (ineedtherapy.org on this shared
    // Supabase project), so a cross-domain redirect to the coaching dashboard is
    // impossible that way. Instead we pull the one-time token_hash out of the
    // returned action_link and hand the client a coaching-domain link; the existing
    // client-dashboard.html handler verifies that token_hash against /auth/v1/verify
    // and establishes the session on this domain. The browser never leaves
    // ineedcoaching.org, so the Site-URL override is irrelevant.
    const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { ...SB_SERVICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'magiclink',
        email: clientEmail,
      }),
    });
    console.log('[invite-client] magic link gen status', linkRes.status);
    if (!linkRes.ok) {
      const t = await linkRes.text().catch(() => '');
      throw new Error(`magic link failed: ${linkRes.status} ${t.slice(0, 200)}`);
    }
    const linkData = await linkRes.json().catch(() => ({}));
    const actionLink = linkData.action_link;
    if (!actionLink) throw new Error('No action_link returned');
    // Extract the one-time token_hash (the `token` query param) from Supabase's
    // verify URL and rebuild it as a coaching-domain link the existing
    // client-dashboard.html callback consumes (?token_hash=...&type=magiclink).
    let tokenHash, otpType;
    try {
      const parsed = new URL(actionLink);
      tokenHash = parsed.searchParams.get('token');
      otpType = parsed.searchParams.get('type') || 'magiclink';
    } catch (urlErr) {
      throw new Error(`could not parse action_link: ${urlErr && urlErr.message}`);
    }
    if (!tokenHash) throw new Error('No token_hash in action_link');
    const magicLink = `${CLIENT_DASHBOARD_URL}?token_hash=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(otpType)}`;
    console.log('[invite-client] coaching magic link', magicLink);

    // Record the coach ↔ client relationship (never steals an active pointer).
    await attachOnBooking(coachId, clientEmail);

    // Send the invite email via Resend.
    if (!RESEND_KEY) throw new Error('RESEND_API_KEY not configured');
    const greeting = clientName ? `Hi ${escapeHtml(clientName)},` : 'Hi,';
    const safeCoach = escapeHtml(coachName);
    const html = `
      <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1a3a52;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.6rem;color:#1a3a52;margin-bottom:16px;">You've been invited to your coaching space</h1>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">${greeting}</p>
        <p style="font-size:0.95rem;line-height:1.6;color:#6b6b60;">${safeCoach} has invited you to your private coaching space on ineedcoaching.org &mdash; where you can book sessions, track your goals, journal between sessions, and stay connected.</p>
        <div style="margin:24px 0;">
          <a href="${magicLink}" style="display:inline-block;background:#c49a3c;color:#fff;text-decoration:none;font-weight:600;font-size:0.92rem;padding:12px 28px;border-radius:50px;">Access Your Coaching Space &rarr;</a>
        </div>
        <p style="font-size:0.78rem;color:#9a9a8e;">This link is single-use and expires in 24 hours. If you didn't expect this, you can ignore it.</p>
        <p style="font-size:0.82rem;color:#6b6b60;margin-top:24px;">&mdash; The <a href="https://www.ineedcoaching.org" style="color:#c49a3c;text-decoration:none;font-weight:600;">ineedcoaching.org</a> team</p>
      </div>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // noreply@ is the verified sending identity used by every other working
        // mailer in this project (api/send-email.js, api/notify-new-message.js).
        // hello@ was accepted by the Resend API (HTTP 200) but did not deliver.
        from: 'ineedcoaching.org <noreply@ineedcoaching.org>',
        to: clientEmail,
        subject: `${coachName} has invited you to your coaching space`,
        html,
      }),
    });
    // Log the full Resend response body whether it succeeds or fails, so a
    // "returned success but no email" report is diagnosable from the function logs.
    const emailBody = await emailRes.text().catch(() => '');
    console.log('[invite-client] resend status', emailRes.status, 'body', emailBody.slice(0, 500));
    if (!emailRes.ok) {
      throw new Error(`email failed: ${emailRes.status} ${emailBody.slice(0, 200)}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[invite-client]', err.message);
    return res.status(500).json({ error: 'Failed to send invite. Please try again.' });
  }
}
