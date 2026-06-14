-- Prescriptions: an externally-authored plan for a week of work against a routine.
-- Source of truth for "what was prescribed" — workouts.prescription_id (migration 007)
-- pins each executed workout to the prescription it was run against, so historical
-- comparison (prescribed vs actual) survives re-imports of the same week.
--
-- No UNIQUE on (routine_id, starts_on): re-importing a week inserts a NEW row so
-- earlier workouts keep their prescription_id pointing at the original prescription.
-- Active-prescription lookup is "most recent starts_on <= today" for a routine.
CREATE TABLE prescriptions (
  id          INTEGER PRIMARY KEY,
  routine_id  INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  starts_on   TEXT    NOT NULL,                      -- 'YYYY-MM-DD' (Monday)
  ends_on     TEXT    NOT NULL,
  source      TEXT,                                  -- provenance, e.g. 'health-repo@<sha>'
  notes       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX ix_prescriptions_routine_date ON prescriptions(routine_id, starts_on DESC);

CREATE TABLE prescription_targets (
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  template_id     INTEGER NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  row_index       INTEGER NOT NULL,
  column_id       INTEGER NOT NULL REFERENCES template_columns(id) ON DELETE RESTRICT,
  target_num      REAL,
  target_text     TEXT,
  cue             TEXT,                              -- per-row prose: "RPE 7", "AMRAP last set"
  PRIMARY KEY (prescription_id, template_id, row_index, column_id)
) WITHOUT ROWID;
