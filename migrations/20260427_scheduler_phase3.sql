-- Scheduler Phase 3 (PR 3.A): refund tracking + client self-serve reschedule
-- tokens. Run in Supabase SQL Editor.

ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS refund_id text,
  ADD COLUMN IF NOT EXISTS refund_amount_cents integer,
  ADD COLUMN IF NOT EXISTS refund_status text,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  -- Token granted when /api/booking-confirmation fires for the row. The
  -- client-side reschedule.html page validates this against the URL token.
  -- Null until first confirmation; rotated only if regenerated server-side.
  ADD COLUMN IF NOT EXISTS reschedule_token text,
  ADD COLUMN IF NOT EXISTS reschedule_token_expires_at timestamptz;

-- Lookup index for the public reschedule flow. Partial because the column
-- is null on most rows (anything pre-PR 3.A).
CREATE INDEX IF NOT EXISTS idx_bookings_reschedule_token
  ON coach_bookings(reschedule_token)
  WHERE reschedule_token IS NOT NULL;
