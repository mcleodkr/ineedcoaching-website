// Stripe webhook receiver. Verifies the signature against the configured
// signing secret, then handles the events relevant to the course commerce
// flow and the platform-billing subscription flow:
//
//   checkout.session.completed       → course / booking / package / gift
//                                       (existing branched handlers).
//   charge.refunded                  → mark the matching purchase row
//                                       refunded.
//   charge.dispute.created           → mark disputed + write a coach
//                                       notification.
//   customer.subscription.created    → provision coach_profiles + auth user
//                                       for a new platform subscription.
//   customer.subscription.updated    → sync tier / status / period_end.
//   customer.subscription.deleted    → mark canceled.
//   invoice.payment_succeeded        → refresh current_period_end on renewal.
//
// IMPORTANT: bodyParser must be disabled for signature verification — we
// need the raw request body bytes.

export const config = { api: { bodyParser: false } };

function resolveStripeKey() {
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  if (mode === 'live') {
    return process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY || null;
  }
  return process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY || null;
}

function resolveWebhookSecret() {
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  if (mode === 'live') {
    return process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET || null;
  }
  return process.env.STRIPE_WEBHOOK_SECRET_TEST || process.env.STRIPE_WEBHOOK_SECRET || null;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const STRIPE_SECRET_KEY = resolveStripeKey();
  const STRIPE_WEBHOOK_SECRET = resolveWebhookSecret();
  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qroizygknxdjsstkezsf.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_KEY) {
    console.error('[stripe-webhook] missing config', {
      hasKey: !!STRIPE_SECRET_KEY,
      hasSecret: !!STRIPE_WEBHOOK_SECRET,
      hasSupabase: !!SUPABASE_KEY,
      mode: process.env.STRIPE_MODE || 'test',
    });
    return res.status(500).send('Server not configured');
  }

  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  const ADMIN_EMAILS = ['drkmcleod@gmail.com'];

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed', err.message);
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const meta = session.metadata || {};

        // Branch on metadata shape — disjoint: each created session sets exactly one of these markers.
        if (meta.booking_id && !meta.course_id) {
          return handleBookingCompleted({ session, meta, stripe, SUPABASE_URL, SB_HEADERS, req, res });
        }
        if (meta.package_id) {
          return handlePackageCompleted({ session, meta, SUPABASE_URL, SB_HEADERS, res });
        }
        if (meta.gift_certificate === 'true' || meta.gift_certificate === true) {
          return handleGiftCompleted({ session, meta, SUPABASE_URL, SB_HEADERS, req, res });
        }

        const courseId = meta.course_id;
        const coachId = meta.coach_id;
        const studentEmail = (meta.student_email || session.customer_details?.email || '').toLowerCase();
        const studentName = meta.student_name || session.customer_details?.name || '';
        if (!courseId || !studentEmail) {
          console.error('[stripe-webhook] checkout.session.completed missing metadata', meta);
          return res.status(200).send('skipped');
        }

        // Idempotency — bail if a purchase row already exists for this session.
        const dupRes = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_course_purchases?stripe_session_id=eq.${encodeURIComponent(session.id)}&select=id`,
          { headers: SB_HEADERS }
        );
        const dups = await dupRes.json();
        if (Array.isArray(dups) && dups.length > 0) {
          return res.status(200).send('already processed');
        }

        // Create or upsert the enrollment.
        let enrollmentId = null;
        const enrollLookup = await fetch(
          `${SUPABASE_URL}/rest/v1/coach_course_enrollments?course_id=eq.${encodeURIComponent(courseId)}&student_email=ilike.${encodeURIComponent(studentEmail)}&select=id&limit=1`,
          { headers: SB_HEADERS }
        );
        const existing = await enrollLookup.json();
        if (Array.isArray(existing) && existing.length > 0) {
          enrollmentId = existing[0].id;
          // Refresh student_name in case it differs from the prior enrollment.
          await fetch(`${SUPABASE_URL}/rest/v1/coach_course_enrollments?id=eq.${enrollmentId}`, {
            method: 'PATCH',
            headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
            body: JSON.stringify({ student_name: studentName || null }),
          });
        } else {
          const enrollIns = await fetch(`${SUPABASE_URL}/rest/v1/coach_course_enrollments`, {
            method: 'POST',
            headers: { ...SB_HEADERS, Prefer: 'return=representation' },
            body: JSON.stringify({
              course_id: courseId,
              student_email: studentEmail,
              student_name: studentName || null,
              stripe_payment_intent_id: session.payment_intent || null,
            }),
          });
          if (enrollIns.ok) {
            const rows = await enrollIns.json();
            if (Array.isArray(rows) && rows[0]) enrollmentId = rows[0].id;
          } else {
            console.error('[stripe-webhook] enrollment insert failed', enrollIns.status);
          }
        }

        // Pull the payment intent for fee + payout breakdown.
        let amountPaid = session.amount_total || 0;
        let platformFee = Number(meta.platform_fee_cents || 0);
        let stripeFee = null;
        let coachPayout = amountPaid - platformFee;
        if (session.payment_intent) {
          try {
            const pi = await stripe.paymentIntents.retrieve(session.payment_intent, {
              expand: ['latest_charge.balance_transaction'],
            });
            amountPaid = pi.amount_received || amountPaid;
            if (pi.application_fee_amount != null) platformFee = pi.application_fee_amount;
            const bt = pi.latest_charge && pi.latest_charge.balance_transaction;
            if (bt && typeof bt.fee === 'number') stripeFee = bt.fee;
            coachPayout = amountPaid - platformFee - (stripeFee || 0);
          } catch (e) {
            console.warn('[stripe-webhook] payment intent expand failed', e.message);
          }
        }

        await fetch(`${SUPABASE_URL}/rest/v1/coach_course_purchases`, {
          method: 'POST',
          headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
          body: JSON.stringify({
            enrollment_id: enrollmentId,
            course_id: courseId,
            coach_id: coachId,
            student_email: studentEmail,
            stripe_session_id: session.id,
            stripe_payment_intent_id: session.payment_intent || null,
            amount_paid_cents: amountPaid,
            platform_fee_cents: platformFee,
            stripe_fee_cents: stripeFee,
            coach_payout_cents: coachPayout,
            status: 'completed',
          }),
        });

        // Notify the coach of the new enrollment.
        if (coachId) {
          const courseTitleRes = await fetch(
            `${SUPABASE_URL}/rest/v1/coach_courses?id=eq.${encodeURIComponent(courseId)}&select=title`,
            { headers: SB_HEADERS }
          );
          const courseTitleRows = await courseTitleRes.json();
          const courseTitle = (courseTitleRows && courseTitleRows[0] && courseTitleRows[0].title) || 'a course';
          await fetch(`${SUPABASE_URL}/rest/v1/coach_notifications`, {
            method: 'POST',
            headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
            body: JSON.stringify({
              coach_id: coachId,
              type: 'new_booking',
              title: 'New course enrollment',
              body: `${studentName || studentEmail} enrolled in ${courseTitle}.`,
              link_url: `/coach-dashboard.html?tab=courses&course=${courseId}`,
            }),
          });
        }
        return res.status(200).send('ok');
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const piId = charge.payment_intent;
        if (!piId) return res.status(200).send('no-pi');
        await fetch(
          `${SUPABASE_URL}/rest/v1/coach_course_purchases?stripe_payment_intent_id=eq.${encodeURIComponent(piId)}`,
          {
            method: 'PATCH',
            headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'refunded' }),
          }
        );
        return res.status(200).send('ok');
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object;
        const piId = dispute.payment_intent;
        if (!piId) return res.status(200).send('no-pi');
        // Mark disputed.
        await fetch(
          `${SUPABASE_URL}/rest/v1/coach_course_purchases?stripe_payment_intent_id=eq.${encodeURIComponent(piId)}`,
          {
            method: 'PATCH',
            headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'disputed' }),
          }
        );
        // Alert the admin (Kim) by writing a notification scoped to her
        // coach profile so it surfaces on her dashboard.
        for (const adminEmail of ADMIN_EMAILS) {
          const adminProfRes = await fetch(
            `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(adminEmail)}&select=id`,
            { headers: SB_HEADERS }
          );
          const adminProfs = await adminProfRes.json();
          const adminCoachId = adminProfs && adminProfs[0] && adminProfs[0].id;
          if (!adminCoachId) continue;
          await fetch(`${SUPABASE_URL}/rest/v1/coach_notifications`, {
            method: 'POST',
            headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
            body: JSON.stringify({
              coach_id: adminCoachId,
              type: 'new_message',
              title: 'Dispute opened on a course purchase',
              body: `Stripe dispute ${dispute.id} for payment intent ${piId}. Review in the Stripe dashboard.`,
              link_url: 'https://dashboard.stripe.com/disputes',
            }),
          });
        }
        return res.status(200).send('ok');
      }

      case 'customer.subscription.created': {
        return handleSubscriptionCreated({ subscription: event.data.object, stripe, SUPABASE_URL, SB_HEADERS, req, res });
      }

      case 'customer.subscription.updated': {
        return handleSubscriptionUpdated({ subscription: event.data.object, SUPABASE_URL, SB_HEADERS, res });
      }

      case 'customer.subscription.deleted': {
        return handleSubscriptionDeleted({ subscription: event.data.object, SUPABASE_URL, SB_HEADERS, res });
      }

      case 'invoice.payment_succeeded': {
        return handleInvoicePaymentSucceeded({ invoice: event.data.object, stripe, SUPABASE_URL, SB_HEADERS, res });
      }

      default:
        return res.status(200).send(`ignored:${event.type}`);
    }
  } catch (e) {
    console.error('[stripe-webhook] handler error', e);
    return res.status(500).send(e.message || 'webhook error');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Session booking completion (PR 1.D)
// ──────────────────────────────────────────────────────────────────────────
//
// Upgrades the pending_payment booking row to status='confirmed', records the
// fee + payout breakdown, fires /api/booking-confirmation (same emails +
// auto-zoom flow the free book.html flow uses), and writes a coach
// notification.
//
// Idempotency: the partial UNIQUE index on coach_bookings.stripe_session_id
// (migration 20260427) guarantees a re-delivery can't double-write the
// session id. We also short-circuit early if the booking is already
// confirmed for this session.
async function handleBookingCompleted({ session, meta, stripe, SUPABASE_URL, SB_HEADERS, req, res }) {
  const bookingId = meta.booking_id;
  const coachId = meta.coach_id || '';
  if (!bookingId) {
    console.error('[stripe-webhook][booking] missing booking_id in metadata', meta);
    return res.status(200).send('skipped');
  }

  // Idempotency check.
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}&select=id,status,stripe_session_id,coach_id&limit=1`,
    { headers: SB_HEADERS }
  );
  const existingRows = await existingRes.json();
  const booking = Array.isArray(existingRows) && existingRows[0];
  if (!booking) {
    console.error('[stripe-webhook][booking] booking row not found', bookingId);
    return res.status(200).send('booking_missing');
  }
  if (booking.status === 'confirmed' && booking.stripe_session_id === session.id) {
    return res.status(200).send('already processed');
  }

  // Pull payment intent for the canonical fee + payout breakdown.
  let amountPaid = session.amount_total || 0;
  let platformFee = Number(meta.platform_fee_cents || 0);
  let stripeFee = null;
  let paymentIntentId = session.payment_intent || null;
  let coachPayout = amountPaid - platformFee;
  if (paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge.balance_transaction'],
      });
      amountPaid = pi.amount_received || amountPaid;
      if (pi.application_fee_amount != null) platformFee = pi.application_fee_amount;
      const bt = pi.latest_charge && pi.latest_charge.balance_transaction;
      if (bt && typeof bt.fee === 'number') stripeFee = bt.fee;
      coachPayout = amountPaid - platformFee - (stripeFee || 0);
    } catch (e) {
      console.warn('[stripe-webhook][booking] payment_intent expand failed', e.message);
    }
  }

  // Compute discount the coupon yielded by reading total_details on the
  // session, populated by Stripe when discounts: [{coupon}] was attached.
  let discountCents = 0;
  try {
    const td = session.total_details && session.total_details.amount_discount;
    if (typeof td === 'number') discountCents = td;
  } catch (e) { /* non-fatal */ }

  // Upgrade the booking. Patch is keyed on the booking id; the UNIQUE index
  // on stripe_session_id makes a duplicate write fail loudly rather than
  // silently double-confirming.
  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_bookings?id=eq.${encodeURIComponent(bookingId)}`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'confirmed',
        stripe_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
        payment_amount_cents: amountPaid,
        platform_fee_cents: platformFee,
        stripe_fee_cents: stripeFee,
        coach_payout_cents: coachPayout,
        coupon_id: meta.coupon_id || null,
        discount_amount_cents: discountCents > 0 ? discountCents : null,
      }),
    }
  );

  // PR 4.A: track coupon redemption in coupon_usage + bump times_used so
  // the dashboard's coupon list reflects real usage and max_uses gates work.
  if (meta.coupon_id && discountCents > 0) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/coupon_usage`, {
        method: 'POST',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({
          coupon_id: meta.coupon_id,
          client_email: (meta.client_email || '').toLowerCase(),
          booking_id: bookingId,
          discount_amount_cents: discountCents,
        }),
      });
      // Increment times_used. PostgREST doesn't natively expose increments,
      // so we read-then-write — fine for a low-write-rate column.
      const cur = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_coupons?id=eq.${encodeURIComponent(meta.coupon_id)}&select=times_used&limit=1`,
        { headers: SB_HEADERS }
      ).then(r => r.json()).catch(() => []);
      if (Array.isArray(cur) && cur[0]) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/coach_coupons?id=eq.${encodeURIComponent(meta.coupon_id)}`,
          {
            method: 'PATCH',
            headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
            body: JSON.stringify({ times_used: (cur[0].times_used || 0) + 1 }),
          }
        );
      }
    } catch (e) {
      console.warn('[stripe-webhook][booking] coupon usage tracking failed', e && e.message);
    }
  }
  if (!patchRes.ok) {
    const bodyText = await patchRes.text().catch(() => '');
    console.error('[stripe-webhook][booking] booking patch failed', patchRes.status, bodyText);
    return res.status(500).send('booking_patch_failed');
  }

  // ── Usage counter (phase 4b) ──────────────────────────────────────────
  // Increment monthly_client_count when this is the first confirmed/manual
  // booking from this client_email for this coach. Excludes the booking
  // we just upgraded by id. Best-effort — failures don't roll back the
  // confirmation.
  const clientEmailForCount = (meta.client_email || '').toLowerCase();
  const coachIdForCount = coachId || booking.coach_id;
  if (clientEmailForCount && coachIdForCount) {
    try {
      const priorRes = await fetch(
        `${SUPABASE_URL}/rest/v1/coach_bookings`
          + `?coach_id=eq.${encodeURIComponent(coachIdForCount)}`
          + `&client_email=eq.${encodeURIComponent(clientEmailForCount)}`
          + `&status=in.(confirmed,manual)`
          + `&id=neq.${encodeURIComponent(bookingId)}`
          + `&select=id&limit=1`,
        { headers: SB_HEADERS }
      );
      const priors = await priorRes.json().catch(() => []);
      if (Array.isArray(priors) && priors.length === 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_coach_usage`, {
          method: 'POST',
          headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
          body: JSON.stringify({ p_coach_id: coachIdForCount, p_kind: 'client' }),
        });
      }
    } catch (incErr) {
      console.warn('[stripe-webhook][booking] client-count increment failed', incErr && incErr.message);
    }
  }

  // Fire the confirmation email + zoom-meeting flow. The endpoint also runs
  // for free bookings, so the email content stays consistent across flows.
  // Failure here is non-fatal — the booking is already confirmed in the DB.
  try {
    const host = req.headers.host;
    const origin = host ? `https://${host}` : 'https://www.ineedcoaching.org';
    await fetch(`${origin}/api/booking-confirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ booking_id: bookingId }),
    });
  } catch (mailErr) {
    console.warn('[stripe-webhook][booking] booking-confirmation invocation failed', mailErr && mailErr.message);
  }

  // Notify the coach.
  const notifyCoachId = coachId || booking.coach_id;
  if (notifyCoachId) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/coach_notifications`, {
        method: 'POST',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({
          coach_id: notifyCoachId,
          type: 'new_booking',
          title: 'New paid booking',
          body: `${meta.client_name || meta.client_email || 'A client'} booked and paid for a session.`,
          link_url: '/coach-dashboard.html?tab=clients',
        }),
      });
    } catch (notifyErr) {
      console.warn('[stripe-webhook][booking] coach notification failed', notifyErr && notifyErr.message);
    }
  }

  return res.status(200).send('ok');
}

