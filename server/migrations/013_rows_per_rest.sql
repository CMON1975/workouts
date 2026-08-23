-- rows_per_rest: how many timed rows chain back-to-back before one rest fires.
-- NULL (or no row) means 1 — rest after every row. A suitcase carry publishes
-- 2 (left row -> right row -> rest); a farmer carry keeps the default. Only
-- meaningful alongside rest_seconds on a template with a "time" column; the
-- client ignores it otherwise.
ALTER TABLE prescription_exercises ADD COLUMN rows_per_rest INTEGER;
