// POST /api/purchase-gift-certificate
//   { coach_id, amount_cents | session_count, recipient_email,
//     recipient_name, message?, purchased_by_email }
//
// Issues a Stripe Checkout Session for a gift certificate. Webhook
// (/api/stripe-webhook checkout.session.completed branch on
// metadata.gift_certificate=true) creates the gift_certificates row and
// fires /api/send-gift-certificate to email the recipient.

const GIFT_PLATFORM_FEE_PERCENTAGE = 10;

function resolveStripeKey() {
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  if (mode === 'live') return process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY || null;
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
    const coachId = String(body.coach_id || '').trim();
    const amountCents = Number(body.amount_cents || 0);
    const sessionCount = Number(body.session_count || 0);
    const recipientEmail = String(body.recipient_email || '').trim().toLowerCase();
    const recipientName = String(body.recipient_name || '').trim();
    const message = String(body.message || '').trim().slice(0, 500);
    const purchasedBy = String(body.purchased_by_email || '').trim().toLowerCase();
    if (!coachId) return res.status(400).json({ error: 'Missing coach_id' });
    if (!recipientEmail) return res.status(400).json({ error: 'Missing recipient_email' });
    if ((amountCents > 0 && sessionCount > 0) || (amountCents <= 0 && sessionCount <= 0)) {
      return res.status(400).json({ error: 'Specify exactly one of amount_cents or session_count' });
    }

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    // Need coach + a price-per-session if this is a session-count gift, so we
    // can charge the right total. session_count gifts assume the cheapest
    // active paid service as the per-session value (lower bound the gift
    // covers); future polish: let purchaser pick which service.
    const coachLookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles`
        + `?id=eq.${encodeURIComponent(coachId)}`
        + `&select=id,slug,display_name,full_name,stripe_account_id`
        + `&limit=1`,
      { headers }
    );
    const coachRows = await coachLookup.json();
    const coach = Array.isArray(coachRows) && coachRows[0];
    if (!coach) return res.status(404).json({ error: 'coach_not_found' });
    if (!coach.stripe_account_id) return res.status(409).json({ error: 'coach_stripe_not_connected' });

    let chargeCents = amountCents;
    if (sessionCount > 0) {
      const svcRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_services`
          + `?coach_id=eq.${encodeURIComponent(coachId)}`
          + `&is_active=eq.true&price=gt.0`
          + `&select=price&order=price.asc&limit=1`,
        { headers }
      );
      const svcRows = await svcRes.json();
      if (!Array.isArray(svcRows) || !svcRows.length) {
        return res.status(409).json({ error: 'no_paid_service_to_price_against' });
      }
      const perSessionCents = Math.round(Number(svcRows[0].price) * 100);
      chargeCents = perSessionCents * sessionCount;
    }
    if (chargeCents <= 0) return res.status(400).json({ error: 'gift_must_have_positive_value' });

    const platformFeeCents = Math.max(0, Math.round(chargeCents * (GIFT_PLATFORM_FEE_PERCENTAGE / 100)));
    const coachName = coach.display_name || coach.full_name || 'Coach';
    const slug = coach.slug || '';
    const giftLabel = sessionCount > 0
      ? `${sessionCount}-session gift certificate`
      : `$${(chargeCents / 100).toFixed(0)} gift certificate`;
    const successUrl = `https://www.ineedcoaching.org/book?coach=${encodeURIComponent(slug)}&gift=success`;
    const cancelUrl = `https://www.ineedcoaching.org/gift?coach=${encodeURIComponent(slug)}&gift=cancelled`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: chargeCents,
          product_data: {
            name: `${giftLabel} for ${coachName}`,
            description: `Gift for ${recipientName || recipientEmail}`,
          },
        },
      }],
      customer_email: purchasedBy || undefined,
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        transfer_data: { destination: coach.stripe_account_id },
        metadata: {
          gift_certificate: 'true',
          coach_id: coachId,
          recipient_email: recipientEmail,
          recipient_name: recipientName,
          purchased_by: purchasedBy,
          amount_cents: amountCents > 0 ? String(amountCents) : '',
          session_count: sessionCount > 0 ? String(sessionCount) : '',
          message: message,
        },
      },
      metadata: {
        gift_certificate: 'true',
        coach_id: coachId,
        recipient_email: recipientEmail,
        recipient_name: recipientName,
        purchased_by: purchasedBy,
        amount_cents: amountCents > 0 ? String(amountCents) : '',
        session_count: sessionCount > 0 ? String(sessionCount) : '',
        message: message,
        platform_fee_cents: String(platformFeeCents),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return res.status(200).json({ url: session.url, session_id: session.id });
  } catch (e) {
    console.error('[purchase-gift-certificate] error', e);
    return res.status(500).json({ error: e.message });
  }
}
