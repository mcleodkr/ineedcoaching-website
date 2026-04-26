// Stripe webhook receiver. Verifies the signature against the configured
// signing secret, then handles the events relevant to the course commerce
// flow:
//
//   checkout.session.completed → create the enrollment + purchase ledger
//                                row (idempotent on stripe_session_id).
//   charge.refunded            → mark the matching purchase row refunded.
//   charge.dispute.created     → mark disputed + write a coach notification.
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

      default:
        return res.status(200).send(`ignored:${event.type}`);
    }
  } catch (e) {
    console.error('[stripe-webhook] handler error', e);
    return res.status(500).send(e.message || 'webhook error');
  }
}
