-- Chunk 5.x: per-section coach notes — append-only audit array on intervention_plans
-- Separate from coach_edits[] (which captures replace-style section overwrites).
-- The /api/intervention-plan-section endpoint append-semantics this column when
-- section='coach_notes' so concurrent notes can't race.
ALTER TABLE intervention_plans
  ADD COLUMN IF NOT EXISTS coach_notes jsonb NOT NULL DEFAULT '[]'::jsonb;
