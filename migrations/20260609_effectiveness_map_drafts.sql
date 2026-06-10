-- 20260609_effectiveness_map_drafts.sql
-- Step 2 — Effectiveness Map dashboard build (brief v1.1), explorer intake.
-- Save-as-you-go draft answers, keyed to a pending assignment by session_id.
-- One draft per link. Upserted on each screen advance; DELETED after a Map
-- generates successfully. Service-role only — the signed token authorizes the
-- server to read/write on the explorer's behalf (no client/anon access).
-- Run manually in the Supabase SQL editor (project qroizygknxdjsstkezsf).
-- Escape quotes as '' not \'.

create table if not exists public.effectiveness_map_drafts (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null unique
                  references public.effectiveness_map_assignments(session_id) on delete cascade,
  answers         jsonb not null default '{}',
  current_screen  int not null default 0 check (current_screen >= 0),
  updated_at      timestamptz not null default now(),
  product_context text not null default 'coaching'
);

-- RLS on, ZERO policies on purpose: no client/anon/coach read or write. Every draft
-- operation goes through the server-side intake handler with the service-role key,
-- which bypasses RLS. The signed link token (not a Supabase JWT) is what authorizes
-- the server to act for the explorer.
alter table public.effectiveness_map_drafts enable row level security;
