// POST /api/validate-coupon { code, coach_id, service_id?, price_cents? }
//
// Used by book.html when a client clicks "Apply" on the coupon field.
// Returns the discount that would apply if this coupon is used at
// checkout, plus the Stripe coupon id (so the booking flow can pass
// `discounts: [{ coupon: <id> }]` to create-checkout-session). Failure
// modes (expired, exhausted, wrong service) come back as 200 + valid:false
// so book.html can render an inline error without treating it as a
// network failure.

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
    const code = String(body.code || '').trim().toUpperCase();
    const coachId = String(body.coach_id || '').trim();
    const serviceId = String(body.service_id || '').trim();
    const priceCents = Number(body.price_cents || 0);
    if (!code || !coachId) return res.status(400).json({ error: 'Missing code or coach_id' });

    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const lookup = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_coupons`
        + `?coach_id=eq.${encodeURIComponent(coachId)}`
        + `&code=eq.${encodeURIComponent(code)}`
        + `&is_active=eq.true`
        + `&select=id,code,discount_type,discount_value,applies_to,service_id,max_uses,times_used,expires_at,stripe_coupon_id`
        + `&limit=1`,
      { headers }
    );
    if (!lookup.ok) return res.status(500).json({ error: 'lookup_failed', status: lookup.status });
    const rows = await lookup.json();
    const coupon = Array.isArray(rows) && rows[0];
    if (!coupon) return res.status(200).json({ valid: false, reason: 'not_found' });

    if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) {
      return res.status(200).json({ valid: false, reason: 'expired' });
    }
    if (coupon.max_uses != null && coupon.times_used >= coupon.max_uses) {
      return res.status(200).json({ valid: false, reason: 'exhausted' });
    }
    if (coupon.applies_to === 'specific_service' && coupon.service_id && serviceId && coupon.service_id !== serviceId) {
      return res.status(200).json({ valid: false, reason: 'wrong_service' });
    }

    // Compute the dollar discount this coupon would yield against the supplied price.
    let discountCents = 0;
    if (priceCents > 0) {
      if (coupon.discount_type === 'percentage') {
        discountCents = Math.min(priceCents, Math.round(priceCents * Number(coupon.discount_value) / 100));
      } else {
        // fixed_amount stored in DOLLARS in coach_coupons.discount_value to match the dashboard form.
        discountCents = Math.min(priceCents, Math.round(Number(coupon.discount_value) * 100));
      }
    }

    return res.status(200).json({
      valid: true,
      coupon_id: coupon.id,
      stripe_coupon_id: coupon.stripe_coupon_id || null,
      discount_type: coupon.discount_type,
      discount_value: Number(coupon.discount_value),
      discount_cents: discountCents,
      applies_to: coupon.applies_to,
    });
  } catch (e) {
    console.error('[validate-coupon] error', e);
    return res.status(500).json({ error: e.message });
  }
}
