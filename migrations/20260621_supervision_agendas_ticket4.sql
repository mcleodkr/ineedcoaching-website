-- Ticket 4: Supervision Agenda Builder
-- Applied to prod 2026-06-21 via Supabase (migration: supervision_agendas_ticket4).

CREATE TABLE public.supervision_agendas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id uuid NOT NULL REFERENCES public.supervision_relationships(id) ON DELETE CASCADE,
  supervisor_id uuid NOT NULL REFERENCES public.coach_profiles(id),
  supervisee_id uuid NOT NULL REFERENCES public.coach_profiles(id),
  snapshot_id uuid REFERENCES public.supervision_snapshots(id) ON DELETE SET NULL,
  items jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'complete')),
  sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX supervision_agendas_rel_idx ON public.supervision_agendas (relationship_id, created_at DESC);

CREATE TRIGGER supervision_agendas_set_updated_at
  BEFORE UPDATE ON public.supervision_agendas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE public.supervision_agendas ENABLE ROW LEVEL SECURITY;

-- Supervisor: full access to own rows (any status).
CREATE POLICY agendas_supervisor_read ON public.supervision_agendas
  FOR SELECT USING (supervisor_id = public.current_coach_id());
CREATE POLICY agendas_supervisor_insert ON public.supervision_agendas
  FOR INSERT WITH CHECK (supervisor_id = public.current_coach_id());
CREATE POLICY agendas_supervisor_update ON public.supervision_agendas
  FOR UPDATE USING (supervisor_id = public.current_coach_id())
  WITH CHECK (supervisor_id = public.current_coach_id());

-- Supervisee: read only once sent (never a draft). Reflection writes go through the
-- API under the service role, which enforces item-level field restrictions.
CREATE POLICY agendas_supervisee_read ON public.supervision_agendas
  FOR SELECT USING (supervisee_id = public.current_coach_id() AND status <> 'draft');
