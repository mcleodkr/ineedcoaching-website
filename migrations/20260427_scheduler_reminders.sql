-- Scheduler PR 1.E: reminder system (email + SMS) — run in Supabase SQL Editor
--
-- Adds the columns the cron-driven /api/process-reminders endpoint needs to
-- (a) find bookings due for a reminder and (b) record what's already been
-- sent so re-runs don't double-fire. Idempotency is enforced entirely
-- through the *_sent_at columns — the cron skips any row where the relevant
-- timestamp is already populated.

-- Coach-level reminder configuration. SMS is opt-out at the coach level so a
-- coach who hasn't onboarded with Twilio can't accidentally collect opt-ins
-- that will never fire. twilio_phone_number is reserved for a future
-- per-coach sender override; today the platform-level TWILIO_PHONE_NUMBER
-- env var is the active sender.
ALTER TABLE coach_profiles
  ADD COLUMN IF NOT EXISTS sms_reminders_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_reminder_default_timing integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS twilio_phone_number text;

-- Per-booking reminder state.
--   client_phone: already added by add_coach_scheduling_and_intake.sql; the
--     IF NOT EXISTS makes the brief's spec idempotent.
--   sms_opt_in: client checked the box at booking time. The cron also gates
--     on coach_profiles.sms_reminders_enabled, so a coach disabling SMS
--     after some clients opted in keeps existing opt-ins from firing.
--   sms_reminder_timing: 15 or 30. Defaults to 30; book.html seeds it from
--     the coach's sms_reminder_default_timing.
ALTER TABLE coach_bookings
  ADD COLUMN IF NOT EXISTS client_phone text,
  ADD COLUMN IF NOT EXISTS sms_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_reminder_timing integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS email_reminder_48h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_reminder_24h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_reminder_1h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS sms_reminder_sent_at timestamptz;

-- Constrain the timing values so a fat-fingered insert can't write a 7-min
-- timing that no UI surface knows what to do with. Drops first to keep the
-- migration idempotent if someone re-runs it after editing.
ALTER TABLE coach_profiles DROP CONSTRAINT IF EXISTS coach_profiles_sms_reminder_timing_check;
ALTER TABLE coach_profiles
  ADD CONSTRAINT coach_profiles_sms_reminder_timing_check
  CHECK (sms_reminder_default_timing IN (15, 30));

ALTER TABLE coach_bookings DROP CONSTRAINT IF EXISTS coach_bookings_sms_reminder_timing_check;
ALTER TABLE coach_bookings
  ADD CONSTRAINT coach_bookings_sms_reminder_timing_check
  CHECK (sms_reminder_timing IN (15, 30));

-- Index supports the cron's window scan. Partial on confirmed because the
-- cron never sends reminders for pending_payment / pending / cancelled rows.
CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_confirmed
  ON coach_bookings(scheduled_at)
  WHERE status = 'confirmed';
