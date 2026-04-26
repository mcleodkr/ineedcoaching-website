-- Adds the certificate_id column the classroom.html "Generate Certificate"
-- flow has been trying to write since b9e8791. Without this column the
-- PATCH silently 4xx'd and certificates never persisted.
ALTER TABLE coach_course_enrollments
  ADD COLUMN IF NOT EXISTS certificate_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_certificate_id
  ON coach_course_enrollments(certificate_id)
  WHERE certificate_id IS NOT NULL;
