-- Stopwatch durations. Nullable on purpose: NULL means the stopwatch was
-- never started (distinguishable from a genuine 0-second exercise).
-- Legacy rows and server-swept workouts stay NULL.
ALTER TABLE sessions ADD COLUMN duration_seconds INTEGER;
ALTER TABLE workouts ADD COLUMN duration_seconds INTEGER;
