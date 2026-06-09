-- 20260609_effectiveness_maps.sql
-- Effectiveness Map synthesis results (P.I.P.E.S.). Read-only intelligence:
-- written only by the service-role function api/generate-effectiveness-map.js.
-- Shared by ineedcoaching (coaching) and Sprixle (therapy); product_context distinguishes.
-- Run manually in the Supabase SQL editor (project qroizygknxdjsstkezsf) — no CLI migrations.

create table if not exists public.effectiveness_maps (
  id                        uuid primary key default gen_random_uuid(),
  session_id                uuid not null unique,
  explorer_id               uuid,                          -- nullable: anonymous / non-auth sessions
  client_email              text,                          -- nullable: derived from client JWT when authenticated; null for anonymous and crisis rows
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

alter table public.effectiveness_maps enable row level security;

-- Explorer reads their own maps (authenticated, email-keyed — matches the platform's
-- 26 email-keyed tables and auth.jwt()->>'email' convention). Anonymous explorers
-- (client_email null) are NOT covered here; they are retrieved server-side via the
-- service-role key until the anonymous-session-token brief lands.
drop policy if exists "emaps_explorer_self_read" on public.effectiveness_maps;
create policy "emaps_explorer_self_read" on public.effectiveness_maps for select
  using (
    client_email is not null
    and lower(client_email) = lower(auth.jwt()->>'email')
  );

-- Coach reads maps for their actively-connected clients, scoped to the coaching product.
-- Mirrors the explorer_profiles coach-read policy but joins the first-class coach_clients
-- relationship (email-keyed) rather than coach_bookings. coach_profiles.id is matched by
-- user_email (no user_id column; id is not auth.uid()).
drop policy if exists "emaps_coach_read" on public.effectiveness_maps;
create policy "emaps_coach_read" on public.effectiveness_maps for select
  using (
    product_context = 'coaching'
    and client_email is not null
    and lower(client_email) in (
      select lower(cc.client_email)
      from public.coach_clients cc
      join public.coach_profiles cp on cp.id = cc.coach_id
      where lower(cp.user_email) = lower(auth.jwt()->>'email')
        and cc.status = 'active'
    )
  );

-- No public/anon read. No insert/update/delete policies are granted: all writes are
-- service-role only (the edge function), which bypasses RLS by design.
