-- Chunk 5: Intervention Plan Builder — run in Supabase SQL Editor
-- Three new tables: intervention_plans (the plan itself), intervention_plan_revisions
-- (audit trail of the two refinement rounds), and session_plans (tactical
-- per-session children of a strategic plan; populated by Chunk 6).
--
-- All three are product_context-aware and reserve coaching_data / clinical_data
-- JSONB so the Sprixle therapy variant can land without further migrations.

-- ── intervention_plans ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intervention_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL,
  client_email text NOT NULL,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','locked')),
  generation_round int NOT NULL DEFAULT 0
    CHECK (generation_round IN (0,1,2)),

  -- Eleven structured sections from the spec
  external_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  working_hypotheses jsonb NOT NULL DEFAULT '[]'::jsonb,
  strategic_frames jsonb NOT NULL DEFAULT '[]'::jsonb,
  behavioral_targets jsonb NOT NULL DEFAULT '[]'::jsonb,
  prior_commitments jsonb NOT NULL DEFAULT '[]'::jsonb,
  modality_sequence jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress_markers jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_watchouts jsonb NOT NULL DEFAULT '[]'::jsonb,
  session_arc jsonb NOT NULL DEFAULT '[]'::jsonb,
  coach_commitment jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Authorship + edit tracking
  generated_by_ai boolean NOT NULL DEFAULT true,
  coach_edits jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Product separation (Sprixle ships clinical_data here)
  product_context text NOT NULL DEFAULT 'coaching'
    CHECK (product_context IN ('coaching','therapy')),
  coaching_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  clinical_data jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Versioning: regenerate-from-scratch archives the old plan and points
  -- archived_for_plan_id at the new active one
  archived_at timestamptz,
  archived_for_plan_id uuid REFERENCES intervention_plans(id),

  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz
);

CREATE INDEX IF NOT EXISTS intervention_plans_coach_client_idx
  ON intervention_plans(coach_id, client_email);
CREATE INDEX IF NOT EXISTS intervention_plans_active_idx
  ON intervention_plans(coach_id, client_email)
  WHERE archived_at IS NULL;

ALTER TABLE intervention_plans ENABLE ROW LEVEL SECURITY;

-- ── intervention_plan_revisions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intervention_plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid REFERENCES intervention_plans(id) ON DELETE CASCADE,
  round integer NOT NULL CHECK (round IN (1, 2)),
  coach_feedback text,
  claude_response text,
  sections_changed text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  product_context text NOT NULL DEFAULT 'coaching'
    CHECK (product_context IN ('coaching','therapy'))
);

CREATE INDEX IF NOT EXISTS intervention_plan_revisions_plan_idx
  ON intervention_plan_revisions(plan_id);

ALTER TABLE intervention_plan_revisions ENABLE ROW LEVEL SECURITY;

-- ── session_plans (Chunk 6 will populate) ───────────────────────────────
CREATE TABLE IF NOT EXISTS session_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intervention_plan_id uuid REFERENCES intervention_plans(id),
  booking_id uuid REFERENCES coach_bookings(id),
  coach_id uuid NOT NULL,
  client_email text NOT NULL,

  opening text,
  key_questions text[],
  turning_points jsonb,
  branches jsonb,
  body_cues_to_watch text[],
  time_flow jsonb,

  generated_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  product_context text NOT NULL DEFAULT 'coaching'
    CHECK (product_context IN ('coaching','therapy')),
  coaching_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  clinical_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS session_plans_plan_booking_idx
  ON session_plans(intervention_plan_id, booking_id);

ALTER TABLE session_plans ENABLE ROW LEVEL SECURITY;

-- Server-side endpoints use the service role key, which bypasses RLS.
-- No client-side reads land in this chunk; the panel page POSTs through
-- /api/* endpoints. Add permissive policies in a follow-up if direct
-- REST reads from the panel are introduced.
