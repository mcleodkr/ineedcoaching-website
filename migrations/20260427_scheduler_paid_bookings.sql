-- Scheduler PR 1.D: paid bookings via Stripe Checkout — run in Supabase SQL Editor
--
-- Adds the columns the Stripe webhook needs to upgrade a pending_payment row
-- to confirmed and to record the fee breakdown for reconciliation.
--
-- Status values used by the scheduler:
--   pending          legacy "coach hasn't confirmed yet" (coach-profile.html flow)
--   confirmed        booked + paid (or free); /api/availability-slots excludes
--   manual           coach added directly in the dashboard
--   pending_payment  NEW: booking row exists but Stripe payment not yet confirmed.
--                    The slot endpoint intentionally does NOT exclude this status
--                    yet — see PR 1.D commit for the deferred slot-lock note.

ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS stripe_session_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS payment_amount_cents integer,
  ADD COLUMN IF NOT EXISTS platform_fee_cents integer,
  ADD COLUMN IF NOT EXISTS stripe_fee_cents integer,
  ADD COLUMN IF NOT EXISTS coach_payout_cents integer;

-- Webhook idempotency: if Stripe re-delivers checkout.session.completed for the
-- same session, the second delivery short-circuits via this UNIQUE index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_stripe_session
  ON coach_bookings(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
