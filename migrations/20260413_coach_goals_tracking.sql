-- Track who created and completed a goal — run in Supabase SQL Editor
ALTER TABLE coach_goals ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE coach_goals ADD COLUMN IF NOT EXISTS completed_by text;
-- progress_marker lets us distinguish "Still working" from "Small win" while both
-- share status = 'in_progress' (the CHECK constraint doesn't allow small_win).
ALTER TABLE coach_goals ADD COLUMN IF NOT EXISTS progress_marker text;
