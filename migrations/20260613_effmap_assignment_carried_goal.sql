-- Carry-forward goal for Effectiveness Map re-takes (2026-06-13).
--
-- When a coach requests an updated Map for an existing goal ("Update this goal"),
-- the goal text is stored on the assignment so the intake pre-fills it (the client
-- skips goal entry, still answers the phase fresh) and the resulting Map files
-- under the SAME goal text, clustering with prior Maps for that goal.
--
-- NULL = the client names a brand-new goal ("Map a new goal" / every existing
-- assignment). Additive + nullable -> fully backward compatible; current code that
-- never references this column is unaffected.
--
-- Applied to prod 2026-06-13.
alter table public.effectiveness_map_assignments
  add column if not exists goal text;