// ──────────────────────────────────────────────────────────────────────────
// Session-package completion (PR 4.A)
// ──────────────────────────────────────────────────────────────────────────
//
// Creates the client_package_purchases row that tracks credits_remaining.
// The booking flow checks this table when a client enters their email so
// they can spend a credit instead of paying again.
async function handlePackageCompleted({ session, meta, SUPABASE_URL, SB_HEADERS, res }) {
  const packageId = meta.package_id;
  const clientEmail = (meta.client_email || session.customer_details?.email || '').toLowerCase();
  const sessionCount = parseInt(meta.session_count || '0', 10);
  if (!packageId || !clientEmail || !sessionCount) {
    console.error('[stripe-webhook][package] missing metadata', meta);
    return res.status(200).send('skipped');
  }

  // Idempotency on stripe_session_id (UNIQUE constraint on the column).
  const dupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/client_package_purchases?stripe_session_id=eq.${encodeURIComponent(session.id)}&select=id`,
    { headers: SB_HEADERS }
  );
  const dups = await dupRes.json();
  if (Array.isArray(dups) && dups.length) {
    return res.status(200).send('already processed');
  }

  await fetch(`${SUPABASE_URL}/rest/v1/client_package_purchases`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify({
      client_email: clientEmail,
      coach_id: meta.coach_id || null,
      package_id: packageId,
      credits_total: sessionCount,
      credits_remaining: sessionCount,
      stripe_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent || null,
      payment_amount_cents: session.amount_total || null,
    }),
  });

  if (meta.coach_id) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/coach_notifications`, {
        method: 'POST',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({
          coach_id: meta.coach_id,
          type: 'new_booking',
          title: 'Package purchased',
          body: `${clientEmail} bought a ${sessionCount}-session package.`,
          link_url: '/coach-dashboard.html?tab=clients',
        }),
      });
    } catch (e) { /* non-fatal */ }
  }
  return res.status(200).send('ok');
}

