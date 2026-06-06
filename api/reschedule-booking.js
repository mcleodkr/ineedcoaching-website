// POST /api/reschedule-booking { booking_id, token, scheduled_at }  →  { ok: true }
//
// Phase 3c: token-gated write for the public reschedule page. reschedule.html
// used to PATCH coach_bookings.scheduled_at with the anon key; this moves the
// write server-side (service role) behind the same token validation as
// reschedule-info, so RLS can be enabled. The reschedule_token is the capability
// — no JWT. Fires the existing booking-rescheduled email (coach + client) so the
// page no longer needs that separate call.

import { validateRescheduleToken } from '../lib/reschedule-token.js';

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
    const scheduledAt = body.scheduled_at;
    if (!scheduledAt) return res.status(400).json({ error: 'Missing scheduled_at' });
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid scheduled_at' });
    if (when.getTime() < Date.now()) return res.status(400).json({ error: 'scheduled_at must be in the future' });

    // Same validation as the read path (token match, not expired, reschedulable).
    const result = await validateRescheduleToken(SUPABASE_URL, SERVICE_KEY, body.booking_id, body.token);
    if (!result.ok) return res.status(result.httpStatus).json({ error: result.error });

    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(body.booking_id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ scheduled_at: when.toISOString() }),
      }
    );
    if (!patchRes.ok && patchRes.status !== 204) {
      const t = await patchRes.text().catch(() => '');
      console.error('[reschedule-booking] patch failed', patchRes.status, t.slice(0, 200));
      return res.status(502).json({ error: 'Failed to reschedule' });
    }

    // Best-effort email — the row is already updated.
    try {
      const origin = req.headers.host ? `https://${req.headers.host}` : 'https://www.ineedcoaching.org';
      await fetch(`${origin}/api/booking-rescheduled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_id: body.booking_id }),
      });
    } catch (mailErr) {
      console.warn('[reschedule-booking] booking-rescheduled email failed', mailErr && mailErr.message);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[reschedule-booking] error', e && e.message);
    return res.status(500).json({ error: e.message });
  }
}
