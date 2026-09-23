-- target_kind: how a target reads (HANDOFF 2026-09-22). 'exact' is the old
-- meaning, a goal to hit; 'cap' is an upper bound on an effort (AMRAP up to
-- 12, a max hold stopped at 120 s); 'ceiling' is a limit to stay under (HR
-- 140). The number stays in target_num either way, so everything that reads
-- it (the plank countdown, the blank-set confirm) is unchanged; the kind is
-- how the hint is worded.
ALTER TABLE prescription_targets ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'exact'
  CHECK (target_kind IN ('exact', 'cap', 'ceiling'));
