import Stripe from 'stripe';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!STRIPE_SECRET_KEY || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(email)}&select=stripe_account_id`,
      { headers: SB_HEADERS }
    );
    const profiles = await profileRes.json();
    if (!profiles || !profiles.length) return res.status(404).json({ error: 'Coach profile not found' });

    const accountId = profiles[0].stripe_account_id;
    if (!accountId) return res.status(200).json({ connected: false });

    const account = await stripe.accounts.retrieve(accountId);
    return res.status(200).json({
      connected: true,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
    });
  } catch (e) {
    console.error('stripe-connect-status error:', e);
    return res.status(500).json({ error: e.message });
  }
}
