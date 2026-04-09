export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!STRIPE_SECRET_KEY || !SUPABASE_KEY) {
    return res.status(500).json({
      error: 'Server not configured',
      debug: {
        hasStripeKey: !!STRIPE_SECRET_KEY,
        hasSupabaseKey: !!SUPABASE_KEY,
        stripeEnvVars: Object.keys(process.env).filter(function(k) { return k.includes('STRIPE') || k.includes('stripe'); })
      }
    });
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    // Look up coach profile
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(email)}&select=id,stripe_account_id`,
      { headers: SB_HEADERS }
    );
    const profiles = await profileRes.json();
    if (!profiles || !profiles.length) return res.status(404).json({ error: 'Coach profile not found' });

    const profile = profiles[0];
    let accountId = profile.stripe_account_id;

    // Create Stripe Express account if none exists
    if (!accountId) {
      const account = await stripe.accounts.create({ type: 'express', email });
      accountId = account.id;

      await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${profile.id}`, {
        method: 'PATCH',
        headers: SB_HEADERS,
        body: JSON.stringify({ stripe_account_id: accountId }),
      });
    }

    // Create account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'https://www.ineedcoaching.org/coach-dashboard.html?stripe=refresh',
      return_url: 'https://www.ineedcoaching.org/coach-dashboard.html?stripe=success',
      type: 'account_onboarding',
    });

    return res.redirect(303, accountLink.url);
  } catch (e) {
    console.error('stripe-connect-link error:', e);
    return res.status(500).json({ error: e.message });
  }
}
