-- Brief 1: client self-serve cancel — manual-review flag.
-- Run in Supabase SQL Editor.
--
-- When client-initiated cancellation fee math succeeds but the Stripe refund
-- call fails (network blip, missing payment intent, partial-refund edge
-- case), we keep the booking in status='confirmed' rather than leaving a
-- half-cancelled row. The flag surfaces the booking to the coach for manual
-- handling and is cleared when they finish reviewing.
--
-- Boolean (rather than a status enum) so we can reuse the same flag for
-- other manual-review scenarios later (failed reschedules, disputed
-- charges) without enum migrations.

ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS needs_manual_review boolean NOT NULL DEFAULT false;

-- Partial index — almost every row stays false, so the index only carries
-- the small set the coach actually needs to review.
CREATE INDEX IF NOT EXISTS idx_bookings_needs_manual_review
  ON coach_bookings(needs_manual_review)
  WHERE needs_manual_review = true;