// ──────────────────────────────────────────────────────────────────────────
// Gift-certificate completion (PR 4.A)
// ──────────────────────────────────────────────────────────────────────────
//
// Generates a unique short code, stores the gift, and fires
// /api/send-gift-certificate to email the recipient.
async function handleGiftCompleted({ session, meta, SUPABASE_URL, SB_HEADERS, req, res }) {
  const recipientEmail = (meta.recipient_email || '').toLowerCase();
  const coachId = meta.coach_id;
  if (!recipientEmail || !coachId) {
    console.error('[stripe-webhook][gift] missing metadata', meta);
    return res.status(200).send('skipped');
  }

  // Idempotency via stripe_session_id lookup.
  const dupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/gift_certificates?stripe_session_id=eq.${encodeURIComponent(session.id)}&select=id`,
    { headers: SB_HEADERS }
  );
  const dups = await dupRes.json();
  if (Array.isArray(dups) && dups.length) return res.status(200).send('already processed');

  // 12-char base32-ish code: short enough to type, long enough not to collide
  // in practice. Loop on UNIQUE collision (vanishingly rare for the lifetime
  // of this app, but cheap to handle).
  const { randomBytes } = await import('crypto');
  function genCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i++) out += alphabet[buf[i] % alphabet.length];
    return out;
  }
  const amountCents = parseInt(meta.amount_cents || '0', 10) || null;
  const sessionCount = parseInt(meta.session_count || '0', 10) || null;
  const message = meta.message || '';
  let inserted = null;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const code = genCode();
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/gift_certificates`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'return=representation' },
      body: JSON.stringify({
        coach_id: coachId,
        code,
        amount_cents: amountCents,
        session_count: sessionCount,
        purchased_by: meta.purchased_by || null,
        recipient_email: recipientEmail,
        recipient_name: meta.recipient_name || null,
        message: message || null,
        stripe_session_id: session.id,
        payment_amount_cents: session.amount_total || null,
        is_active: true,
      }),
    });
    if (insertRes.ok) {
      const rows = await insertRes.json();
      if (rows && rows[0]) inserted = rows[0];
    } else if (insertRes.status === 409) {
      // UNIQUE collision on code — try again with a fresh one.
      continue;
    } else {
      const t = await insertRes.text().catch(() => '');
      console.error('[stripe-webhook][gift] insert failed', insertRes.status, t);
      return res.status(500).send('gift_insert_failed');
    }
  }
  if (!inserted) return res.status(500).send('gift_code_collisions');

  try {
    const host = req.headers.host;
    const origin = host ? `https://${host}` : 'https://www.ineedcoaching.org';
    await fetch(`${origin}/api/send-gift-certificate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gift_id: inserted.id }),
    });
  } catch (mailErr) {
    console.warn('[stripe-webhook][gift] send invocation failed', mailErr && mailErr.message);
  }
  return res.status(200).send('ok');
}

// ──────────────────────────────────────────────────────────────────────────
// Platform-billing subscription events (Phase 2)
// ──────────────────────────────────────────────────────────────────────────
//
// Provisioning + lifecycle for the Practice $99 / Scale $249 subscriptions
// created via /api/create-subscription-checkout. Source of truth lives on
// Stripe; coach_profiles columns mirror the Stripe state per event.

function tierFromPriceId(priceId) {
  if (!priceId) return null;
  const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  const practice = mode === 'live'
    ? process.env.STRIPE_PRICE_PRACTICE_LIVE
    : process.env.STRIPE_PRICE_PRACTICE_TEST;
  const scale = mode === 'live'
    ? process.env.STRIPE_PRICE_SCALE_LIVE
    : process.env.STRIPE_PRICE_SCALE_TEST;
  if (priceId === practice) return 'practice';
  if (priceId === scale) return 'scale';
  return null;
}

function periodEndIso(subscription) {
  const ts = subscription && subscription.current_period_end;
  return Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
}

// Slugify a coach's display name (or fallback) into a URL-safe root: lowercase,
// strip non-alphanumeric (keep spaces/dashes), collapse whitespace to dashes,
// dedupe dashes, trim, cap at 60 chars. Falls back to 'coach' on empty input.
function slugifyCoachBase(value) {
  const root = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/^-|-$/g, '');
  return root || 'coach';
}

// Probe coach_profiles.slug starting from slugify(base) and append -2, -3, ...
// on collision until we find a free one. The DB has a UNIQUE constraint on
// slug, so this is best-effort — a concurrent insert could still race us;
// in that case the caller's POST/PATCH will fail with 409 and the webhook's
// retry will re-roll. Bounded to 50 tries, then a timestamp suffix as escape.
async function generateUniqueCoachSlug({ base, SUPABASE_URL, SB_HEADERS }) {
  const root = slugifyCoachBase(base);
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? root : `${root}-${i}`;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?slug=eq.${encodeURIComponent(candidate)}&select=id&limit=1`,
      { headers: SB_HEADERS }
    );
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

function isCoachSignup(subscription) {
  const meta = (subscription && subscription.metadata) || {};
  return meta.signup_intent === 'coach_subscription';
}

// Wrap a founder-cohort subscription in a subscription_schedule that bills
// the $49 founder price for 3 months and then steps up to the standard $99
// Practice price indefinitely. Idempotent: if the subscription is already
// attached to a schedule we no-op. Failures are logged but never bubble up —
// the subscription stays at $49 forever in that case, which is a worse deal
// for us but a strictly better deal for the coach, and an operator can
// manually convert it later.
async function convertToFounderSchedule({ stripe, subscription }) {
  try {
    if (subscription.schedule) {
      // Already attached to a schedule — likely a webhook retry on a sub we
      // already converted on the first attempt.
      return;
    }
    const mode = (process.env.STRIPE_MODE || 'test').toLowerCase();
    const founderPriceId = mode === 'live'
      ? process.env.STRIPE_PRICE_PRACTICE_FOUNDER_LIVE
      : process.env.STRIPE_PRICE_PRACTICE_FOUNDER_TEST;
    const standardPriceId = mode === 'live'
      ? process.env.STRIPE_PRICE_PRACTICE_LIVE
      : process.env.STRIPE_PRICE_PRACTICE_TEST;
    if (!founderPriceId || !standardPriceId) {
      console.error('[stripe-webhook][founder-schedule] missing price env vars', {
        mode,
        hasFounderPrice: !!founderPriceId,
        hasStandardPrice: !!standardPriceId,
      });
      return;
    }
    // Step 1: wrap the existing subscription in a schedule. Stripe creates a
    // single-phase schedule mirroring the current sub.
    const schedule = await stripe.subscriptionSchedules.create({
      from_subscription: subscription.id,
    });
    // Step 2: replace the phases with founder-intro + indefinite-standard.
    // iterations:3 = bill 3 cycles on this price, then auto-advance to the
    // next phase. The second phase has no iterations/end_date → indefinite.
    await stripe.subscriptionSchedules.update(schedule.id, {
      phases: [
        {
          items: [{ price: founderPriceId, quantity: 1 }],
          iterations: 3,
        },
        {
          items: [{ price: standardPriceId, quantity: 1 }],
        },
      ],
    });
    console.log('[stripe-webhook][founder-schedule] created', {
      subscriptionId: subscription.id,
      scheduleId: schedule.id,
    });
  } catch (e) {
    console.error('[stripe-webhook][founder-schedule] failed', {
      subscriptionId: subscription.id,
      error: e && e.message,
    });
  }
}

// Create or upsert the Supabase auth user for a paid coach + send the
// invite/recovery email so they can sign in. Tolerant of the user already
// existing (e.g., the email was previously a client account).
async function ensureCoachAuthUser({ email, SUPABASE_URL, SB_HEADERS }) {
  if (!email) return;
  try {
    const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: SB_HEADERS,
      body: JSON.stringify({ email, email_confirm: true }),
    });
    if (!createRes.ok && createRes.status !== 422 && createRes.status !== 409) {
      const txt = await createRes.text().catch(() => '');
      console.warn('[stripe-webhook][sub] auth user create non-ok', createRes.status, txt);
    }
  } catch (e) {
    console.warn('[stripe-webhook][sub] auth user create threw', e.message);
  }
  // Send a recovery / magic-link email so the coach can set up their
  // password and land on the dashboard. Idempotent on Supabase's side —
  // safe to re-trigger on subscription updates.
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: SB_HEADERS,
      body: JSON.stringify({ email }),
    });
  } catch (e) {
    console.warn('[stripe-webhook][sub] recover email threw', e.message);
  }
}

