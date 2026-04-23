-- Routines: named collections of templates run as a single workout.
CREATE TABLE routines (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  archived_at  INTEGER
);

CREATE TABLE routine_templates (
  routine_id   INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  template_id  INTEGER NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL,
  PRIMARY KEY (routine_id, template_id)
);
CREATE UNIQUE INDEX ux_routine_templates_pos ON routine_templates(routine_id, position);

-- A single "run" of a routine: one Arms-day instance. Children are the
-- sessions created while executing the routine.
CREATE TABLE workouts (
  id              TEXT    PRIMARY KEY,
  routine_id      INTEGER NOT NULL REFERENCES routines(id) ON DELETE RESTRICT,
  started_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  finalized_at    INTEGER,
  client_version  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_workouts_routine ON workouts(routine_id, started_at DESC);
CREATE INDEX ix_workouts_active  ON workouts(finalized_at) WHERE finalized_at IS NULL;

-- Sessions may now belong to a workout. Nullable: ad-hoc single-exercise
-- sessions keep working with workout_id IS NULL.
ALTER TABLE sessions ADD COLUMN workout_id TEXT
  REFERENCES workouts(id) ON DELETE SET NULL;
CREATE INDEX ix_sessions_workout ON sessions(workout_id);
