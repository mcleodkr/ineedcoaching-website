-- Phase 2b — Post-session email idempotency column.
--
-- After a session, the client gets one email with their homework + the
-- commitments they made, so they don't lose traction. This mirrors the
-- existing reminder pattern exactly: the /api/process-reminders cron scans
-- coach_bookings off scheduled_at and uses a *_sent_at column for idempotency.
--
-- New column: post_session_email_sent_at. The cron scans for confirmed
-- bookings whose session is already past (scheduled_at in a lookback window)
-- AND post_session_email_sent_at IS NULL, calls /api/post-session-email, and
-- stamps this column ONLY after the email actually goes out (or the booking is
-- a terminal skip, e.g. no client_email). Sessions without post-session
-- content yet are left unstamped so a later cron retries once content exists.
--
-- Run this once via Supabase SQL Editor.

ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS post_session_email_sent_at timestamptz;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'coach_bookings' AND column_name = 'post_session_email_sent_at';  -- 1 row
