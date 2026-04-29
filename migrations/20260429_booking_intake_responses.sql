-- Per-booking intake form (post-payment) — captures the client's intent and
-- context so the coach can prep for the session. One row per booking.
--
-- Distinct from coach_intake_responses (the legacy coach-defined intake
-- forms attached to coach_intake_forms). This table is the standardized
-- "first session prep" set asked at the end of /book?coach=<slug>.
--
-- RLS:
--   - INSERT: anon + authenticated. The FK to coach_bookings(id) restricts
--     writes to existing booking IDs; UNIQUE(booking_id) prevents
--     duplicate submissions. Booking IDs are 128-bit UUIDs and only
--     surfaced inside the post-payment confirmation flow, so anon write
--     is acceptable for first launch — same posture as the public
--     coach_bookings insert path.
--   - SELECT: authenticated, gated to bookings owned by the caller's
--     coach_profile (email-match pattern, mirrors
--     20260413_coach_journaling_rls.sql + 20260426_coach_notifications.sql).
--   - service_role bypasses RLS automatically.

CREATE TABLE IF NOT EXISTS booking_intake_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES coach_bookings(id) ON DELETE CASCADE,
  what_brings_you text,
  success_in_90_days text,
  whats_gotten_in_way text,
  urgency_score smallint,
  focus_area text,
  anything_else text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE booking_intake_responses
  DROP CONSTRAINT IF EXISTS booking_intake_responses_urgency_score_check;
ALTER TABLE booking_intake_responses
  ADD CONSTRAINT booking_intake_responses_urgency_score_check
  CHECK (urgency_score IS NULL OR (urgency_score BETWEEN 1 AND 10));

-- One intake per booking. Re-submissions hit a 409 the form surfaces.
CREATE UNIQUE INDEX IF NOT EXISTS booking_intake_responses_booking_id_uniq
  ON booking_intake_responses (booking_id);

ALTER TABLE booking_intake_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_intake_insert_anon ON booking_intake_responses;
CREATE POLICY booking_intake_insert_anon ON booking_intake_responses
  FOR INSERT TO anon, authenticated
  WITH CHECK (booking_id IS NOT NULL);

DROP POLICY IF EXISTS booking_intake_select_coach ON booking_intake_responses;
CREATE POLICY booking_intake_select_coach ON booking_intake_responses
  FOR SELECT TO authenticated
  USING (
    booking_id IN (
      SELECT cb.id
      FROM coach_bookings cb
      JOIN coach_profiles cp ON cp.id = cb.coach_id
      WHERE lower(cp.user_email) = lower(auth.jwt() ->> 'email')
    )
  );
