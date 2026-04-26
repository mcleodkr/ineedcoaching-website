-- Per-course platform fee. Default 10% applies platform-wide; admin can
-- override per course for special deals. Coach UI shows the math but can't
-- edit the column directly.
ALTER TABLE coach_courses
  ADD COLUMN IF NOT EXISTS platform_fee_percentage numeric(5,2) NOT NULL DEFAULT 10.00;

-- Stripe checkout ledger. One row per successful purchase. application_fee
-- and Stripe processing fee are recorded so the coach view can reconcile
-- against their connected-account balance.
CREATE TABLE IF NOT EXISTS coach_course_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid REFERENCES coach_course_enrollments(id) ON DELETE SET NULL,
  course_id uuid NOT NULL REFERENCES coach_courses(id),
  coach_id uuid NOT NULL REFERENCES coach_profiles(id),
  student_email text NOT NULL,
  stripe_session_id text NOT NULL UNIQUE,
  stripe_payment_intent_id text,
  amount_paid_cents integer NOT NULL,
  platform_fee_cents integer NOT NULL,
  stripe_fee_cents integer,
  coach_payout_cents integer NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','refunded','disputed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchases_coach ON coach_course_purchases(coach_id);
CREATE INDEX IF NOT EXISTS idx_purchases_course ON coach_course_purchases(course_id);

ALTER TABLE coach_course_purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "purchases_coach_read" ON coach_course_purchases;
CREATE POLICY "purchases_coach_read" ON coach_course_purchases FOR SELECT
  USING (coach_id IN (
    SELECT id FROM coach_profiles WHERE lower(user_email) = lower(auth.jwt()->>'email')
  ));

-- The webhook writes via service-role (bypasses RLS) so no INSERT policy
-- is needed. Keeping default deny for client-side inserts is correct.
