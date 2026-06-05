-- Stage B — Homework: client-side see/do/share + coach visibility of status
--
-- Adds three columns to client_homework and two new RLS policies so the
-- signed-in client can read & update their own homework rows (mark done,
-- choose whether to share with the coach). Coach reads remain governed by
-- the existing coach_reads_own_homework SELECT policy from Stage A.
--
-- Stage A writes still go through api/approve-homework.js (service role,
-- bypasses RLS), so no INSERT policy is added here. Client writes are pure
-- PATCH from the browser via the authenticated supabase client.
--
-- Predicates verified against the live coach_goals policies before writing
-- and replicated byte-identically below.

-- 1. New columns.
ALTER TABLE client_homework
  ADD COLUMN IF NOT EXISTS completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS shared_with_coach boolean NOT NULL DEFAULT false;

-- 2. Client SELECT — only assigned rows owned by the signed-in client.
--    The status='assigned' filter is belt-and-suspenders: drafts never
--    appear on client_homework, but future statuses (archived, etc.)
--    shouldn't leak to the client either.
DROP POLICY IF EXISTS client_reads_own_homework ON client_homework;
CREATE POLICY client_reads_own_homework ON client_homework
  FOR SELECT
  USING (
    lower(client_email) = lower((auth.jwt() ->> 'email'::text))
    AND status = 'assigned'
  );

-- 3. Client UPDATE — own rows only. Postgres RLS is row-level (not
--    column-level), so the client can technically PATCH any column on a
--    row they own. Same posture as coach_goals.client_updates_own_goals.
DROP POLICY IF EXISTS client_updates_own_homework ON client_homework;
CREATE POLICY client_updates_own_homework ON client_homework
  FOR UPDATE
  USING (lower(client_email) = lower((auth.jwt() ->> 'email'::text)))
  WITH CHECK (lower(client_email) = lower((auth.jwt() ->> 'email'::text)));

-- 4. Verify
SELECT column_name FROM information_schema.columns
WHERE table_name = 'client_homework'
  AND column_name IN ('completed', 'completed_at', 'shared_with_coach')
ORDER BY column_name; -- expect 3 rows

SELECT polname, polcmd FROM pg_policy
WHERE polrelid = 'client_homework'::regclass
ORDER BY polname; -- expect: client_reads_own_homework (r),
                  --         client_updates_own_homework (w),
                  --         coach_reads_own_homework (r)
