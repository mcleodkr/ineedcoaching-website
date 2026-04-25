-- Chunk 4: Goals as connective tissue — run in Supabase SQL Editor
-- Evolves coach_goals (product-aware metadata, lifecycle timestamps,
-- proposed_by/approved_by audit) and adds goal_revisions for change history.
--
-- DEVIATION FROM SPEC: duration_days drops the COALESCE(completed_at, now())
-- fallback because Postgres rejects STABLE functions (now()) inside STORED
-- generated columns. Column is NULL until completed_at is set, which is the
-- semantically correct behavior for a "duration" measurement anyway.

-- ── evolve coach_goals ──────────────────────────────────────────────────
ALTER TABLE coach_goals
  ADD COLUMN IF NOT EXISTS product_context text NOT NULL DEFAULT 'coaching'
    CHECK (product_context IN ('coaching','therapy')),
  ADD COLUMN IF NOT EXISTS coaching_data jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS clinical_data jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS duration_days int GENERATED ALWAYS AS
    (EXTRACT(DAY FROM (completed_at - created_at))::int) STORED,
  ADD COLUMN IF NOT EXISTS last_session_evidence_at timestamptz,
  ADD COLUMN IF NOT EXISTS proposed_by text DEFAULT 'coach'
    CHECK (proposed_by IN ('coach','ai')),
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- ── expand status set ───────────────────────────────────────────────────
ALTER TABLE coach_goals DROP CONSTRAINT IF EXISTS coach_goals_status_check;
ALTER TABLE coach_goals ALTER COLUMN status SET DEFAULT 'active';

-- map legacy statuses BEFORE re-adding the CHECK so the UPDATE doesn't
-- fail against the new constraint mid-migration
UPDATE coach_goals SET status = 'active'      WHERE status = 'not_started';
UPDATE coach_goals SET status = 'progressing' WHERE status = 'in_progress';

ALTER TABLE coach_goals ADD CONSTRAINT coach_goals_status_check
  CHECK (status IN ('proposed','active','progressing','stalled','blocked','revised','completed','archived'));

-- ── goal_revisions: change history (generic, product-aware) ─────────────
-- DEVIATION FROM SPEC: goal_id is NULLABLE and revision_type includes
-- 'proposal_approved' / 'proposal_dismissed'. Dismissals must produce a
-- goal_revisions row (per verification spec) but no coach_goals row exists
-- in that case, so the FK has to allow null. Approvals also get an explicit
-- type so audit queries can distinguish "AI proposal accepted" from a coach
-- typing a goal in by hand.
CREATE TABLE IF NOT EXISTS goal_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid REFERENCES coach_goals(id) ON DELETE CASCADE,
  product_context text NOT NULL DEFAULT 'coaching'
    CHECK (product_context IN ('coaching','therapy')),
  revision_type text NOT NULL
    CHECK (revision_type IN ('status_change','text_change','target_date_change','scope_change','proposal_approved','proposal_dismissed')),
  before_value jsonb,
  after_value jsonb,
  reasoning text,
  proposed_by text NOT NULL CHECK (proposed_by IN ('coach','ai')),
  approved_by text,
  approved_at timestamptz,
  session_booking_id uuid,
  source_proposal_id text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goal_revisions_goal_id_idx ON goal_revisions(goal_id);
CREATE INDEX IF NOT EXISTS goal_revisions_session_booking_idx ON goal_revisions(session_booking_id);

ALTER TABLE goal_revisions ENABLE ROW LEVEL SECURITY;
-- Server-side endpoints use the service role key, which bypasses RLS.
-- No client-side reads from goal_revisions in this chunk (history UI is
-- explicitly out of scope), so no permissive policy is needed yet.
