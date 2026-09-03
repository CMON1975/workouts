-- Interval program for cardio interval days, JSON per (prescription, template):
-- { warmup_seconds?, work_seconds, easy_seconds, rounds, cooldown_seconds?,
--   cooldown_step_seconds? }. The client expands it into one continuous
-- warmup -> (work, easy) x rounds -> cooldown-in-steps countdown chain.
-- One JSON column rather than six siblings: it is a config blob validated at
-- the import boundary and consumed whole, never queried per field. NULL (or
-- no row) = not an interval exercise; rest_seconds / chain mode apply as before.
ALTER TABLE prescription_exercises ADD COLUMN intervals TEXT;
