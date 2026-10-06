// Active energy (kcal above resting) per session. No age or sex is on
// record, so heart-rate formulas are out; this is METs x body weight x time.
import { DEFAULT_BODY_KG, DEFAULT_WALK_KPH } from './constants.js';

// series: [{ date: 'YYYY-MM-DD', kg }] in any order.
export function bodyKgOn(series, date) {
  let onOrBefore = null;
  let after = null;
  for (const s of series) {
    if (s.date <= date) { if (!onOrBefore || s.date > onOrBefore.date) onOrBefore = s; }
    else if (!after || s.date < after.date) after = s;
  }
  if (onOrBefore) return { kg: onOrBefore.kg, source: 'logged' };
  if (after) return { kg: after.kg, source: 'nearest' };
  return { kg: DEFAULT_BODY_KG, source: 'default' };
}

// ACSM walking equation: VO2 (ml/kg/min) = 3.5 + 0.1 v + 1.8 v grade,
// v in m/min; 1 MET = 3.5 ml/kg/min.
export function walkMet(kph, gradePct) {
  const v = kph * 1000 / 60;
  return (3.5 + 0.1 * v + 1.8 * v * (gradePct / 100)) / 3.5;
}

export function activeKcal(met, kg, seconds) {
  return Math.max(0, met - 1) * kg * seconds / 3600;
}

// Cardio without a fixed MET walks at the logged speed and incline over the
// logged time (else the session's time); no logged speed means 5 kph flat,
// flagged as assumed. An interval program (the pinned prescription's) puts
// only its hard rounds at the logged speed and incline, which are the hard
// pace; warm-up, easy and cool-down walk at 5 kph flat.
// How much of `time` an interval program spends on its hard rounds.
export function programSplit(program, time) {
  if (!(program?.rounds > 0 && program?.work_seconds > 0)) return null;
  const hard = Math.min(time, program.rounds * program.work_seconds);
  return { hard, easy: time - hard };
}

export function sessionKcal({ rule, facts, seconds, kg, program = null }) {
  if (rule.category === 'cardio' && rule.met == null) {
    const assumed = facts.speed_kph == null;
    const met = walkMet(facts.speed_kph ?? DEFAULT_WALK_KPH, facts.grade_pct ?? 0);
    const time = facts.work_seconds > 0 ? facts.work_seconds : seconds;
    const split = assumed ? null : programSplit(program, time);
    if (split) {
      const easy = activeKcal(walkMet(DEFAULT_WALK_KPH, 0), kg, split.easy);
      return { kcal: activeKcal(met, kg, split.hard) + easy, basis: 'intervals' };
    }
    return { kcal: activeKcal(met, kg, time), basis: assumed ? 'walk_assumed' : 'walk' };
  }
  return { kcal: activeKcal(rule.met, kg, seconds), basis: 'met' };
}
