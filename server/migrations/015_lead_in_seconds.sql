-- lead_in_seconds: a short "get set" countdown the client runs before every
-- timed work phase of a chained exercise (and before the first phase of an
-- interval program), beeped like any other boundary, so the user has time to
-- get into position after the press or a side switch. NULL (or no row) =
-- no lead-in, work starts on the press. Only meaningful alongside chain mode
-- (rest_seconds + a "time" column) or `intervals`; the client ignores it
-- otherwise.
ALTER TABLE prescription_exercises ADD COLUMN lead_in_seconds INTEGER;
