// Creates a Stripe Checkout Session for either a course enrollment or a paid
// session booking. Both paths use a destination charge: the platform keeps
// application_fee_amount, the rest is transferred to the coach's connected
// Stripe account. The webhook (/api/stripe-webhook) finalizes the ledger
// row (course) or upgrades the booking to status='confirmed' (session).
//
// Branch by input shape:
//   { course_id, student_email, student_name } → course flow (original)
//   { booking_id }                              → session-booking flow (PR 1.D)

// Per platform marketing: no platform fee on client-coach sessions. Stripe's
// own processing fees still apply and come out of the coach's payout.
// Course platform fee is independent and lives on coach_courses.platform_fee_percentage.
const SESSION_PLATFORM_FEE_PERCENTAGE = 0;

function resolveStripeKey() {
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  if (mode === 'live') {
    return process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY || null;
  }
  return process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY || null;
}

// Parse "60 minutes", "1 hour", "30 min" → integer minutes.
// Mirrors api/availability-slots.js / book.html.
function parseDurationMinutes(s) {
  if (!s) return 60;
  const str = String(s).toLowerCase();
  const m = str.match(/(\d+(?:\.\d+)?)/);
  if (!m) return 60;
  const n = parseFloat(m[1]);
  if (/hour|hr/.test(str)) return Math.max(5, Math.round(n * 60));
  return Math.max(5, Math.round(n));
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
  if (!STRIPE_SECRET_KEY || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server not configured', stripeMode: process.env.STRIPE_MODE || 'test' });
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  const body = req.body || {};

  // ── Session booking branch (PR 1.D, coupon-aware in PR 4.A) ────────────
  if (body.booking_id && !body.course_id) {
    return handleSessionBooking({
      booking_id: body.booking_id,
      coupon_code: body.coupon_code ? String(body.coupon_code).trim().toUpperCase() : '',
      stripe,
      SUPABASE_URL,
      SB_HEADERS,
      res,
    });
  }

  try {
    const { course_id, student_email, student_name } = body;
    if (!course_id || !student_email) {
      return res.status(400).json({ error: 'Missing course_id or student_email' });
    }
    const certName = (student_name || '').trim();
    if (!certName) {
      return res.status(400).json({ error: 'Missing student_name (required for the certificate)' });
    }

    // Load course + coach profile via service role.
    const courseRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_courses?id=eq.${encodeURIComponent(course_id)}&select=id,title,slug,price,stripe_price_id,platform_fee_percentage,coach_id,coach_profiles(id,stripe_account_id)`,
      { headers: SB_HEADERS }
    );
    const courses = await courseRes.json();
    const course = Array.isArray(courses) && courses[0];
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const stripePriceId = course.stripe_price_id;
    if (!stripePriceId) {
      return res.status(409).json({ error: 'Course is not yet available for purchase. Stripe price not configured.' });
    }
    const coachAccountId = course.coach_profiles && course.coach_profiles.stripe_account_id;
    if (!coachAccountId) {
      return res.status(409).json({ error: 'Course coach has not connected a Stripe account yet.' });
    }

    // Fee math. price is stored in dollars; convert to cents.
    const priceCents = Math.round(Number(course.price || 0) * 100);
    const feePercentage = Number(course.platform_fee_percentage || 10);
    const platformFeeCents = Math.max(0, Math.round(priceCents * (feePercentage / 100)));

    const successUrl = `https://www.ineedcoaching.org/classroom.html?course=${encodeURIComponent(course.id)}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `https://www.ineedcoaching.org/course-detail.html?slug=${encodeURIComponent(course.slug || '')}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: stripePriceId, quantity: 1 }],
      customer_email: String(student_email).toLowerCase(),
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        transfer_data: { destination: coachAccountId },
        metadata: {
          course_id: course.id,
          coach_id: course.coach_id || '',
          student_email: String(student_email).toLowerCase(),
          student_name: certName,
        },
      },
      metadata: {
        course_id: course.id,
        coach_id: course.coach_id || '',
        student_email: String(student_email).toLowerCase(),
        student_name: certName,
        platform_fee_cents: String(platformFeeCents),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return res.status(200).json({ url: session.url, session_id: session.id });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    return res.status(500).json({ error: e.message || 'Stripe error' });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Session booking flow (PR 1.D)
// ──────────────────────────────────────────────────────────────────────────
//
// Inputs: { booking_id }. The booking row must already exist in
// status='pending_payment' with a service_id and a non-zero service_price —
// book.html pre-creates it before redirecting here. We do the Stripe lookups
// server-side so the client never sees the connected account id, the fee
// math, or the secret key.
async function handleSessionBooking({ booking_id, coupon_code, stripe, SUPABASE_URL, SB_HEADERS, res }) {
  try {
    // 1. Load booking + joined coach + service in one round-trip.
    const bookingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_bookings`
        + `?id=eq.${encodeURIComponent(booking_id)}`
        + `&select=id,coach_id,client_email,client_name,service_id,service_name,service_price,scheduled_at,status,`
        +   `coach_profiles(id,slug,display_name,full_name,stripe_account_id),`
        +   `coach_services(id,title,description,duration,price,is_active)`
        + `&limit=1`,
      { headers: SB_HEADERS }
    );
    if (!bookingRes.ok) {
      return res.status(500).json({ error: 'booking_lookup_failed', status: bookingRes.status });
    }
    const rows = await bookingRes.json();
    const booking = Array.isArray(rows) && rows[0];
    if (!booking) return res.status(404).json({ error: 'booking_not_found' });

    // 2. Sanity gates. Only pending_payment rows are checkout-able. If the
    //    webhook already upgraded this booking to 'confirmed' (rare race —
    //    user double-clicked Stripe link), short-circuit with the existing
    //    success URL so the user lands on the right place.
    if (booking.status === 'confirmed') {
      const slug = booking.coach_profiles && booking.coach_profiles.slug;
      const url = buildBookingReturnUrl(slug, 'success', booking.id);
      return res.status(200).json({ url, session_id: null, already_confirmed: true });
    }
    if (booking.status !== 'pending_payment') {
      return res.status(409).json({ error: 'booking_not_checkout_eligible', status: booking.status });
    }

    const coach = booking.coach_profiles || {};
    const service = booking.coach_services || {};
    const coachAccountId = coach.stripe_account_id;
    if (!coachAccountId) {
      return res.status(409).json({ error: 'coach_stripe_not_connected' });
    }
    if (service.is_active === false) {
      return res.status(409).json({ error: 'service_inactive' });
    }
    // Authoritative price comes from coach_services.price (USD), not the
    // booking row, so a coach can't be billed for a stale snapshot. Falls
    // back to booking.service_price for legacy rows that didn't materialize
    // the join.
    const priceUsd = Number(
      service.price !== undefined && service.price !== null
        ? service.price
        : booking.service_price
    ) || 0;
    if (priceUsd <= 0) {
      return res.status(409).json({ error: 'price_must_be_positive_for_checkout' });
    }
    const priceCents = Math.round(priceUsd * 100);
    const platformFeeCents = Math.max(0, Math.round(priceCents * (SESSION_PLATFORM_FEE_PERCENTAGE / 100)));

    const coachName = coach.display_name || coach.full_name || 'Coach';
    const serviceTitle = service.title || booking.service_name || 'Coaching session';
    const durationMin = parseDurationMinutes(service.duration);
    const lineDescription = `${durationMin}-minute session — ${
      booking.scheduled_at
        ? new Date(booking.scheduled_at).toUTCString()
        : 'time TBD'
    }`;

    const successUrl = buildBookingReturnUrl(coach.slug, 'success', booking.id);
    const cancelUrl = buildBookingReturnUrl(coach.slug, 'cancelled', booking.id);

    // Coupon resolution (PR 4.A). The client-side validate-coupon endpoint
    // gave book.html a code; we re-validate here against the same booking's
    // coach + service so the discount can't be tampered with from the page.
    // Stripe `discounts: [{ coupon }]` only works with a real Stripe coupon
    // id, which the dashboard creates when the coach saves the coupon.
    const stripeDiscounts = [];
    let appliedCouponDbId = null;
    if (coupon_code) {
      try {
        const couponLookup = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_coupons`
            + `?coach_id=eq.${encodeURIComponent(booking.coach_id || '')}`
            + `&code=eq.${encodeURIComponent(coupon_code)}`
            + `&is_active=eq.true`
            + `&select=id,discount_type,discount_value,applies_to,service_id,max_uses,times_used,expires_at,stripe_coupon_id&limit=1`,
          { headers: SB_HEADERS }
        );
        const couponRows = await couponLookup.json();
        const coupon = Array.isArray(couponRows) && couponRows[0];
        const stillUsable = coupon
          && (!coupon.expires_at || new Date(coupon.expires_at).getTime() >= Date.now())
          && (coupon.max_uses == null || coupon.times_used < coupon.max_uses)
          && (coupon.applies_to !== 'specific_service' || !coupon.service_id || coupon.service_id === booking.service_id);
        if (stillUsable && coupon.stripe_coupon_id) {
          stripeDiscounts.push({ coupon: coupon.stripe_coupon_id });
          appliedCouponDbId = coupon.id;
        }
      } catch (e) {
        console.warn('[create-checkout-session][booking] coupon lookup failed', e && e.message);
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Use price_data inline — coach_services rows aren't pre-registered as
      // Stripe Products, and shouldn't be (coaches can spin up new session
      // types from the dashboard without a Stripe round-trip).
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: priceCents,
          product_data: {
            name: `${serviceTitle} with ${coachName}`,
            description: lineDescription,
          },
        },
      }],
      customer_email: String(booking.client_email || '').toLowerCase() || undefined,
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        transfer_data: { destination: coachAccountId },
        metadata: {
          booking_id: booking.id,
          coach_id: booking.coach_id || '',
          service_id: booking.service_id || '',
          client_email: String(booking.client_email || '').toLowerCase(),
          client_name: booking.client_name || '',
        },
      },
      // Top-level metadata is what the webhook reads off the session object.
      metadata: {
        booking_id: booking.id,
        coach_id: booking.coach_id || '',
        service_id: booking.service_id || '',
        client_email: String(booking.client_email || '').toLowerCase(),
        client_name: booking.client_name || '',
        platform_fee_cents: String(platformFeeCents),
        coupon_id: appliedCouponDbId || '',
      },
      ...(stripeDiscounts.length ? { discounts: stripeDiscounts } : {}),
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return res.status(200).json({ url: session.url, session_id: session.id });
  } catch (e) {
    console.error('[create-checkout-session][booking] error:', e);
    return res.status(500).json({ error: e.message || 'Stripe error' });
  }
}

function buildBookingReturnUrl(slug, paymentStatus, bookingId) {
  const base = 'https://www.ineedcoaching.org/book';
  const params = new URLSearchParams();
  if (slug) params.set('coach', slug);
  params.set('payment', paymentStatus);
  params.set('booking_id', bookingId);
  return `${base}?${params.toString()}`;
}
