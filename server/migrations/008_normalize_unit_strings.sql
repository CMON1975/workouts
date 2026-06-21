-- 008: normalize template_columns.unit values
--
-- Pre-prescription era: the `unit` string was hand-edited to encode the current
-- target ("30 sec", "10 lb x 2", "5 kph"). Now that prescriptions carry targets
-- explicitly, those encoded units read as authoritative "ghost" targets and
-- contradict the actual prescription. Strip the target encoding and leave only
-- plain unit indicators.
--
-- Value-based UPDATEs so dev and prod (different ids) both clean correctly.
-- Migrations run once via the _migrations ledger, so this fires exactly one
-- time per DB. Re-running with no changes would still be a no-op because the
-- target strings no longer match after the first pass.

-- Bare numbers that were target values stashed in the unit field.
UPDATE template_columns SET unit = '' WHERE unit IN
  ('0', '3', '5', '6', '8', '10', '12', '15', '17.5', '20', '22.5', '30', '20:00');

-- Weight columns: drop the target number and the "x 2" multiplier; the per-DB
-- semantics now live in the prescription cue ("per DB").
UPDATE template_columns SET unit = 'lbs' WHERE unit IN
  ('12.5 lbs', '15 lbs', '35 lbs', '5 lbs x 2', '7.5 lbs x 2', '9.5 lbs x 2');
UPDATE template_columns SET unit = 'lb'  WHERE unit IN
  ('10 lb x 2', '7.5 lb x 2', '25.5 x 2');

-- Time columns: standardize on the unit, drop the target.
UPDATE template_columns SET unit = 'seconds'          WHERE unit IN ('30 sec', '45 - 60 sec', '60 sec');
UPDATE template_columns SET unit = 'minutes'          WHERE unit IN ('45 min', '60 mins');
UPDATE template_columns SET unit = 'seconds per side' WHERE unit IN ('20s/side', '30-45s/side');

-- Reps per side (currently only "10/side" appears).
UPDATE template_columns SET unit = 'per side' WHERE unit = '10/side';

-- HR range stored as a unit.
UPDATE template_columns SET unit = 'bpm' WHERE unit = '101-118 bpm';

-- Speed / pace.
UPDATE template_columns SET unit = 'kph' WHERE unit IN ('4.5-5.0 kph', '5 kph', '6 kph');
