// POST /api/process-refund { booking_id }
//
// Issues a Stripe refund for a paid coach_booking. Called by
// coach-dashboard.html after the coach confirms a cancellation. The status
// patch (status='cancelled') happens BEFORE this endpoint fires; this
// endpoint only handles the money side and stamps the refund_* ledger
// columns added in 20260427_scheduler_phase3.sql.
//
// Connect-account semantics: course bookings used a destination charge
// (transfer_data + application_fee_amount) so a normal refund only pulls
// from the platform balance. Setting reverse_transfer + refund_application_fee
// reverses the coach's transfer AND refunds the platform fee — which is the
// honest behavior when the session never happened: client gets every dollar
// back, coach gives back the share they were paid, platform gives back its
// cut. Stripe will surface a negative balance on the coach's connected
// account if their payout already cleared, which is acceptable.

function resolveStripeKey() {
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  if (mode === 'live') {
    return process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY || null;
  }
  return process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_SECRET_KEY = resolveStripeKey();
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe not configured' });
  if (!SUPABASE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const bookingId = body.booking_id;
    if (!bookingId) return res.status(400).json({ error: 'Missing booking_id' });

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // Look up the booking — only needs the payment intent + ledger columns.
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
        + `?id=eq.${encodeURIComponent(bookingId)}`
        + `&select=id,status,stripe_payment_intent_id,payment_amount_cents,refund_id`
        + `&limit=1`,
      { headers }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'booking_lookup_failed', status: lookup.status });
    const rows = await lookup.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'booking_not_found' });

    // Idempotency: if we've already refunded this booking, return the
    // existing refund record rather than double-refunding.
    if (booking.refund_id) {
      return res.status(200).json({
        refunded: true,
        already_refunded: true,
        refund_id: booking.refund_id,
        booking_id: bookingId,
      });
    }

    // No-refund cases — return success-with-skip rather than an error so
    // the caller (cancelBooking) can fan out to email regardless of paid
    // vs. free.
    const paymentIntentId = booking.stripe_payment_intent_id;
    const amountCents = Number(booking.payment_amount_cents || 0);
    if (!paymentIntentId || amountCents <= 0) {
      return res.status(200).json({
        refunded: false,
        reason: paymentIntentId ? 'zero_amount' : 'no_payment_intent',
        booking_id: bookingId,
      });
    }

    // Issue the refund. Reverse the coach transfer + refund the platform
    // fee so the client gets the full amount back.
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer',
      reverse_transfer: true,
      refund_application_fee: true,
      metadata: { booking_id: bookingId },
    });

    // Stamp the booking with the Stripe refund details. PATCH failure is
    // logged but doesn't roll back the refund — partial state is recoverable
    // by hand from the Stripe dashboard.
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          refund_id: refund.id,
          refund_amount_cents: refund.amount,
          refund_status: refund.status,
          refunded_at: new Date().toISOString(),
        }),
      }
    );
    if (!patchRes.ok) {
      console.error('[process-refund] booking patch failed (refund issued)', patchRes.status, refund.id);
    }

    return res.status(200).json({
      refunded: true,
      refund_id: refund.id,
      amount_cents: refund.amount,
      status: refund.status,
      booking_id: bookingId,
    });
  } catch (e) {
    console.error('[process-refund] error', e);
    return res.status(500).json({ error: e.message || 'refund_failed' });
  }
}
