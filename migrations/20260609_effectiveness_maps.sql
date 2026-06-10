-- 20260609_effectiveness_maps.sql
-- Effectiveness Map synthesis results (P.I.P.E.S.). Read-only intelligence:
-- written only by the service-role function api/generate-effectiveness-map.js.
-- Shared by ineedcoaching (coaching) and Sprixle (therapy); product_context distinguishes.
-- Run manually in the Supabase SQL editor (project qroizygknxdjsstkezsf) — no CLI migrations.

create table if not exists public.effectiveness_maps (
  id                        uuid primary key default gen_random_uuid(),
  session_id                uuid not null unique,
  coach_id                  uuid references public.coach_profiles(id) on delete set null,  -- generating coach (coach-initiated); drives the monthly limit + coach-read
  explorer_id               uuid,                          -- nullable: optional client auth id (the coach may not have it)
  client_email              text,                          -- the connected client, lowercased; null on crisis rows
  goal                      text,                          -- nullable: crisis rows store no explorer content
  phase                     text,                          -- nullable: crisis rows store no explorer content
  prompt_version            text not null,
  crisis_flag               boolean not null default false,
  dominant_pattern_label    text,
  overall_evidence_strength text,
  raw_output                jsonb not null,                -- full synthesis JSON (crisis rows: content-free crisis object)
  explorer_facing_output    jsonb,                         -- extracted explorer-facing fields; null for crisis rows
  product_context           text not null default 'coaching',
  created_at                timestamptz not null default now()
);

create index if not exists effectiveness_maps_client_email_idx on public.effectiveness_maps (lower(client_email));
create index if not exists effectiveness_maps_explorer_id_idx  on public.effectiveness_maps (explorer_id);
create index if not exists effectiveness_maps_session_idx      on public.effectiveness_maps (session_id);
create index if not exists effectiveness_maps_coach_month_idx  on public.effectiveness_maps (coach_id, created_at);

alter table public.effectiveness_maps enable row level security;

-- Explorer (client) reads their own real maps, email-keyed — matches the platform's
-- email-keyed tables and auth.jwt()->>'email' convention. Crisis rows (client_email
-- null) are naturally excluded.
drop policy if exists "emaps_explorer_self_read" on public.effectiveness_maps;
create policy "emaps_explorer_self_read" on public.effectiveness_maps for select
  using (
    client_email is not null
    and lower(client_email) = lower(auth.jwt()->>'email')
  );

-- Coach reads the maps they generated, scoped to the coaching product. Keyed on
-- coach_id -> coach_profiles, matched by user_email (no user_id column; id is not
-- auth.uid()). Crisis rows are excluded — they carry no map content.
drop policy if exists "emaps_coach_read" on public.effectiveness_maps;
create policy "emaps_coach_read" on public.effectiveness_maps for select
  using (
    product_context = 'coaching'
    and crisis_flag = false
    and coach_id in (
      select cp.id from public.coach_profiles cp
      where lower(cp.user_email) = lower(auth.jwt()->>'email')
    )
  );

-- No public/anon read. No insert/update/delete policies are granted: all writes are
-- service-role only (the edge function), which bypasses RLS by design.
