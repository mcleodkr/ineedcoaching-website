-- Effectiveness Map prompt v1.6: preserve the explorer's raw intake answers on
-- the Map row so a Map's claims can be audited against what was actually
-- submitted (the draft row is deleted on submit, so this is the only durable
-- copy). Written by generate-effectiveness-map.js for non-crisis rows only;
-- crisis rows stay content-free (answers NULL).
alter table public.effectiveness_maps
  add column if not exists answers jsonb;

comment on column public.effectiveness_maps.answers is
  'Raw intake answers (10 canonical keys) as sent to synthesis. NULL on crisis rows and on pre-v1.6 Maps.';
