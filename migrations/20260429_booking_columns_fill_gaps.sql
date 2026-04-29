-- Fill schema gaps in coach_bookings that book.html and the dashboard
-- write to but no prior migration created.
--
-- Without these columns, every public booking insert returns 400 with
-- "Could not find the 'client_name' column of 'coach_bookings' in the
-- schema cache" (PostgREST). The error's JSON `hint` field is what
-- some clients surface back as the user-visible message.
--
-- IMPORTANT: this migration is additive. Run it BEFORE re-deploying.
-- If you have not yet run these earlier migrations, run them first
-- (each is idempotent via IF NOT EXISTS):
--   migrations/20260427_scheduler_paid_bookings.sql  -- adds the
--     stripe_session_id / payment_amount_cents / fee columns the
--     webhook + analytics code reads.
--   migrations/20260427_scheduler_phase3.sql         -- adds the
--     reschedule_token + refund_* columns.

ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS service_name text,
  ADD COLUMN IF NOT EXISTS service_price numeric(10, 2);

-- service_price stored as numeric(10,2) to match the dollars-and-cents
-- value book.html submits (Number(selectedService.price || 0)). The
-- payment_amount_cents column from 20260427_scheduler_paid_bookings is
-- the integer-cents canonical for billing math; service_price is the
-- catalog price snapshot at booking time.
