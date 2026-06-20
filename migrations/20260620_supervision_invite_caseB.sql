-- Supervision two-fixes ticket
-- Applied to prod 2026-06-20 via Supabase (migration: supervision_invite_caseB).

-- Fix 1 (Case B Lite): allow inviting a supervisor who has no account yet.
ALTER TABLE public.supervision_relationships
  ADD COLUMN IF NOT EXISTS invited_supervisor_email text;

-- supervisor_id must be nullable to hold a pending Case B invite (resolved on signup).
ALTER TABLE public.supervision_relationships
  ALTER COLUMN supervisor_id DROP NOT NULL;

-- Prevent duplicate unresolved Case B invites for the same supervisee + email.
-- (The existing UNIQUE(supervisor_id, supervisee_id) does not constrain NULL supervisor_id rows.)
CREATE UNIQUE INDEX IF NOT EXISTS supervision_pending_invite_uniq
  ON public.supervision_relationships (supervisee_id, lower(invited_supervisor_email))
  WHERE supervisor_id IS NULL AND invited_supervisor_email IS NOT NULL;

-- Fix 2: persistent opt-in so a coach can reveal the Supervision tab before any
-- relationship row exists (default hidden for the independent coach).
ALTER TABLE public.coach_profiles
  ADD COLUMN IF NOT EXISTS supervision_opt_in boolean NOT NULL DEFAULT false;