async function handleSubscriptionCreated({ subscription, stripe, SUPABASE_URL, SB_HEADERS, req, res }) {
  if (!isCoachSignup(subscription)) {
    // Not from /api/create-subscription-checkout — leave it alone. Connect
    // destination charges or other future subscription products won't have
    // this metadata flag.
    return res.status(200).send('not_coach_signup');
  }

  const meta = subscription.metadata || {};
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  const priceId = item && item.price && item.price.id;
  const tier = meta.tier || tierFromPriceId(priceId);
  if (!tier) {
    console.warn('[stripe-webhook][sub.created] could not resolve tier', { subId: subscription.id, priceId });
    return res.status(200).send('tier_unresolved');
  }

  // Customer email — prefer the Stripe customer, fall back to metadata.
  let email = (meta.signup_email || '').toLowerCase();
  let stripeCustomerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer && subscription.customer.id) || null;
  if (!email && stripeCustomerId) {
    try {
      const customer = await stripe.customers.retrieve(stripeCustomerId);
      if (customer && !customer.deleted && customer.email) {
        email = customer.email.toLowerCase();
      }
    } catch (e) {
      console.warn('[stripe-webhook][sub.created] customer retrieve failed', e.message);
    }
  }
  if (!email) {
    console.error('[stripe-webhook][sub.created] no email resolvable', { subId: subscription.id });
    return res.status(200).send('email_missing');
  }

  // Idempotency — if a coach_profile already carries this subscription id,
  // we've already provisioned. Treat as success.
  const dupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?stripe_subscription_id=eq.${encodeURIComponent(subscription.id)}&select=id&limit=1`,
    { headers: SB_HEADERS }
  );
  const dups = await dupRes.json().catch(() => []);
  if (Array.isArray(dups) && dups.length) {
    return res.status(200).send('already provisioned');
  }

  // Existing coach (legacy / re-signup) — patch the subscription columns.
  // Otherwise, insert a fresh row.
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?user_email=eq.${encodeURIComponent(email)}&select=id,slug&limit=1`,
    { headers: SB_HEADERS }
  );
  const existing = await existingRes.json().catch(() => []);
  const subscriptionFields = {
    subscription_tier: tier,
    subscription_status: subscription.status || 'active',
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    current_period_end: periodEndIso(subscription),
  };
  const slugBase = meta.signup_display_name || meta.signup_full_name || (email.split('@')[0] || '');
  let coachSlug = null;

  if (Array.isArray(existing) && existing.length) {
    const id = existing[0].id;
    const patchBody = { ...subscriptionFields };
    // Repair-on-resignup: if the existing row pre-dates the slug-on-insert
    // logic below and is still slugless, mint one now so the dashboard's
    // /coach/<slug> link stops 404ing for this coach.
    if (!existing[0].slug) {
      patchBody.slug = await generateUniqueCoachSlug({ base: slugBase, SUPABASE_URL, SB_HEADERS });
    }
    coachSlug = patchBody.slug || existing[0].slug;
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/coach_profiles?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify(patchBody),
      }
    );
    if (!patchRes.ok) {
      const t = await patchRes.text().catch(() => '');
      console.error('[stripe-webhook][sub.created] patch failed', patchRes.status, t);
      return res.status(500).send('patch_failed');
    }
  } else {
    coachSlug = await generateUniqueCoachSlug({ base: slugBase, SUPABASE_URL, SB_HEADERS });
    // signup_source + founder_locked_price are written on INSERT only. We
    // never overwrite them on re-signup (the PATCH path above) so the
    // original acquisition channel is preserved across subscription churn.
    const profileRow = {
      ...subscriptionFields,
      user_email: email,
      slug: coachSlug,
      is_published: true,
      full_name: meta.signup_full_name || null,
      display_name: meta.signup_display_name || meta.signup_full_name || null,
      bio: meta.signup_bio || null,
      years_experience: meta.signup_years_experience ? parseInt(meta.signup_years_experience, 10) : null,
      signup_source: meta.signup_source || 'organic',
      founder_locked_price: meta.founder_locked_price
        ? Number(meta.founder_locked_price)
        : null,
      // specialty: meta.signup_specialty — coach_profiles uses an array
      // column `specialties`, populated when the coach edits their profile.
      // We deliberately leave it null here so the coach's own selections
      // become the source of truth on first login.
    };
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/coach_profiles`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(profileRow),
    });
    if (!insertRes.ok) {
      const t = await insertRes.text().catch(() => '');
      console.error('[stripe-webhook][sub.created] insert failed', insertRes.status, t);
      return res.status(500).send('insert_failed');
    }
  }

  // Founder cohort: convert the subscription to a schedule so the price
  // automatically steps up from $49 to $99 at month 4. Runs only on
  // founder-tagged subscriptions and is a no-op if the schedule already
  // exists (idempotent across retries).
  if (meta.signup_source === 'founding_cohort') {
    await convertToFounderSchedule({ stripe, subscription });
  }

  await ensureCoachAuthUser({ email, SUPABASE_URL, SB_HEADERS });

  // Branded onboarding email (profile URL + dashboard URL + 5-step checklist).
  // Best-effort, same shape as the recovery email above: failures here are
  // caught and warn-logged but do not roll back provisioning. The Supabase
  // recovery email is the load-bearing one — without it the coach can't
  // sign in.
  try {
    const origin = req && req.headers && req.headers.host
      ? `https://${req.headers.host}`
      : 'https://www.ineedcoaching.org';
    const welcomeRes = await fetch(`${origin}/api/coach-welcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        display_name: meta.signup_display_name || meta.signup_full_name || '',
        slug: coachSlug,
      }),
    });
    if (!welcomeRes.ok) {
      const txt = await welcomeRes.text().catch(() => '');
      console.warn('[stripe-webhook][sub.created] coach-welcome non-ok', welcomeRes.status, txt);
    }
  } catch (e) {
    console.warn('[stripe-webhook][sub.created] coach-welcome invocation threw', e.message);
  }

  return res.status(200).send('provisioned');
}

async function handleSubscriptionUpdated({ subscription, SUPABASE_URL, SB_HEADERS, res }) {
  if (!isCoachSignup(subscription)) return res.status(200).send('not_coach_signup');

  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  const priceId = item && item.price && item.price.id;
  const tier = tierFromPriceId(priceId) || subscription.metadata?.tier || null;

  const patch = {
    subscription_status: subscription.status || null,
    current_period_end: periodEndIso(subscription),
  };
  if (tier) patch.subscription_tier = tier;

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?stripe_subscription_id=eq.${encodeURIComponent(subscription.id)}`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.warn('[stripe-webhook][sub.updated] patch non-ok', r.status, t);
  }
  return res.status(200).send('ok');
}

