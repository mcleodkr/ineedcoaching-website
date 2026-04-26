-- Course classroom — data integrity + CE tracker + reflections
-- Run this entire file in the Supabase SQL Editor.
-- Sub-groups A2, B1, B2 from the brief, plus storage bucket setup.
--
-- BEFORE RUNNING:
--   1. Take a quick database snapshot or note current row counts so the
--      backfill in section A2 can be verified.
--   2. After this migration runs, create a Storage bucket named
--      "ce-certificates" via the Supabase Studio UI (Storage → New bucket).
--      Bucket should be PRIVATE (signed URLs only). RLS policies for it
--      live in the final section of this file.
--
-- Order of operations matters: A2's NOT NULL must come AFTER backfill,
-- and the new tables reference coach_courses + coach_course_lessons +
-- coach_course_enrollments + coach_profiles (all already present).

-- ──────────────────────────────────────────────────────────────────────
-- A2 · Backfill coach_course_lessons.course_id, then enforce NOT NULL
-- ──────────────────────────────────────────────────────────────────────
-- The live data has lesson rows with course_id = null but module_id set.
-- Pull course_id from the parent module before adding the constraint.

UPDATE coach_course_lessons l
SET course_id = m.course_id
FROM coach_course_modules m
WHERE l.module_id = m.id
  AND l.course_id IS NULL;

-- Sanity check — must return 0 before the NOT NULL constraint runs.
DO $$
DECLARE
  null_count int;
BEGIN
  SELECT COUNT(*) INTO null_count FROM coach_course_lessons WHERE course_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'Backfill incomplete: % lesson rows still have null course_id (likely orphaned — module_id points to a missing module).', null_count;
  END IF;
END $$;

ALTER TABLE coach_course_lessons
  ALTER COLUMN course_id SET NOT NULL;

-- ──────────────────────────────────────────────────────────────────────
-- B1 · coach_ce_hours_log + coach_courses CCE columns
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coach_ce_hours_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('platform_auto', 'manual')),
  hours numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 100),
  category text NOT NULL CHECK (category IN ('core_competencies', 'resource_development')),
  event_date date NOT NULL,
  event_name text NOT NULL,
  provider text,
  notes text,
  certificate_url text,
  -- Platform auto-log linkage (null for manual entries).
  course_id uuid REFERENCES coach_courses(id) ON DELETE SET NULL,
  lesson_id uuid REFERENCES coach_course_lessons(id) ON DELETE SET NULL,
  enrollment_id uuid REFERENCES coach_course_enrollments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ce_hours_coach_id ON coach_ce_hours_log(coach_id);
CREATE INDEX IF NOT EXISTS idx_ce_hours_event_date ON coach_ce_hours_log(event_date DESC);

-- Idempotency uniqueness for platform_auto rows: one row per (coach,
-- lesson, enrollment) so re-marking a lesson never double-logs.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ce_hours_platform_auto
  ON coach_ce_hours_log(coach_id, lesson_id, enrollment_id)
  WHERE source = 'platform_auto';

