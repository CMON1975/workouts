-- Workouts gain an immutable pointer to the prescription they were run against.
-- Stamped once at workout creation by the workouts route via the same date-range
-- lookup as GET /api/prescriptions/active. ON DELETE SET NULL keeps historical
-- workouts intact if a prescription is later removed; nullable so legacy rows
-- and ad-hoc workouts (no active prescription on the routine) keep working.
ALTER TABLE workouts ADD COLUMN prescription_id INTEGER
  REFERENCES prescriptions(id) ON DELETE SET NULL;
CREATE INDEX ix_workouts_prescription ON workouts(prescription_id);
