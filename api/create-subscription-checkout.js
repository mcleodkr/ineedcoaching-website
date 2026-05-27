// Coach platform-billing checkout. Distinct from /api/create-checkout-session
// (which is for course/booking destination charges via Stripe Connect) — this
// is a standard Stripe subscription, billed by the platform itself, for the
// Practice $99 / Scale $249 tiers.
//
// Flow:
//   coach-signup form  →  POST { tier, email, ...form fields, ref_code? }
//   here  →  Stripe Checkout (mode=subscription) created
//   returns { url }  →  client redirects
//   coach pays  →  webhook (customer.subscription.created) provisions the
//                  Supabase auth user + coach_profiles row
//
// Form data is stashed in subscription_data.metadata so the webhook (which
// runs with no other state) can build the coach_profiles row from it. Stripe
// metadata values cap at 500 chars; we truncate bio to 480 to stay safe.

const SUPPORTED_TIERS = ['practice', 'scale'];
const META_VALUE_MAX = 480;

// Founder cohort cap. Server-side enforcement complements the UI defense in
// /founding-coaches.html (which fetches /api/founder-cohort-status on page
// load and locks CTAs when is_full). The UI defense doesn't help coaches who
// kept a stale tab open, or anyone POSTing directly to this endpoint, so we
// also check here before creating the Stripe Checkout. Must match
// FOUNDER_COHORT_CAP in api/founder-cohort-status.js.
const FOUNDER_COHORT_CAP = 50;

function resolveStripeKey() {
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  if (mode === 'live') {
    return process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY || null;
  }
  return process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY || null;
}

function resolvePriceId(tier) {
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  if (tier === 'practice') {
    return mode === 'live'
      ? (process.env.STRIPE_PRICE_PRACTICE_LIVE || null)
      : (process.env.STRIPE_PRICE_PRACTICE_TEST || null);
  }
  if (tier === 'scale') {
    return mode === 'live'
      ? (process.env.STRIPE_PRICE_SCALE_LIVE || null)
      : (process.env.STRIPE_PRICE_SCALE_TEST || null);
  }
  return null;
}

// Founder cohort = Practice tier with a 3-month $49 intro price. The price
// object is set up in Stripe and the ID is wired in via env var. The webhook
// (handleSubscriptionCreated) reads signup_source from subscription metadata
// and wraps the subscription in a subscription_schedule that steps up to the
// standard $99 Practice price at the start of month 4.
function resolveFounderPriceId() {
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  return mode === 'live'
    ? (process.env.STRIPE_PRICE_PRACTICE_FOUNDER_LIVE || null)
    : (process.env.STRIPE_PRICE_PRACTICE_FOUNDER_TEST || null);
}

