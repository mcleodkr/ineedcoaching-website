-- Records every quiz submission so the classroom can gate lesson completion
-- on quiz pass and the coach view can show per-student attempt history.

CREATE TABLE IF NOT EXISTS coach_course_quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES coach_course_enrollments(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL REFERENCES coach_course_quizzes(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES coach_course_lessons(id) ON DELETE CASCADE,
  student_email text NOT NULL,
  answers jsonb NOT NULL,
  score numeric(5,2) NOT NULL,
  passed boolean NOT NULL,
  attempt_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_enrollment
  ON coach_course_quiz_attempts(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_lesson
  ON coach_course_quiz_attempts(lesson_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_student_lesson
  ON coach_course_quiz_attempts(lower(student_email), lesson_id);

ALTER TABLE coach_course_quiz_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quiz_attempts_student_read" ON coach_course_quiz_attempts;
CREATE POLICY "quiz_attempts_student_read" ON coach_course_quiz_attempts FOR SELECT
  USING (lower(student_email) = lower(auth.jwt()->>'email'));

DROP POLICY IF EXISTS "quiz_attempts_student_insert" ON coach_course_quiz_attempts;
CREATE POLICY "quiz_attempts_student_insert" ON coach_course_quiz_attempts FOR INSERT
  WITH CHECK (lower(student_email) = lower(auth.jwt()->>'email'));

DROP POLICY IF EXISTS "quiz_attempts_coach_read" ON coach_course_quiz_attempts;
CREATE POLICY "quiz_attempts_coach_read" ON coach_course_quiz_attempts FOR SELECT
  USING (
    lesson_id IN (
      SELECT l.id FROM coach_course_lessons l
      JOIN coach_courses c ON c.id = l.course_id
      JOIN coach_profiles p ON p.id = c.coach_id
      WHERE lower(p.user_email) = lower(auth.jwt()->>'email')
    )
  );
