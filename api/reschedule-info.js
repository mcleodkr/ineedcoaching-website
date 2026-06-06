// POST /api/reschedule-info { booking_id, token }  →  { booking: {...no token...} }
//
// Phase 3c: token-gated read for the public reschedule page. reschedule.html used
// to read coach_bookings with the anon key and validate the reschedule_token in
// the browser (which also exposed the token). This moves the read + validation
// server-side (service role) so RLS can be enabled and the token never leaves the
// server. The token from the booker's email is the capability — no JWT.

import { validateRescheduleToken, publicBooking } from '../lib/reschedule-token.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const result = await validateRescheduleToken(SUPABASE_URL, SERVICE_KEY, body.booking_id, body.token);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });
    // publicBooking() strips reschedule_token + expiry — the token never returns.
    return res.status(200).json({ booking: publicBooking(result.booking) });
  } catch (e) {
    console.error('[reschedule-info] error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
}
