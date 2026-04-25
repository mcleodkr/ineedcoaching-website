-- Session plan actions audit — supports usage analytics on the Edit / Revise
-- flows added in chunk 6.5. One row per coach action; lets us answer:
--   - distribution of Revises per plan
--   - per-coach edit/revise behavior + average revision_context length
--   - outliers (coaches revising the same plan many times)
--
-- session_plan_id semantics: the plan the action was performed against.
--   action='edit'   → the plan whose columns were updated (id stable across edits)
--   action='revise' → the NEW plan that resulted from the revision (the durable
--                     artifact). Chain-level analytics group by booking_id.

CREATE TABLE IF NOT EXISTS session_plan_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_plan_id uuid NOT NULL,
  coach_id uuid,
  client_email text,
  booking_id uuid,
  action text NOT NULL CHECK (action IN ('revise','edit')),
  edited_fields text[],                 -- populated when action='edit'
  revision_context text,                -- populated when action='revise' (full text)
  revision_context_length integer,      -- populated when action='revise'
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_plan_actions_plan_idx
  ON session_plan_actions(session_plan_id);
CREATE INDEX IF NOT EXISTS session_plan_actions_coach_idx
  ON session_plan_actions(coach_id);
CREATE INDEX IF NOT EXISTS session_plan_actions_booking_idx
  ON session_plan_actions(booking_id);
CREATE INDEX IF NOT EXISTS session_plan_actions_action_created_idx
  ON session_plan_actions(action, created_at DESC);

ALTER TABLE session_plan_actions ENABLE ROW LEVEL SECURITY;
-- Server-side endpoints write via service role key (bypasses RLS). No
-- client-side reads in this chunk; analytics queries run from SQL Editor.