async function handleSubscriptionDeleted({ subscription, SUPABASE_URL, SB_HEADERS, res }) {
  if (!isCoachSignup(subscription)) return res.status(200).send('not_coach_signup');

  await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?stripe_subscription_id=eq.${encodeURIComponent(subscription.id)}`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({
        subscription_status: 'canceled',
        current_period_end: periodEndIso(subscription),
      }),
    }
  );
  return res.status(200).send('ok');
}

async function handleInvoicePaymentSucceeded({ invoice, stripe, SUPABASE_URL, SB_HEADERS, res }) {
  // Only renewal invoices have a subscription attached; one-off invoices skip.
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : (invoice.subscription && invoice.subscription.id) || null;
  if (!subscriptionId) return res.status(200).send('not_subscription_invoice');

  // We need the latest period_end for the renewal. Fetching the subscription
  // (rather than trusting invoice.lines) keeps the column aligned with what
  // customer.subscription.updated would write.
  let subscription = null;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (e) {
    console.warn('[stripe-webhook][invoice] retrieve subscription failed', e.message);
    return res.status(200).send('retrieve_failed');
  }
  if (!isCoachSignup(subscription)) return res.status(200).send('not_coach_signup');

  await fetch(
    `${SUPABASE_URL}/rest/v1/coach_profiles?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
    {
      method: 'PATCH',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({
        subscription_status: subscription.status || 'active',
        current_period_end: periodEndIso(subscription),
      }),
    }
  );
  return res.status(200).send('ok');
}
