// POST /api/create-package-checkout { package_id, client_email, client_name? }
//
// Issues a Stripe Checkout Session for a session-package purchase. On
// payment, the webhook (/api/stripe-webhook checkout.session.completed
// branch on metadata.package_id) creates the client_package_purchases
// row with credits_remaining seeded to package.session_count.

// Per platform marketing: no platform fee on client-coach session packages.
// Stripe's own processing fees still apply and come out of the coach's payout.
const PACKAGE_PLATFORM_FEE_PERCENTAGE = 0;

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
    const packageId = String(body.package_id || '').trim();
    const clientEmail = String(body.client_email || '').trim().toLowerCase();
    const clientName = String(body.client_name || '').trim();
    if (!packageId) return res.status(400).json({ error: 'Missing package_id' });
    if (!clientEmail) return res.status(400).json({ error: 'Missing client_email' });

    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_packages`
        + `?id=eq.${encodeURIComponent(packageId)}`
        + `&is_active=eq.true`
        + `&select=id,coach_id,name,description,session_count,price_cents,coach_profiles(slug,display_name,full_name,stripe_account_id)`
        + `&limit=1`,
      { headers }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'package_lookup_failed', status: lookup.status });
    const rows = await lookup.json();
    const pkg = Array.isArray(rows) && rows[0];
    if (!pkg) return res.status(404).json({ error: 'package_not_found' });
    const coach = pkg.coach_profiles || {};
    if (!coach.stripe_account_id) return res.status(409).json({ error: 'coach_stripe_not_connected' });
    const priceCents = Number(pkg.price_cents || 0);
    if (priceCents <= 0) return res.status(409).json({ error: 'package_must_have_positive_price' });

    const platformFeeCents = Math.max(0, Math.round(priceCents * (PACKAGE_PLATFORM_FEE_PERCENTAGE / 100)));
    const coachName = coach.display_name || coach.full_name || 'Coach';
    const slug = coach.slug || '';
    const successUrl = `https://www.ineedcoaching.org/book?coach=${encodeURIComponent(slug)}&package=success`;
    const cancelUrl = `https://www.ineedcoaching.org/book?coach=${encodeURIComponent(slug)}&package=cancelled`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: priceCents,
          product_data: {
            name: `${pkg.name} (${pkg.session_count} sessions) — ${coachName}`,
            description: pkg.description || `${pkg.session_count}-session package with ${coachName}`,
          },
        },
      }],
      customer_email: clientEmail,
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        transfer_data: { destination: coach.stripe_account_id },
        metadata: {
          package_id: pkg.id,
          coach_id: pkg.coach_id,
          client_email: clientEmail,
          client_name: clientName,
          session_count: String(pkg.session_count),
        },
      },
      metadata: {
        package_id: pkg.id,
        coach_id: pkg.coach_id,
        client_email: clientEmail,
        client_name: clientName,
        session_count: String(pkg.session_count),
        platform_fee_cents: String(platformFeeCents),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return res.status(200).json({ url: session.url, session_id: session.id });
  } catch (e) {
    console.error('[create-package-checkout] error', e);
    return res.status(500).json({ error: e.message });
  }
}