ALTER TABLE coach_courses
  ADD COLUMN IF NOT EXISTS cce_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cce_hours_per_lesson numeric(4,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cce_category text
    CHECK (cce_category IN ('core_competencies', 'resource_development'));

-- RLS: a coach can read and write only their own CE log rows.
ALTER TABLE coach_ce_hours_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ce_hours_owner_read" ON coach_ce_hours_log;
CREATE POLICY "ce_hours_owner_read" ON coach_ce_hours_log
  FOR SELECT
  USING (
    coach_id IN (
      SELECT id FROM coach_profiles WHERE user_email = lower(auth.jwt()->>'email')
    )
  );

DROP POLICY IF EXISTS "ce_hours_owner_insert" ON coach_ce_hours_log;
CREATE POLICY "ce_hours_owner_insert" ON coach_ce_hours_log
  FOR INSERT
  WITH CHECK (
    coach_id IN (
      SELECT id FROM coach_profiles WHERE user_email = lower(auth.jwt()->>'email')
    )
  );

DROP POLICY IF EXISTS "ce_hours_owner_update" ON coach_ce_hours_log;
CREATE POLICY "ce_hours_owner_update" ON coach_ce_hours_log
  FOR UPDATE
  USING (
    coach_id IN (
      SELECT id FROM coach_profiles WHERE user_email = lower(auth.jwt()->>'email')
    )
  );

DROP POLICY IF EXISTS "ce_hours_owner_delete" ON coach_ce_hours_log;
CREATE POLICY "ce_hours_owner_delete" ON coach_ce_hours_log
  FOR DELETE
  USING (
    coach_id IN (
      SELECT id FROM coach_profiles WHERE user_email = lower(auth.jwt()->>'email')
    )
  );

-- ──────────────────────────────────────────────────────────────────────
-- B2 · coach_course_reflections + lesson reflection_prompt column
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coach_course_reflections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES coach_course_enrollments(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES coach_course_lessons(id) ON DELETE CASCADE,
  student_email text NOT NULL,
  reflection_prompt text,
  reflection_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reflections_enrollment ON coach_course_reflections(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_reflections_lesson ON coach_course_reflections(lesson_id);

-- One reflection per (enrollment, lesson). Upsert-friendly.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reflection_enrollment_lesson
  ON coach_course_reflections(enrollment_id, lesson_id);

ALTER TABLE coach_course_lessons
  ADD COLUMN IF NOT EXISTS reflection_prompt text;

-- RLS: students see/edit their own reflections; the course author
-- (coach who owns the course via coach_courses.coach_id → coach_profiles)
-- can read all reflections on their courses but cannot edit student text.
ALTER TABLE coach_course_reflections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reflections_student_read" ON coach_course_reflections;
CREATE POLICY "reflections_student_read" ON coach_course_reflections
  FOR SELECT
  USING (lower(student_email) = lower(auth.jwt()->>'email'));

DROP POLICY IF EXISTS "reflections_student_insert" ON coach_course_reflections;
CREATE POLICY "reflections_student_insert" ON coach_course_reflections
  FOR INSERT
  WITH CHECK (lower(student_email) = lower(auth.jwt()->>'email'));

DROP POLICY IF EXISTS "reflections_student_update" ON coach_course_reflections;
CREATE POLICY "reflections_student_update" ON coach_course_reflections
  FOR UPDATE
  USING (lower(student_email) = lower(auth.jwt()->>'email'));

DROP POLICY IF EXISTS "reflections_author_read" ON coach_course_reflections;
CREATE POLICY "reflections_author_read" ON coach_course_reflections
  FOR SELECT
  USING (
    lesson_id IN (
      SELECT l.id
      FROM coach_course_lessons l
      JOIN coach_courses c ON c.id = l.course_id
      JOIN coach_profiles p ON p.id = c.coach_id
      WHERE p.user_email = lower(auth.jwt()->>'email')
    )
  );

-- updated_at trigger so PATCHes don't have to manage it client-side.
CREATE OR REPLACE FUNCTION coach_course_reflections_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_coach_course_reflections_updated_at ON coach_course_reflections;
CREATE TRIGGER trg_coach_course_reflections_updated_at
  BEFORE UPDATE ON coach_course_reflections
  FOR EACH ROW EXECUTE FUNCTION coach_course_reflections_touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- Storage · ce-certificates bucket policies
-- ──────────────────────────────────────────────────────────────────────
-- After creating the bucket via Supabase Studio UI (Storage → New bucket,
-- name "ce-certificates", set Private), run these policies. The path
-- convention used by the upload code is: <coach_id>/<uuid>.<ext>
-- so the coach_id segment in the path is what we authorize on.

DROP POLICY IF EXISTS "ce_cert_owner_read" ON storage.objects;
CREATE POLICY "ce_cert_owner_read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'ce-certificates'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM coach_profiles WHERE user_email = lower(auth.jwt()->>'email')
    )
  );

DROP POLICY IF EXISTS "ce_cert_owner_insert" ON storage.objects;
CREATE POLICY "ce_cert_owner_insert" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'ce-certificates'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM coach_profiles WHERE user_email = lower(auth.jwt()->>'email')
    )
  );

DROP POLICY IF EXISTS "ce_cert_owner_delete" ON storage.objects;
CREATE POLICY "ce_cert_owner_delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'ce-certificates'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM coach_profiles WHERE user_email = lower(auth.jwt()->>'email')
    )
  );

-- ──────────────────────────────────────────────────────────────────────
-- Done. After running:
--   1. Verify backfill: SELECT COUNT(*) FROM coach_course_lessons WHERE course_id IS NULL;  -- should be 0
--   2. Confirm new tables exist: \d coach_ce_hours_log  /  \d coach_course_reflections
--   3. Create the "ce-certificates" Storage bucket via Studio if not done
--      already (the policies above are no-ops until the bucket exists).
