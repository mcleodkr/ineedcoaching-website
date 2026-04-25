-- Chunk 6.7: track whether each Revise call had a prior plan to accumulate
-- against. Lets analytics distinguish accumulate-mode revisions from reset-
-- mode (no prior plan existed) so we can answer "what fraction of revises
-- actually layered on top of something" for debugging + pricing math.
ALTER TABLE session_plan_actions
  ADD COLUMN IF NOT EXISTS had_prior_plan boolean NULL;
