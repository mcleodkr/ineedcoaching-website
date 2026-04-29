// Stripe Billing Portal session creator. Returns a hosted-portal URL the
// coach can use to update their card, change plan, or cancel — without
// us building a custom in-app billing UI.
//
// Auth model:
//   - The dashboard POSTs the user's Supabase access token in the body
//     (same pattern as api/admin-query.js).
//   - We verify the token via /auth/v1/user (NOT decoded client-side),
//     pull the caller's email, and look up THEIR coach_profiles row.
//   - The body never carries an email — the caller can't request a
//     portal for someone else's stripe_customer_id.
//
// Returns: { url } on success, { error } otherwise.

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
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY || !SERVICE_KEY) {
    console.error('[create-customer-portal] missing config');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const body = req.body || {};
  const sessionAccessToken = body.sessionAccessToken || body.access_token || null;
  if (!sessionAccessToken) {
    return res.status(400).json({ error: 'Missing sessionAccessToken' });
  }

  // ── 1. Verify caller identity via Supabase auth ──────────────────────
  let callerEmail = null;
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${sessionAccessToken}`,
      },
    });
    if (!authRes.ok) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const user = await authRes.json();
    callerEmail = (user && user.email || '').toLowerCase();
    if (!callerEmail) {
      return res.status(401).json({ error: 'Session has no email claim' });
    }
  } catch (e) {
    console.error('[create-customer-portal] auth check failed:', e.message);
    return res.status(401).json({ error: 'Auth check failed' });
  }

  // ── 2. Look up the coach's stripe_customer_id ────────────────────────
  let stripeCustomerId = null;
  try {
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(callerEmail)}&select=stripe_customer_id&limit=1`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!profRes.ok) {
      const txt = await profRes.text().catch(() => '');
      console.error('[create-customer-portal] coach lookup failed', profRes.status, txt);
      return res.status(500).json({ error: 'Could not look up your account.' });
    }
    const rows = await profRes.json();
    if (Array.isArray(rows) && rows.length) {
      stripeCustomerId = rows[0].stripe_customer_id || null;
    }
  } catch (e) {
    console.error('[create-customer-portal] coach lookup threw:', e.message);
    return res.status(500).json({ error: 'Could not look up your account.' });
  }

  if (!stripeCustomerId) {
    // Legacy / pre-tier coach. The billing dashboard surfaces a banner for
    // this case; this endpoint just returns a clean 409 so the dashboard
    // can fall back to the email-admin path if it ever calls us.
    return res.status(409).json({
      error: 'No Stripe customer on file. Email admin@ineedcoaching.org to update billing.',
      reason: 'no_customer',
    });
  }

  // ── 3. Create the billing portal session ─────────────────────────────
  const returnUrl = 'https://www.ineedcoaching.org/coach-dashboard.html?tab=billing';
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('[create-customer-portal] stripe error:', e.message);
    // Stripe surfaces a useful error when the portal isn't configured in
    // the dashboard yet (one-time setup at https://dashboard.stripe.com/
    // settings/billing/portal). Pass that through unmodified so the user
    // sees the actionable message.
    return res.status(500).json({ error: e.message || 'Stripe error' });
  }
}
