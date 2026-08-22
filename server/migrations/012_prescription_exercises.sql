-- Per-exercise prescription metadata, week-scoped via the prescription row.
-- rest_seconds drives the stopwatch bar's rest countdown for that exercise.
-- No row (or NULL rest_seconds) = no rest prescribed — the bar falls back to
-- the count-up Start/Lap behavior.
--
-- Grain is (prescription, template): prescription_targets is per-cell (wrong
-- grain for a per-exercise value) and template_defaults is not week-scoped,
-- so neither can carry a weekly re-prescribable rest duration.
CREATE TABLE prescription_exercises (
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  template_id     INTEGER NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  rest_seconds    INTEGER,
  PRIMARY KEY (prescription_id, template_id)
) WITHOUT ROWID;
