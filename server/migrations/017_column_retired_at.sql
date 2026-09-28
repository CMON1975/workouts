-- 017: retire a template column instead of keeping it on the form
--
-- A column left out of a template edit was always kept (its values are
-- history), but nothing marked it, so the runner still rendered it — just
-- parked last at position + 10000. retired_at marks it: the runner leaves it
-- off the form, history and export still show its values. NULL = active.
--
-- Backfill: a parked position is exactly "left out of an edit".

ALTER TABLE template_columns ADD COLUMN retired_at INTEGER;
UPDATE template_columns
   SET retired_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE position >= 10000;
