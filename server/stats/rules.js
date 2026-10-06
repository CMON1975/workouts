// How each exercise counts toward the totals. Template names are the only
// signal (there is no category column), so this is an explicit table, first
// match wins, and the stats page lists the rule every template landed on.
import { MET } from './constants.js';

// dbs: dumbbells (implements) moved per rep; value_is: whether the logged
// weight is per dumbbell or already the total; per_side: logged reps are per
// side, so a set moves twice that; bw_fraction: share of body weight moved
// per rep; carry: weight x steps over the logged time; handle: logs before
// the handle was weighed overstate each dumbbell (see constants.HANDLE).
const STRENGTH = { category: 'strength', dbs: 0, value_is: 'per_db', per_side: false, bw_fraction: 0, carry: false, handle: false, hold: false };
const dumbbell = (dbs, extra = {}) => ({ ...STRENGTH, dbs, handle: true, ...extra });
const bodyweight = (bw_fraction, extra = {}) => ({ ...STRENGTH, bw_fraction, ...extra });

// Bodyweight fractions: push-ups from force-plate data (Ebben et al. 2011:
// ~64% flat, ~55% hands raised ~30 cm); dip, step-up and split squat are
// body mass minus the segments that don't move (Dempster/Winter); the
// inverted row is a lever estimate at a ~40° body angle.
export const RULES = [
  { id: 'suitcase', match: /suitcase carry/, ...dumbbell(1, { carry: true }) },
  { id: 'farmer', match: /farmer carry/, ...dumbbell(2, { carry: true }) },
  // The first RDL logged the pair's total ("the 25 is 12.5 x 2", 05-22).
  { id: 'rdl_a', match: /^db romanian deadlift a$/, ...dumbbell(2, { value_is: 'total' }) },
  { id: 'rdl', match: /romanian deadlift/, ...dumbbell(2) },
  { id: 'goblet', match: /goblet squat/, ...dumbbell(1) },
  { id: 'front_rack', match: /front-rack squat/, ...dumbbell(2) },
  { id: 'floor_press', match: /floor press/, ...dumbbell(2) },
  { id: 'ohp', match: /overhead press/, ...dumbbell(2) },
  { id: 'split_squat', match: /split squat/, ...dumbbell(2, { per_side: true, bw_fraction: 0.88 }) },
  { id: 'step_up', match: /step-?up/, ...dumbbell(2, { per_side: true, bw_fraction: 0.94 }) },
  { id: 'db_row', match: /^db row|dumbbell row/, ...dumbbell(1, { per_side: true }) },
  { id: 'inverted_row', match: /inverted row/, ...bodyweight(0.5) },
  { id: 'dip', match: /\bdips?\b/, ...bodyweight(0.95) },
  { id: 'incline_pushup', match: /push-?up.*incline|incline.*push-?up/, ...bodyweight(0.55) },
  { id: 'pushup', match: /push-?up/, ...bodyweight(0.64) },
  { id: 'dead_bug', match: /dead bug/, ...bodyweight(0, { per_side: true }) },
  { id: 'hold', match: /plank|hang/, ...STRENGTH, hold: true },
  { id: 'walk', match: /interval|walk|zone 2|treadmill/, ...STRENGTH, category: 'cardio' },
  { id: 'step_platform', match: /step platform/, ...STRENGTH, category: 'cardio', met: MET.step_platform },
  { id: 'yoga', match: /yoga/, ...STRENGTH, category: 'mobility', met: MET.yoga },
  { id: 'mobility', match: /mobility|stretch|foam roll|cat-camel|90\/90|thoracic|bird dog/, ...STRENGTH, category: 'mobility' },
];

const CARDIO_COLUMNS = new Set(['speed', 'pace', 'distance', 'incline', 'kph']);

function fallback(template) {
  const names = new Set((template.columns ?? []).map((c) => String(c.name).trim().toLowerCase()));
  if ([...names].some((n) => CARDIO_COLUMNS.has(n))) return { ...STRENGTH, category: 'cardio' };
  if (template.kind !== 'checkbox' && (names.has('weight') || names.has('reps'))) return dumbbell(1, { handle: false });
  return { ...STRENGTH, category: 'mobility' };
}

// met: a fixed MET for the session, or null when energy comes from the
// walking equation (cardio with logged speed and incline).
export function ruleFor(template) {
  const name = String(template?.name ?? '').trim().toLowerCase();
  const hit = RULES.find((r) => r.match.test(name));
  const { id, match, ...rule } = hit ?? { id: null, match: null, ...fallback(template) };
  const met = rule.met ?? (rule.category === 'cardio' ? null : MET[rule.category]);
  return { ...rule, met, matched: id };
}
