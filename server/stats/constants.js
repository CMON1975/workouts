// Assumptions behind every estimate on the stats page. The page lists them,
// so a number here is a claim the user can read and argue with.

// Compendium of Physical Activities METs (gross). Strength is applied to
// wall time, which includes rest, so it sits at the moderate 3.5.
export const MET = {
  strength: 3.5,
  mobility: 2.3,
  yoga: 2.5,
  step_platform: 4.0,
};

export const DEFAULT_BODY_KG = 100;
export const DEFAULT_WALK_KPH = 5;

// Logs before 2026-07-20 assumed a 5 lb dumbbell handle; it weighs ~0.5 lb.
export const HANDLE = { before: '2026-07-20', lb_per_db: 4.5 };

// Loaded carries walked deliberately: the low end of natural adult cadence
// (CADENCE-Adults, Tudor-Locke et al. 2019), 100 steps/min.
export const CARRY_STEPS_PER_SECOND = 100 / 60;

// Duration estimates
export const REP_SET_SECONDS = 40;
export const DEFAULT_REST_SECONDS = 90;
export const CHECKBOX_SECONDS = 600;
export const CARDIO_FALLBACK_SECONDS = 1800;
export const MIN_SECONDS_PER_SET = 30;
export const MAX_SECONDS = { strength: 45 * 60, mobility: 30 * 60, cardio: 3 * 3600 };
export const TYPICAL_MIN_SAMPLES = 3;
export const OUTLIER_FACTOR = 3;
