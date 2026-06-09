// POST /api/disconnect-coach {} — service role + client JWT.
//
// Archives the signed-in client's active coach link. History (sessions, notes,
// goals — all email-keyed) is left intact; only the active pointer is cleared,
// and the prior coach keeps seeing the client in their archived section.
//
// Auth: verifies the client's Supabase JWT and derives client_email from the
// token — never from the body.

import { disconnect } from '../lib/coach-clients.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

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
    console.error('[disconnect-coach] auth verification failed', authErr && authErr.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await disconnect(email);
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('[disconnect-coach] error', e);
    return res.status(500).json({ error: e && e.message ? e.message : 'disconnect failed' });
  }
}
