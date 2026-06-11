-- 20260609_effectiveness_map_assignments.sql
-- Step 1 — Effectiveness Map dashboard build (brief v1.1).
-- Pending/active intake-link assignments: one signed link = one row = one Map.
-- Writes are service-role only (assign endpoint + intake handler); coaches read
-- their own rows via RLS. Run manually in the Supabase SQL editor
-- (project qroizygknxdjsstkezsf) — no CLI migrations. Escape quotes as '' not \'.

create table if not exists public.effectiveness_map_assignments (
  id              uuid primary key default gen_random_uuid(),
  coach_id        uuid not null references public.coach_profiles(id) on delete cascade,
  client_email    text not null,
  session_id      uuid not null unique,
  status          text not null default 'pending'
                  check (status in ('pending','in_progress','completed','expired')),
  assigned_at     timestamptz not null default now(),
  expires_at      timestamptz not null,
  completed_at    timestamptz,
  product_context text not null default 'coaching'
);

create index if not exists ema_client_email_idx on public.effectiveness_map_assignments (lower(client_email));
create index if not exists ema_coach_id_idx      on public.effectiveness_map_assignments (coach_id);
create index if not exists ema_status_idx        on public.effectiveness_map_assignments (status);

alter table public.effectiveness_map_assignments enable row level security;

-- Coach reads their own assignment rows (status tracking in the client profile).
-- Mirrors emaps_coach_read: coach_id -> coach_profiles matched by lowercased email.
drop policy if exists "assignments_coach_read" on public.effectiveness_map_assignments;
create policy "assignments_coach_read" on public.effectiveness_map_assignments for select
  using (
    coach_id in (
      select cp.id from public.coach_profiles cp
      where lower(cp.user_email) = lower(auth.jwt() ->> 'email')
    )
  );

-- No anon/explorer read. No insert/update/delete policies on purpose: all writes
-- are service-role only (the assign endpoint + the intake handler), bypassing RLS.
