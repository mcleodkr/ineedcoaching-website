-- Phase 1 — Coach subscription foundation
-- Additive columns on coach_profiles for the Practice $99 / Scale $179 tier
-- system. Pure schema — no data backfill, no behavior change. Phase 2
-- (subscription checkout endpoint + webhook events) reads/writes these
-- columns; the dashboard usage panel (phase 4) reads the counters.
--
-- Stripe live-mode products + prices (created via Stripe MCP, 2026-04-29):
--   Practice  prod_UQODcXZQuOxQEK  price_1TRXRKKMH7e8DY6G4NJAqZZW  $99/mo
--   Scale     prod_UQODBCfQLwyYhi  price_1TRXRRKMH7e8DY6GIOMK078s  $179/mo
--
-- Set in Vercel env (Production + Preview):
--   STRIPE_PRICE_PRACTICE_LIVE=price_1TRXRKKMH7e8DY6G4NJAqZZW
--   STRIPE_PRICE_SCALE_LIVE=price_1TRXRRKMH7e8DY6GIOMK078s
-- Test-mode prices are deferred — current signup is disabled and the
-- first launch coaches will be monitored manually against live mode.
-- When test prices are added, follow the existing STRIPE_MODE pattern
-- (see api/stripe-webhook.js): STRIPE_PRICE_PRACTICE_TEST / _SCALE_TEST.
--
-- Existing coach_profiles rows (legacy $47 founding-rate coaches) are left
-- untouched. A grandfathering / migration plan is a separate brief.

ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS subscription_tier text,
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS monthly_client_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monthly_session_count integer NOT NULL DEFAULT 0;

-- Tier — practice ($99/mo, 20 clients, ~60 sessions) or scale
-- ($179/mo, 60 clients, ~180 sessions). NULL = legacy / not on the new
-- tier system yet.
ALTER TABLE coach_profiles
  DROP CONSTRAINT IF EXISTS coach_profiles_subscription_tier_check;
ALTER TABLE coach_profiles
  ADD CONSTRAINT coach_profiles_subscription_tier_check
  CHECK (subscription_tier IS NULL OR subscription_tier IN ('practice', 'scale'));

-- Status — mirrors the full Stripe subscription.status set so the webhook
-- can write any value Stripe emits without enum drift. The dashboard treats
-- 'active' and 'trialing' as paying, everything else as not.
ALTER TABLE coach_profiles
  DROP CONSTRAINT IF EXISTS coach_profiles_subscription_status_check;
ALTER TABLE coach_profiles
  ADD CONSTRAINT coach_profiles_subscription_status_check
  CHECK (subscription_status IS NULL OR subscription_status IN (
    'active',
    'trialing',
    'past_due',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'unpaid',
    'paused'
  ));

-- Counters — incremented on each client add / session run (per phase 1
-- decision). Reconciliation cron can reset / true-up monthly later.
ALTER TABLE coach_profiles
  DROP CONSTRAINT IF EXISTS coach_profiles_monthly_client_count_nonneg;
ALTER TABLE coach_profiles
  ADD CONSTRAINT coach_profiles_monthly_client_count_nonneg
  CHECK (monthly_client_count >= 0);

ALTER TABLE coach_profiles
  DROP CONSTRAINT IF EXISTS coach_profiles_monthly_session_count_nonneg;
ALTER TABLE coach_profiles
  ADD CONSTRAINT coach_profiles_monthly_session_count_nonneg
  CHECK (monthly_session_count >= 0);

-- Lookups — webhook resolves a row by Stripe customer or subscription ID
-- on every event, and the admin dashboard filters by status. Partial
-- indexes keep the index small (most rows are legacy / NULL).
CREATE UNIQUE INDEX IF NOT EXISTS coach_profiles_stripe_customer_id_uniq
  ON coach_profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS coach_profiles_stripe_subscription_id_uniq
  ON coach_profiles (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS coach_profiles_subscription_status_idx
  ON coach_profiles (subscription_status)
  WHERE subscription_status IS NOT NULL;

-- The Stripe IDs are not secrets but they're not interesting to surface
-- via PostgREST select=* either. Leaving SELECT grants on these columns
-- so the dashboard can show "managed by Stripe" / "active subscription"
-- state without an extra fetch — they're already present in Stripe and
-- exposing them client-side is no worse than what's already shipping.