// Count the founders already provisioned in coach_profiles. Returns null on
// any error so the caller can fail open (better to overshoot the cap by one
// slot than block legitimate signups during a Supabase blip). Uses HEAD +
// count=exact for a cheap header-only count — no rows transferred.
async function fetchFounderCount() {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseKey) {
    console.warn('[subscription-checkout] no supabase key for founder cap check');
    return null;
  }
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/coach_profiles?signup_source=eq.founding_cohort&select=id`,
      {
        method: 'HEAD',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'count=exact',
        },
      },
    );
    if (!r.ok) {
      console.warn('[subscription-checkout] founder count non-ok', r.status);
      return null;
    }
    const contentRange = r.headers.get('content-range') || '0-0/0';
    const claimed = parseInt(contentRange.split('/')[1] || '0', 10);
    return Number.isFinite(claimed) ? claimed : null;
  } catch (e) {
    console.warn('[subscription-checkout] founder count threw', e && e.message);
    return null;
  }
}

// Cloudflare Turnstile — verifies the captcha token issued client-side. Skips
// silently if TURNSTILE_SECRET isn't set so test/dev environments aren't
// blocked. Returns true on success or skip, false on outright failure.
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET || process.env.CLOUDFLARE_TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.append('remoteip', remoteIp);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const json = await r.json();
    return !!json.success;
  } catch (e) {
    console.warn('[subscription-checkout] turnstile verify threw', e.message);
    return false;
  }
}

function trimMeta(value) {
  if (value == null) return '';
  const s = String(value);
  return s.length > META_VALUE_MAX ? s.slice(0, META_VALUE_MAX) : s;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_SECRET_KEY = resolveStripeKey();
  if (!STRIPE_SECRET_KEY) {
    console.error('[subscription-checkout] no stripe key configured', { mode: process.env.STRIPE_MODE });
    return res.status(500).json({ error: 'Server not configured' });
  }

  const body = req.body || {};
  const tier = String(body.tier || '').toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();
  const fullName = String(body.full_name || '').trim();
  const displayName = String(body.display_name || fullName || '').trim();
  const specialty = String(body.specialty || '').trim();
  const yearsRaw = body.years_experience;
  const years = Number.isFinite(Number(yearsRaw)) ? String(Math.max(0, Math.floor(Number(yearsRaw)))) : '';
  const bio = String(body.bio || '').trim();
  const refCode = String(body.ref_code || '').trim();
  const cohort = String(body.cohort || '').toLowerCase();
  const isFounder = cohort === 'founding';
  const turnstileToken = body.turnstile_token || body.cf_turnstile_response || null;

  // Founder cohort is Practice tier only; force the tier to keep the rest of
  // the flow simple regardless of what the LP submitted.
  const effectiveTier = isFounder ? 'practice' : tier;

  if (!SUPPORTED_TIERS.includes(effectiveTier)) {
    return res.status(400).json({ error: 'tier must be "practice" or "scale"' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  if (!fullName || fullName.length < 2) {
    return res.status(400).json({ error: 'full_name required' });
  }

  const priceId = isFounder ? resolveFounderPriceId() : resolvePriceId(effectiveTier);
  if (!priceId) {
    console.error('[subscription-checkout] price id missing', {
      tier: effectiveTier,
      isFounder,
      mode: process.env.STRIPE_MODE,
    });
    return res.status(500).json({ error: 'Pricing not configured' });
  }

  const remoteIp =
    (req.headers['cf-connecting-ip'] ||
      req.headers['x-forwarded-for'] ||
      req.socket?.remoteAddress ||
      '').toString().split(',')[0].trim();
  const captchaOk = await verifyTurnstile(turnstileToken, remoteIp);
  if (!captchaOk) {
    return res.status(400).json({ error: 'Captcha verification failed. Please retry.' });
  }

  // Server-side founder cohort cap. Runs after captcha so bot traffic can't
  // drain this query. Fails open: if fetchFounderCount returns null (Supabase
  // error / missing key), we let signup proceed. The cap is best-effort —
  // there's still a small race window between this check and the webhook
  // insert where two simultaneous signups at #49 could both pass. Closing
  // that window would need a race-free founder_slots table; the brief
  // accepted overshoot-by-one over that engineering cost.
  if (isFounder) {
    const founderCount = await fetchFounderCount();
    if (founderCount != null && founderCount >= FOUNDER_COHORT_CAP) {
      return res.status(409).json({
        error: 'Founder cohort is full.',
        code: 'cohort_full',
        cap: FOUNDER_COHORT_CAP,
        claimed: founderCount,
      });
    }
  }

  // Stripe metadata — string-only, 500 char cap per value, 50 keys per object.
  // Keep the surface narrow; the webhook reads only what it needs to seed
  // the coach_profiles row. ref_code is preserved verbatim for the affiliate
  // phase to read directly off the subscription metadata later.
  //
  // signup_source: 'founding_cohort' for the founder LP flow, 'organic' for
  // every other path. Drives the grandfathering policy + segment analytics.
  // founder_locked_price: the lifetime grandfathered monthly price the coach
  // is locked at (Stripe price immutability is what actually holds the price;
  // this is a denormalized hint for the webhook to write into coach_profiles).
  const signupMeta = {
    signup_intent: 'coach_subscription',
    tier: effectiveTier,
    signup_email: email,
    signup_full_name: trimMeta(fullName),
    signup_display_name: trimMeta(displayName),
    signup_specialty: trimMeta(specialty),
    signup_years_experience: years,
    signup_bio: trimMeta(bio),
    signup_ref_code: trimMeta(refCode),
    signup_source: isFounder ? 'founding_cohort' : 'organic',
  };
  if (isFounder) {
    signupMeta.founder_locked_price = '99.00';
    signupMeta.cohort = 'founding';
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(STRIPE_SECRET_KEY);

  const successUrl = 'https://www.ineedcoaching.org/coach-dashboard.html?welcome=1&session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl = 'https://www.ineedcoaching.org/coach-signup.html?canceled=1';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      allow_promotion_codes: true,
      // Mirror the metadata onto BOTH the session and the subscription so the
      // webhook can reach it from either event type.
      metadata: signupMeta,
      subscription_data: {
        metadata: signupMeta,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return res.status(200).json({ url: session.url, session_id: session.id });
  } catch (e) {
    console.error('[subscription-checkout] stripe error', e);
    return res.status(500).json({ error: e.message || 'Stripe error' });
  }
}
