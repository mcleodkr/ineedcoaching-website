-- Supervision Ticket 3 — Supervision Snapshot
-- Applied to prod 2026-06-19 via Supabase (migration: supervision_snapshots_ticket3).
-- Adds the window-anchor column and the per-relationship cached snapshot table.

-- 1) window-anchor column on the relationship (nullable; populated by future tickets)
ALTER TABLE public.supervision_relationships
  ADD COLUMN IF NOT EXISTS last_supervision_contact timestamptz;

-- 2) one cached snapshot per relationship (overwritten on regenerate)
CREATE TABLE IF NOT EXISTS public.supervision_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL UNIQUE REFERENCES public.supervision_relationships(id) ON DELETE CASCADE,
  supervisor_id uuid NOT NULL REFERENCES public.coach_profiles(id),
  supervisee_id uuid NOT NULL REFERENCES public.coach_profiles(id),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  session_count integer NOT NULL,
  client_count integer NOT NULL,
  snapshot_text jsonb NOT NULL,
  generated_at timestamptz DEFAULT now()
);

ALTER TABLE public.supervision_snapshots ENABLE ROW LEVEL SECURITY;

-- Supervisor controls what is shared: supervisor reads/inserts/updates own rows.
-- Supervisee gets NO policy and therefore cannot read snapshots.
DROP POLICY IF EXISTS snapshots_supervisor_read ON public.supervision_snapshots;
CREATE POLICY snapshots_supervisor_read ON public.supervision_snapshots
  FOR SELECT USING (supervisor_id = public.current_coach_id());

DROP POLICY IF EXISTS snapshots_supervisor_insert ON public.supervision_snapshots;
CREATE POLICY snapshots_supervisor_insert ON public.supervision_snapshots
  FOR INSERT WITH CHECK (supervisor_id = public.current_coach_id());

DROP POLICY IF EXISTS snapshots_supervisor_update ON public.supervision_snapshots;
CREATE POLICY snapshots_supervisor_update ON public.supervision_snapshots
  FOR UPDATE USING (supervisor_id = public.current_coach_id())
  WITH CHECK (supervisor_id = public.current_coach_id());
