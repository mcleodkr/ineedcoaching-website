-- Adds coach link + pattern fields to explorer_checkins, backfills, and
-- replaces the wide-open RLS policies with email-scoped ones.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS, and the
-- WHERE coach_id IS NULL guard make this safe to re-run.

ALTER TABLE explorer_checkins
  ADD COLUMN IF NOT EXISTS coach_id uuid REFERENCES coach_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pattern_response text,
  ADD COLUMN IF NOT EXISTS pattern_referenced text;

CREATE INDEX IF NOT EXISTS idx_explorer_checkins_coach_id
  ON explorer_checkins(coach_id);

CREATE INDEX IF NOT EXISTS idx_explorer_checkins_user_email_date
  ON explorer_checkins(lower(user_email), created_at DESC);

UPDATE explorer_checkins ec
SET coach_id = sub.coach_id
FROM (
  SELECT DISTINCT ON (lower(cb.client_email))
    lower(cb.client_email) AS client_email,
    cb.coach_id
  FROM coach_bookings cb
  WHERE cb.status IN ('confirmed', 'manual')
    AND cb.coach_id IS NOT NULL
  ORDER BY lower(cb.client_email), cb.scheduled_at DESC NULLS LAST, cb.created_at DESC NULLS LAST
) sub
WHERE lower(ec.user_email) = sub.client_email
  AND ec.coach_id IS NULL;

DROP POLICY IF EXISTS "Allow insert for all" ON explorer_checkins;
DROP POLICY IF EXISTS "Allow public insert on student_checkins" ON explorer_checkins;
DROP POLICY IF EXISTS "Allow public select on student_checkins" ON explorer_checkins;
DROP POLICY IF EXISTS "Allow select own" ON explorer_checkins;

DROP POLICY IF EXISTS "checkins_client_read" ON explorer_checkins;
DROP POLICY IF EXISTS "checkins_client_insert" ON explorer_checkins;
DROP POLICY IF EXISTS "checkins_coach_read" ON explorer_checkins;

CREATE POLICY "checkins_client_read" ON explorer_checkins FOR SELECT
  USING (lower(user_email) = lower(auth.jwt()->>'email'));

CREATE POLICY "checkins_client_insert" ON explorer_checkins FOR INSERT
  WITH CHECK (lower(user_email) = lower(auth.jwt()->>'email'));

CREATE POLICY "checkins_coach_read" ON explorer_checkins FOR SELECT
  USING (
    coach_id IN (
      SELECT id FROM coach_profiles
      WHERE lower(user_email) = lower(auth.jwt()->>'email')
    )
  );
