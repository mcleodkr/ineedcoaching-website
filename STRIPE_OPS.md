# Stripe Connect operations

Setup checklist for the course commerce flow shipped in commit SC2.

## Env vars to set in Vercel

All three environments (Development / Preview / Production) need the same
keys. Default behavior is **test mode** when `STRIPE_MODE` is unset, so
real money is never charged accidentally.

| Var | Required | Notes |
|---|---|---|
| `STRIPE_MODE` | yes | `test` or `live`. Default `test`. Flip to `live` only after Kim's live Connect account is verified. |
| `STRIPE_SECRET_KEY_TEST` | yes (test) | Stripe test secret key (`sk_test_...`). |
| `STRIPE_SECRET_KEY_LIVE` | yes (live) | Stripe live secret key (`sk_live_...`). |
| `STRIPE_WEBHOOK_SECRET_TEST` | yes (test) | Signing secret for the test-mode webhook endpoint. |
| `STRIPE_WEBHOOK_SECRET_LIVE` | yes (live) | Signing secret for the live-mode webhook endpoint. |
| `SUPABASE_SERVICE_ROLE_KEY` | already set | Used by checkout-session + webhook to bypass RLS. |
| `SUPABASE_URL` | already set | Defaults to the production project URL when unset. |

The legacy `STRIPE_SECRET_KEY` env var still works as a fallback so existing
endpoints don't break during the switchover.

## Stripe dashboard configuration

Do this for **test mode first**, then repeat for **live mode** before
flipping `STRIPE_MODE=live`.

### 1. Enable Connect Express

Stripe Dashboard → Connect → Settings → Onboarding options
- Enable Express accounts
- Set platform branding (logo, name, color)

### 2. Create the webhook endpoint

Stripe Dashboard → Developers → Webhooks → Add endpoint
- **Endpoint URL**: `https://www.ineedcoaching.org/api/stripe-webhook`
- **Events to send**:
  - `checkout.session.completed`
  - `charge.refunded`
  - `charge.dispute.created`
- After saving, copy the **Signing secret** (`whsec_...`) and add it to
  Vercel env vars as `STRIPE_WEBHOOK_SECRET_TEST` (or `_LIVE`).

### 3. Create the platform Product + Price for Resilient Leader

Stripe Dashboard → Products → Add product
- **Name**: The Resilient Leader
- **Price**: $47.00 USD, one-time
- Copy the Price ID (`price_...`) and patch
  `coach_courses.stripe_price_id` for that course:
  ```sql
  UPDATE coach_courses
  SET stripe_price_id = 'price_xxxxxxxxxxxx'
  WHERE id = '93354b2b-f1c0-48b4-add3-16bd5a9fde89';
  ```

The Price lives on the platform account. Destination charges transfer the
net amount (price minus platform fee minus Stripe fee) to the coach's
connected account.

## Onboarding Kim

1. Sign in to coach-dashboard.html as `drkmcleod@gmail.com`.
2. Profile tab → Payments section → "Connect Stripe" button.
3. Complete the Stripe Express onboarding flow (KYC, bank account, ID).
4. Return to the dashboard. The card should now show
   "Stripe account connected" with charges/payouts enabled.
5. `coach_profiles.stripe_account_id` will be populated automatically by
   `/api/stripe-connect-link`.

## Test the end-to-end flow

In test mode:
1. Open course-detail.html for Resilient Leader as a fresh email.
2. Click Enroll → modal collects email + cert name → submit.
3. Stripe Checkout (test mode card `4242 4242 4242 4242`).
4. Stripe redirects to
   `/classroom.html?course=<id>&session_id=cs_test_xxx`.
5. Webhook fires → enrollment + purchase rows written.
6. Classroom auto-opens the course (enrollment now exists).
7. Coach dashboard → Courses tab → Revenue panel shows the new payout.
8. Coach dashboard → bell icon → "New course enrollment" notification.

## Switching to live mode

1. Verify the test flow works end to end.
2. Repeat dashboard configuration in live mode (Connect, webhook,
   Product/Price).
3. In Vercel: set `STRIPE_MODE=live`.
4. Redeploy (or wait for the next push — the env var is read at request
   time so a redeploy isn't strictly required, but a fresh deploy makes
   the cutover explicit).
5. Smoke a $1 test purchase against the live account before announcing.

## What to monitor

- `coach_course_purchases.status` — refunds and disputes update this
  field automatically via webhook.
- Stripe dashboard → Connect → Connected accounts — verify Kim's
  account stays in good standing (charges_enabled, payouts_enabled).
- `coach_notifications` rows of type `new_message` with title
  "Dispute opened on a course purchase" — these need manual triage.
