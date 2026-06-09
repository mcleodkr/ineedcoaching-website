-- 20260609_rekey_client_function.sql
-- Coach-initiated correction of a client's contact info from the dashboard.
-- Applied to prod via Supabase MCP on 2026-06-09; recorded here for parity.
--
-- name/phone update on coach_bookings (all the client's sessions); email, when
-- changed, cascades client_email across every coach-scoped table in one
-- transaction so the client stays one coherent record. The acting coach is
-- resolved from the JWT email — never trusted from input. Refuses to merge into
-- an email that already has records under the same coach.

create or replace function public.rekey_client(
  p_old_email text,
  p_new_email text,
  p_new_name  text,
  p_new_phone text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach_id uuid;
  v_old   text := lower(trim(coalesce(p_old_email, '')));
  v_new   text := lower(trim(coalesce(p_new_email, '')));
  v_name  text := nullif(trim(coalesce(p_new_name, '')), '');
  v_phone text := nullif(trim(coalesce(p_new_phone, '')), '');
  v_email_changed boolean;
  v_bookings int;
  v_collision int;
begin
  -- Resolve the calling coach from their JWT email; do not trust a client id.
  select id into v_coach_id
  from public.coach_profiles
  where lower(user_email) = lower(auth.jwt() ->> 'email')
  limit 1;
  if v_coach_id is null then
    raise exception 'not_a_coach' using errcode = '42501';
  end if;

  if v_old = '' then
    raise exception 'missing_old_email' using errcode = '22023';
  end if;

  v_email_changed := (v_new <> '' and v_new <> v_old);
  if v_new = '' then v_new := v_old; end if;

  if v_email_changed and v_new !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  -- Refuse to merge into an email already used by another record under this coach.
  if v_email_changed then
    select
        (select count(*) from public.coach_bookings         where coach_id=v_coach_id and lower(client_email)=v_new)
      + (select count(*) from public.coach_goals            where coach_id=v_coach_id and lower(client_email)=v_new)
      + (select count(*) from public.coach_messages         where coach_id=v_coach_id and lower(client_email)=v_new)
      + (select count(*) from public.coach_session_notes    where coach_id=v_coach_id and lower(client_email)=v_new)
      + (select count(*) from public.coach_checkin_responses where coach_id=v_coach_id and lower(client_email)=v_new)
      + (select count(*) from public.client_homework        where coach_id=v_coach_id and lower(client_email)=v_new)
      + (select count(*) from public.coach_intake_responses where coach_id=v_coach_id and lower(client_email)=v_new)
      + (select count(*) from public.coach_clients          where coach_id=v_coach_id and lower(client_email)=v_new)
    into v_collision;
    if v_collision > 0 then
      raise exception 'email_in_use' using errcode = '23505';
    end if;
  end if;

  -- name/phone live on coach_bookings; update across all the client's sessions.
  update public.coach_bookings
     set client_name  = v_name,
         client_phone = v_phone,
         client_email = case when v_email_changed then v_new else client_email end
   where coach_id = v_coach_id and lower(client_email) = v_old;
  get diagnostics v_bookings = row_count;

  -- Email cascade across the client's other coach-scoped records.
  if v_email_changed then
    update public.coach_goals             set client_email=v_new where coach_id=v_coach_id and lower(client_email)=v_old;
    update public.coach_messages          set client_email=v_new where coach_id=v_coach_id and lower(client_email)=v_old;
    update public.coach_session_notes     set client_email=v_new where coach_id=v_coach_id and lower(client_email)=v_old;
    update public.coach_checkin_responses set client_email=v_new where coach_id=v_coach_id and lower(client_email)=v_old;
    update public.client_homework         set client_email=v_new where coach_id=v_coach_id and lower(client_email)=v_old;
    update public.coach_intake_responses  set client_email=v_new where coach_id=v_coach_id and lower(client_email)=v_old;
    update public.coach_clients           set client_email=v_new where coach_id=v_coach_id and lower(client_email)=v_old;
  end if;

  return jsonb_build_object(
    'ok', true,
    'old_email', v_old,
    'new_email', v_new,
    'email_changed', v_email_changed,
    'bookings_updated', v_bookings
  );
end;
$$;

revoke all on function public.rekey_client(text,text,text,text) from public, anon;
grant execute on function public.rekey_client(text,text,text,text) to authenticated;
