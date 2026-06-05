-- Stage A — Homework: Detect → Review → Approve → Official
--
-- Two stores:
--   1. coach_session_notes.homework jsonb — AI-detected drafts (pending review).
--      Mirrors the existing post_session_analysis.goal_proposals pattern: each
--      item gets {id, handled:false, ...payload}; approval flips handled=true.
--   2. client_homework — official approved (or manually added) homework. Coach
--      reads it in the browser the same way coach_goals is read. Stage A has
--      no client SELECT policy; Stage B will add that + completed/share flags.
--
-- All writes in Stage A go through api/approve-homework.js (service role).
-- coach_bookings.id is uuid (verified pre-migration), so booking_id matches.
-- Run this once via Supabase SQL Editor.

-- 1. Draft store on the session note.
ALTER TABLE coach_session_notes
  ADD COLUMN IF NOT EXISTS homework jsonb;

-- 2. Official store.
CREATE TABLE IF NOT EXISTS client_homework (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL,
  client_email text NOT NULL,
  booking_id uuid,
  assignment_text text NOT NULL,
  type text DEFAULT 'other',     -- journal | reflection | behavioral | other
  source text DEFAULT 'ai',      -- ai | manual
  status text DEFAULT 'assigned',-- assigned (Stage B adds: completed, etc.)
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_homework_coach_client
  ON client_homework (coach_id, client_email);

ALTER TABLE client_homework ENABLE ROW LEVEL SECURITY;

-- 3. Coach SELECT policy — mirror coach_reads_own_goals exactly. The same
--    predicate maps an authenticated coach to the rows they own via
--    coach_profiles.user_email. No browser INSERT/UPDATE policy in Stage A;
--    api/approve-homework.js uses the service role.
DROP POLICY IF EXISTS coach_reads_own_homework ON client_homework;
CREATE POLICY coach_reads_own_homework ON client_homework
  FOR SELECT
  USING (
    coach_id IN (
      SELECT coach_profiles.id
      FROM coach_profiles
      WHERE lower(coach_profiles.user_email) = lower((auth.jwt() ->> 'email'))
    )
  );

-- 4. Verify
SELECT column_name FROM information_schema.columns
WHERE table_name = 'coach_session_notes' AND column_name = 'homework';  -- 1 row
SELECT count(*) FROM information_schema.tables WHERE table_name = 'client_homework';  -- 1
SELECT polname FROM pg_policy WHERE polrelid = 'client_homework'::regclass; -- coach_reads_own_homework
