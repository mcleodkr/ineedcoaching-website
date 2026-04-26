// Creates a Stripe Checkout Session for course enrollment with a destination
// charge: the platform retains application_fee_amount, the rest is
// transferred to the coach's connected Stripe account. Webhook
// (/api/stripe-webhook) finalizes the enrollment + purchase ledger row
// after Stripe confirms payment.

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
  if (!STRIPE_SECRET_KEY || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server not configured', stripeMode: process.env.STRIPE_MODE || 'test' });
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  try {
    const { course_id, student_email, student_name } = req.body || {};
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
