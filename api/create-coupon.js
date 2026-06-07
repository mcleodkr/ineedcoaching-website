// POST /api/create-coupon — service role + coach JWT verification.
//
// Wires coach coupon creation to Stripe. The dashboard previously INSERTed
// coach_coupons directly with a null stripe_coupon_id, so the discount never
// applied at checkout (create-checkout-session only pushes a Stripe
// `discounts: [{ coupon }]` when stripe_coupon_id is present). This creates the
// Stripe coupon FIRST, then stores the row with the returned id.
//
// Account: session-booking checkout is a DESTINATION CHARGE created on the
// platform account (transfer_data.destination → coach), so the coupon is
// created on the platform account too — that's where the discount is applied.
//
// Auth: verifies the coach's Supabase JWT and derives coach_id from coach_profiles
// by that email. The current direct-INSERT was gated by the coach JWT via RLS;
// a service-role endpoint bypasses RLS, so we re-establish that boundary here —
// a client-supplied coach_id is validated against the authenticated coach, never
// trusted on its own.
//
// Body: { code, discount_type('percentage'|'fixed_amount'), discount_value,
//         applies_to('all'|'specific_service'), service_id?, max_uses?, expires_at?, coach_id? }
// discount_value is in DOLLARS for fixed_amount (matches the dashboard form and
// validate-coupon.js); Stripe amount_off is cents, so we ×100.

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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_SECRET_KEY = resolveStripeKey();
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server not configured', stripeMode: process.env.STRIPE_MODE || 'test' });
  }

  // ── Auth: verify the coach's Supabase JWT and use ITS email. ──────────────
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
    console.error('[create-coupon] auth verification failed', authErr && authErr.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const READ_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const code = String(body.code || '').trim().toUpperCase();
    const discountType = String(body.discount_type || '').trim();
    const discountValue = Number(body.discount_value);
    const appliesTo = String(body.applies_to || 'all').trim();
    const serviceId = body.service_id ? String(body.service_id).trim() : null;
    const maxUses = (body.max_uses != null && body.max_uses !== '') ? parseInt(body.max_uses, 10) : null;
    const expiresAt = body.expires_at ? String(body.expires_at) : null;

    // ── Validate against the coach_coupons CHECK constraints + Stripe rules. ──
    if (!code) return res.status(400).json({ error: 'Missing code' });
    if (!/^[A-Z0-9_-]{1,40}$/.test(code)) {
      return res.status(400).json({ error: 'Code may only contain letters, numbers, - or _ (max 40).' });
    }
    if (discountType !== 'percentage' && discountType !== 'fixed_amount') {
      return res.status(400).json({ error: 'discount_type must be "percentage" or "fixed_amount".' });
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      return res.status(400).json({ error: 'discount_value must be greater than 0.' });
    }
    if (discountType === 'percentage' && discountValue > 100) {
      return res.status(400).json({ error: 'Percentage must be between 1 and 100.' });
    }
    if (appliesTo !== 'all' && appliesTo !== 'specific_service') {
      return res.status(400).json({ error: 'applies_to must be "all" or "specific_service".' });
    }
    if (appliesTo === 'specific_service' && !serviceId) {
      return res.status(400).json({ error: 'A specific session type is required for a service-scoped coupon.' });
    }
    if (maxUses != null && (!Number.isInteger(maxUses) || maxUses <= 0)) {
      return res.status(400).json({ error: 'Max uses must be a positive whole number.' });
    }
    let redeemBy = null;
    if (expiresAt) {
      const ts = new Date(expiresAt).getTime();
      if (!Number.isFinite(ts)) return res.status(400).json({ error: 'Invalid expiry date.' });
      if (ts <= Date.now()) return res.status(400).json({ error: 'Expiry must be in the future.' });
      redeemBy = Math.floor(ts / 1000);
    }

    // ── Resolve the coach from the verified email; coach_id is derived, not trusted. ──
    // Match case-insensitively in JS rather than via ilike — an email local part
    // can legitimately contain `_`/`%`, which ilike would treat as wildcards and
    // could match a different coach.
    const coachRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=ilike.${encodeURIComponent(email)}&select=id,user_email`,
      { headers: READ_HEADERS }
    );
    const coachRows = await coachRes.json().catch(() => []);
    const coach = Array.isArray(coachRows)
      && coachRows.find(r => r && String(r.user_email || '').trim().toLowerCase() === email);
    if (!coach || !coach.id) return res.status(403).json({ error: 'No coach profile for this account.' });
    const coachId = coach.id;
    if (body.coach_id && String(body.coach_id) !== String(coachId)) {
      return res.status(403).json({ error: 'coach_id does not match the authenticated coach.' });
    }

    // ── Create the Stripe coupon FIRST. id = code so it reads cleanly in the
    //    Stripe dashboard. NOTE: Stripe coupon ids are unique per platform
    //    account, so two coaches cannot share a code; the second gets a 409.
    //    Downstream only relies on the stored stripe_coupon_id, never the code,
    //    so this id could be auto-generated instead if cross-coach code reuse
    //    is ever needed. ──────────────────────────────────────────────────────
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(STRIPE_SECRET_KEY);

    let stripeCoupon;
    try {
      stripeCoupon = await stripe.coupons.create({
        id: code,
        name: code,
        duration: 'once',
        ...(discountType === 'percentage'
          ? { percent_off: discountValue }
          : { amount_off: Math.round(discountValue * 100), currency: 'usd' }),
        ...(redeemBy ? { redeem_by: redeemBy } : {}),
        ...(maxUses ? { max_redemptions: maxUses } : {}),
      });
    } catch (stripeErr) {
      const already = stripeErr && (stripeErr.code === 'resource_already_exists' || stripeErr.statusCode === 409);
      console.error('[create-coupon] stripe create failed', stripeErr && stripeErr.message);
      return res.status(already ? 409 : 502).json({
        error: already ? 'A Stripe coupon with that code already exists.' : (stripeErr && stripeErr.message) || 'Stripe coupon creation failed.',
      });
    }

    // ── Insert the local row with the Stripe coupon id. ──
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_coupons`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'return=representation' },
      body: JSON.stringify({
        coach_id: coachId,
        code,
        discount_type: discountType,
        discount_value: discountValue,
        applies_to: appliesTo,
        service_id: appliesTo === 'specific_service' ? serviceId : null,
        max_uses: maxUses,
        expires_at: expiresAt,
        is_active: true,
        stripe_coupon_id: stripeCoupon.id,
      }),
    });

    if (!insertRes.ok) {
      const detail = await insertRes.text().catch(() => '');
      // Roll back the Stripe coupon so a failed insert doesn't orphan it.
      try { await stripe.coupons.del(stripeCoupon.id); } catch (delErr) {
        console.error('[create-coupon] stripe rollback failed', delErr && delErr.message);
      }
      const dup = insertRes.status === 409 || /duplicate key/i.test(detail);
      console.error('[create-coupon] insert failed', insertRes.status, detail.slice(0, 200));
      return res.status(dup ? 409 : 500).json({
        error: dup ? 'That code already exists.' : 'Could not save the coupon.',
      });
    }

    const rows = await insertRes.json().catch(() => []);
    return res.status(200).json({ coupon: Array.isArray(rows) ? rows[0] : rows });
  } catch (e) {
    console.error('[create-coupon] error', e);
    return res.status(500).json({ error: e.message });
  }
}
