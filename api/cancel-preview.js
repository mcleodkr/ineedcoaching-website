// POST /api/cancel-preview { booking_id, token }
//
// Token-validated refund preview for client self-serve cancel (Brief 1).
// Reads the coach's late-cancel policy from coach_profiles and computes
// what the client would get back if they cancelled right now. Pure read —
// no Stripe call, no row mutation. The book.html cancel modal calls this
// before showing "$X will be refunded. Confirm cancel?" copy.
//
// Auth: reschedule_token gates access. Same multi-use token covers cancel
// because the client already proved possession of it via their email.
// Token expires when reschedule_token_expires_at lands OR scheduled_at
// is in the past, whichever comes first.

function tokensEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const bookingId = body.booking_id;
    const token = body.token;
    if (!bookingId || !token) return res.status(400).json({ error: 'missing_params' });

    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
        + `?id=eq.${encodeURIComponent(bookingId)}`
        + `&select=id,status,scheduled_at,payment_amount_cents,stripe_payment_intent_id,reschedule_token,reschedule_token_expires_at,`
        +   `coach_profiles(display_name,full_name,user_email,late_cancel_enabled,late_cancel_window_hours,late_cancel_fee_type,late_cancel_fee_amount)`
        + `&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed' });
    const rows = await lookup.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'not_found' });

    if (!booking.reschedule_token || !tokensEq(booking.reschedule_token, token)) {
      return res.status(403).json({ error: 'invalid_token' });
    }
    // Multi-use token expiry: 30d from mint OR session is in the past.
    const tokenExpiresAt = booking.reschedule_token_expires_at
      ? new Date(booking.reschedule_token_expires_at).getTime()
      : 0;
    const sessionAt = booking.scheduled_at ? new Date(booking.scheduled_at).getTime() : 0;
    const now = Date.now();
    if (tokenExpiresAt && tokenExpiresAt < now) {
      return res.status(410).json({ error: 'token_expired' });
    }
    if (sessionAt && sessionAt < now) {
      return res.status(410).json({ error: 'session_in_past' });
    }
    if (booking.status && booking.status !== 'confirmed' && booking.status !== 'manual') {
      return res.status(409).json({ error: 'not_cancelable', current_status: booking.status });
    }

    const policy = booking.coach_profiles || {};
    const amountCents = Number(booking.payment_amount_cents || 0);
    const isPaid = !!booking.stripe_payment_intent_id && amountCents > 0;

    // Mirror the math in api/process-refund.js exactly so the preview lines
    // up with what actually happens. Different code path, same formula.
    let refundCents = amountCents;
    let feeCents = 0;
    let withinWindow = false;
    if (policy.late_cancel_enabled && booking.scheduled_at) {
      const hoursUntil = (sessionAt - now) / 3_600_000;
      withinWindow = hoursUntil < Number(policy.late_cancel_window_hours || 24);
      if (withinWindow) {
        if (policy.late_cancel_fee_type === 'fixed') {
          feeCents = Math.round(Number(policy.late_cancel_fee_amount || 0) * 100);
        } else {
          feeCents = Math.round(amountCents * Number(policy.late_cancel_fee_amount || 0) / 100);
        }
        feeCents = Math.max(0, Math.min(amountCents, feeCents));
        refundCents = amountCents - feeCents;
      }
    }

    return res.status(200).json({
      ok: true,
      is_paid: isPaid,
      amount_cents: amountCents,
      refund_cents: isPaid ? refundCents : 0,
      fee_cents: isPaid ? feeCents : 0,
      within_late_window: withinWindow,
      late_cancel_window_hours: policy.late_cancel_enabled ? Number(policy.late_cancel_window_hours || 24) : null,
      coach_name: policy.display_name || policy.full_name || 'your coach',
      coach_email: policy.user_email || '',
    });
  } catch (e) {
    console.error('[cancel-preview] error', e);
    return res.status(500).json({ error: e.message || 'preview_failed' });
  }
}
