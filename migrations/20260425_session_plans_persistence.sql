-- Chunk 6.5: Session plan persistence + Edit + Revise — run in Supabase SQL Editor
-- Adds coach_edits audit, revision_context, archive lifecycle, and a partial
-- unique index so only one active session_plans row exists per booking.

ALTER TABLE session_plans
  ADD COLUMN IF NOT EXISTS coach_edits jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS revision_context text NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS archived_for_plan_id uuid NULL REFERENCES session_plans(id);

-- Partial unique index — only one active (non-archived) plan per booking.
-- The Revise flow archives the prior row BEFORE inserting the new one so
-- the index never collides; the Edit flow updates in place without touching
-- archived_at.
CREATE UNIQUE INDEX IF NOT EXISTS session_plans_booking_id_active_unique
  ON session_plans (booking_id)
  WHERE archived_at IS NULL AND booking_id IS NOT NULL;

-- One-time cleanup of duplicates accumulated before the unique index existed.
-- Keeps the earliest generated_at per booking, archives the rest.
WITH ranked AS (
  SELECT id, booking_id, generated_at,
         ROW_NUMBER() OVER (PARTITION BY booking_id ORDER BY generated_at ASC) AS rn
  FROM session_plans
  WHERE booking_id IS NOT NULL AND archived_at IS NULL
)
UPDATE session_plans sp
SET archived_at = now()
FROM ranked
WHERE sp.id = ranked.id AND ranked.rn > 1;
