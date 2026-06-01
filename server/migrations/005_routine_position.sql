-- User-defined display order for routines (drag-and-drop on Manage screen).
-- Backfill existing rows to the current default (alphabetical by name) so the
-- order is stable on first load; new routines append (handled in the route).
ALTER TABLE routines ADD COLUMN sort_position INTEGER NOT NULL DEFAULT 0;

UPDATE routines
   SET sort_position = (
     SELECT COUNT(*) FROM routines r2 WHERE r2.name < routines.name
   );
