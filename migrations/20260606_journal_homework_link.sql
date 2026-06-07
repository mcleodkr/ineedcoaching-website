-- Journal → Homework auto-complete: link a journal entry back to the
-- client_homework row that seeded it, so saving the journal can auto-complete
-- the homework. Additive and nullable; ON DELETE SET NULL so removing a
-- homework row never deletes the client's journal entry.
--
-- Run in the Supabase SQL Editor BEFORE deploying the client-dashboard.html
-- change — the journal INSERT references homework_id once a homework-seeded
-- entry is saved, and PostgREST rejects an INSERT naming an unknown column.

ALTER TABLE coach_journal_entries
  ADD COLUMN IF NOT EXISTS homework_id uuid REFERENCES client_homework(id) ON DELETE SET NULL;
