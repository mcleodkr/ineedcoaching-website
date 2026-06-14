// POST /api/connect-coach { coach_id } — service role + client JWT.
//
// Lets a signed-in client attach to a coach WITHOUT booking, and switch coaches.
// connect and switch are the same operation: if the client is already active with
// a different coach, that link is archived and the new one activated (single
// active coach invariant, enforced in lib/coach-clients.js).
//
// Auth: verifies the client's Supabase JWT and derives client_email from the
// token — never from the body. coach_id is validated against coach_profiles.

import { connectOrSwitch } from '../lib/coach-clients.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  // ── Auth: verify the client's Supabase JWT and use ITS email. ──
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let email = '';
  try {
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Unauthorized' });
    const userData = await userRes.json().catch(() => ({}));
    email = (userData && userData.email || '').trim().toLowerCase();
  } catch (authErr) {
    console.error('[connect-coach] auth verification failed', authErr && authErr.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const coachId = body.coach_id ? String(body.coach_id).trim() : '';
    if (!coachId) return res.status(400).json({ error: 'Missing coach_id' });

    // Validate the target coach exists before writing the relationship.
    const coachRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(coachId)}&select=id,user_email,display_name&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const coachRows = await coachRes.json().catch(() => []);
    if (!Array.isArray(coachRows) || !coachRows[0]) {
      return res.status(404).json({ error: 'Coach not found' });
    }
    const coach = coachRows[0];

    const result = await connectOrSwitch(email, coachId, 'self_connect');

    if (result.action === 'connected' || result.action === 'switched') {
      try {
        const coachEmail = coach && coach.user_email ? coach.user_email : '';
        if (coachEmail) {
          const coachName = coach.display_name || 'Coach';
          const dashboardUrl = 'https://www.ineedcoaching.org/coach-dashboard.html';
          const subject = 'A new client just connected with you';
          const text =
            `Hi ${coachName},\n\n` +
            `A new client connected with you on ineedcoaching.org: ${email}\n\n` +
            `They are now active in your client list. You can open their profile and begin from your dashboard:\n${dashboardUrl}\n\n` +
            `The ineedcoaching.org team`;
          const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
          const r = await fetch(`${origin}/api/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: coachEmail, subject, text }),
          });
          if (!r.ok) console.error('[connect-coach] coach notify send-email failed', r.status, await r.text().catch(() => ''));
        }
      } catch (notifyErr) {
        console.error('[connect-coach] coach notify error', notifyErr && notifyErr.message);
      }
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('[connect-coach] error', e);
    return res.status(500).json({ error: e && e.message ? e.message : 'connect failed' });
  }
}
