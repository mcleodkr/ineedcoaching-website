-- 20260609_coach_bookings_updated_at_audit.sql
-- Applied to prod via Supabase MCP on 2026-06-09; recorded here for parity.
--
-- Adds coach_bookings.updated_at (auto-maintained) and a basic audit trail so a
-- future time change (like the +5h shift on Amarie's booking) is diagnosable
-- instead of a forensic guess. The audit logs inserts, time/status changes, and
-- deletes, capturing old/new scheduled_at + status and the acting coach's email
-- (best-effort from the JWT). Logging never blocks the underlying write.

ALTER TABLE public.coach_bookings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.set_coach_bookings_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_coach_bookings_updated_at ON public.coach_bookings;
CREATE TRIGGER trg_coach_bookings_updated_at
  BEFORE UPDATE ON public.coach_bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_coach_bookings_updated_at();

CREATE TABLE IF NOT EXISTS public.coach_bookings_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id uuid NOT NULL,
  coach_id uuid,
  action text NOT NULL,
  actor_email text,
  old_scheduled_at timestamptz,
  new_scheduled_at timestamptz,
  old_status text,
  new_status text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coach_bookings_audit_booking
  ON public.coach_bookings_audit (booking_id, changed_at DESC);

CREATE OR REPLACE FUNCTION public.audit_coach_bookings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor text;
BEGIN
  BEGIN v_actor := auth.jwt() ->> 'email'; EXCEPTION WHEN OTHERS THEN v_actor := NULL; END;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.coach_bookings_audit(booking_id, coach_id, action, actor_email, new_scheduled_at, new_status)
        VALUES (NEW.id, NEW.coach_id, 'insert', v_actor, NEW.scheduled_at, NEW.status);
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at OR NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO public.coach_bookings_audit(booking_id, coach_id, action, actor_email, old_scheduled_at, new_scheduled_at, old_status, new_status)
          VALUES (NEW.id, NEW.coach_id, 'update', v_actor, OLD.scheduled_at, NEW.scheduled_at, OLD.status, NEW.status);
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO public.coach_bookings_audit(booking_id, coach_id, action, actor_email, old_scheduled_at, old_status)
        VALUES (OLD.id, OLD.coach_id, 'delete', v_actor, OLD.scheduled_at, OLD.status);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never let auditing block the booking operation
  END;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_coach_bookings ON public.coach_bookings;
CREATE TRIGGER trg_audit_coach_bookings
  AFTER INSERT OR UPDATE OR DELETE ON public.coach_bookings
  FOR EACH ROW EXECUTE FUNCTION public.audit_coach_bookings();

ALTER TABLE public.coach_bookings_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "coach reads own booking audit" ON public.coach_bookings_audit;
CREATE POLICY "coach reads own booking audit" ON public.coach_bookings_audit
  FOR SELECT TO authenticated
  USING (coach_id IN (SELECT id FROM public.coach_profiles WHERE lower(user_email) = lower(auth.jwt() ->> 'email')));
REVOKE ALL ON public.coach_bookings_audit FROM anon;
GRANT SELECT ON public.coach_bookings_audit TO authenticated;
