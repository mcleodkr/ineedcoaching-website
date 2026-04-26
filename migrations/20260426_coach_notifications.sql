-- Coach-facing notifications. type is constrained so the dashboard renderer
-- can route each variant to the right link target. is_read drives the
-- bell-icon unread badge and the inline landing stripe.

CREATE TABLE IF NOT EXISTS coach_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('course_completion','new_message','new_booking','new_journal','new_checkin','certificate_generated')),
  title text NOT NULL,
  body text,
  link_url text,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_coach_unread
  ON coach_notifications(coach_id, is_read, created_at DESC);

ALTER TABLE coach_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_coach_read" ON coach_notifications;
CREATE POLICY "notifications_coach_read" ON coach_notifications FOR SELECT
  USING (coach_id IN (
    SELECT id FROM coach_profiles WHERE lower(user_email) = lower(auth.jwt()->>'email')
  ));

DROP POLICY IF EXISTS "notifications_coach_update" ON coach_notifications;
CREATE POLICY "notifications_coach_update" ON coach_notifications FOR UPDATE
  USING (coach_id IN (
    SELECT id FROM coach_profiles WHERE lower(user_email) = lower(auth.jwt()->>'email')
  ));

DROP POLICY IF EXISTS "notifications_open_insert" ON coach_notifications;
CREATE POLICY "notifications_open_insert" ON coach_notifications FOR INSERT
  WITH CHECK (true);

UPDATE coach_courses
SET course_password = NULL
WHERE id = '93354b2b-f1c0-48b4-add3-16bd5a9fde89';
