-- Course lessons
CREATE TABLE IF NOT EXISTS coach_course_lessons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid REFERENCES coach_courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text,
  video_url text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Course enrollments
CREATE TABLE IF NOT EXISTS coach_course_enrollments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid REFERENCES coach_courses(id),
  student_email text NOT NULL,
  enrolled_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  certificate_id text UNIQUE,
  UNIQUE(course_id, student_email)
);

-- Lesson completions
CREATE TABLE IF NOT EXISTS coach_lesson_completions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  enrollment_id uuid REFERENCES coach_course_enrollments(id) ON DELETE CASCADE,
  lesson_id uuid REFERENCES coach_course_lessons(id) ON DELETE CASCADE,
  completed_at timestamptz DEFAULT now(),
  UNIQUE(enrollment_id, lesson_id)
);

-- Add fields to coach_courses
ALTER TABLE coach_courses ADD COLUMN IF NOT EXISTS slug text UNIQUE;
ALTER TABLE coach_courses ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE coach_courses ADD COLUMN IF NOT EXISTS who_its_for text;
ALTER TABLE coach_courses ADD COLUMN IF NOT EXISTS what_youll_learn jsonb DEFAULT '[]'::jsonb;
ALTER TABLE coach_courses ADD COLUMN IF NOT EXISTS syllabus jsonb DEFAULT '[]'::jsonb;
ALTER TABLE coach_courses ADD COLUMN IF NOT EXISTS certificate_template text DEFAULT 'elegant';
