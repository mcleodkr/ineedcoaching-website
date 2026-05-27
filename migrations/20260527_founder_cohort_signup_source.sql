-- Founder cohort tagging on coach_profiles
--
-- Two columns:
--   signup_source         — acquisition channel: founding_cohort, organic,
--                           affiliate, referral, etc. Drives the grandfathering
--                           policy + segment analytics. Free-form text rather
--                           than an enum so future channels can be added
--                           without a migration.
--   founder_locked_price  — lifetime grandfathered monthly price in dollars
--                           (e.g., 99.00). NULL means no lock. Stripe price-
--                           object immutability is what actually holds the
--                           price; this column is a denormalized hint so
--                           future migration logic / dashboards can identify
--                           grandfathered coaches without traversing Stripe.
--
-- Both columns are nullable; existing rows stay NULL. New signups populate
-- via /api/stripe-webhook.js → handleSubscriptionCreated reading the
-- subscription's metadata fields populated by /api/create-subscription-checkout.
--
-- Idempotent — safe to re-run.

ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS signup_source TEXT;

ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS founder_locked_price NUMERIC(8,2);

-- Partial index for the /api/founder-cohort-status counter and any future
-- segment query. Only indexes non-null values — most rows will be NULL or
-- 'organic' and don't need to be indexed.
CREATE INDEX IF NOT EXISTS idx_coach_profiles_signup_source
  ON coach_profiles (signup_source)
  WHERE signup_source IS NOT NULL;

COMMENT ON COLUMN coach_profiles.signup_source IS 'Acquisition channel: founding_cohort, organic, affiliate, referral, etc. Drives grandfathering and segment analytics.';
COMMENT ON COLUMN coach_profiles.founder_locked_price IS 'Lifetime grandfathered monthly price in dollars (e.g., 99.00). NULL = no lock. Stripe price-object immutability handles actual billing; this is a denormalized hint for migration logic and dashboards.';
