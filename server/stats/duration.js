// How long a session took, measured where possible and estimated where not.
// Each answer names its source so the page can say how much is measured.
//   stopwatch  sessions.duration_seconds (since migration 011; wall time,
//              rest included)
//   span       finalized_at - started_at, unless the import sweep stamped it
//   logged     cardio: the time column; holds/carries: work + prescribed rest
//   typical    the template's median seconds per set x sets
//   rule       sets x 40 s + rests; fixed fallbacks for checkbox and cardio
import {
  CARDIO_FALLBACK_SECONDS, CHECKBOX_SECONDS, DEFAULT_REST_SECONDS, MAX_SECONDS,
  MIN_SECONDS_PER_SET, OUTLIER_FACTOR, REP_SET_SECONDS, TYPICAL_MIN_SAMPLES,
} from './constants.js';

// The finalize_pending sweep stamps one `now` on every open child and on the
// workout itself; a normal run finalizes each child, then the workout, in
// separate requests. So a stamp shared with a sibling or with the workout
// means "swept", not "finished then".
export function sweptSessionIds(sessions) {
  const counts = new Map();
  for (const s of sessions) {
    if (s.workout_id == null || s.finalized_at == null) continue;
    const key = `${s.workout_id}:${s.finalized_at}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const swept = new Set();
  for (const s of sessions) {
    if (s.workout_id == null || s.finalized_at == null) continue;
    if (counts.get(`${s.workout_id}:${s.finalized_at}`) > 1 || s.finalized_at === s.workout_finalized_at) swept.add(s.id);
  }
  return swept;
}

const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

// samples: measured { template_id, seconds, sets } that passed the absolute bounds.
export function typicalSecondsPerSet(samples) {
  const byTemplate = new Map();
  for (const s of samples) {
    if (!(s.sets > 0)) continue;
    if (!byTemplate.has(s.template_id)) byTemplate.set(s.template_id, []);
    byTemplate.get(s.template_id).push(s.seconds / s.sets);
  }
  const out = new Map();
  for (const [id, perSet] of byTemplate) if (perSet.length >= TYPICAL_MIN_SAMPLES) out.set(id, median(perSet));
  return out;
}

// Plausible: at least 30 s a set (and nearly the logged work time), at most
// the category's cap, and not 3x the template's usual pace.
export function plausible(seconds, { facts, category, perSet }) {
  if (!(seconds > 0)) return false;
  const sets = Math.max(facts.sets, 1);
  const min = Math.max(MIN_SECONDS_PER_SET * sets, 0.9 * (facts.work_seconds ?? 0));
  if (seconds < min || seconds > MAX_SECONDS[category]) return false;
  return perSet == null || seconds <= OUTLIER_FACTOR * perSet * sets;
}

export function measuredSeconds({ session, swept }) {
  return {
    stopwatch: session.duration_seconds,
    span: swept || session.finalized_at == null ? null : (session.finalized_at - session.started_at) / 1000,
  };
}

export function sessionSeconds({ session, facts, category, kind, swept, typical, rest }) {
  const perSet = typical.get(session.template_id);
  const ok = (s) => plausible(s, { facts, category, perSet });
  const { stopwatch, span } = measuredSeconds({ session, swept });
  if (ok(stopwatch)) return { seconds: stopwatch, source: 'stopwatch' };
  if (ok(span)) return { seconds: Math.round(span), source: 'span' };

  const sets = Math.max(facts.sets, 1);
  const restSeconds = rest?.rest_seconds ?? DEFAULT_REST_SECONDS;
  if (facts.work_seconds > 0) {
    if (category === 'cardio') return { seconds: facts.work_seconds, source: 'logged' };
    const rests = Math.ceil(sets / (rest?.rows_per_rest ?? 1)) - 1;
    return { seconds: facts.work_seconds + restSeconds * rests, source: 'logged' };
  }
  if (perSet != null) return { seconds: Math.round(perSet * sets), source: 'typical' };
  if (kind === 'checkbox') return { seconds: CHECKBOX_SECONDS, source: 'rule' };
  if (category === 'cardio') return { seconds: CARDIO_FALLBACK_SECONDS, source: 'rule' };
  return { seconds: sets * REP_SET_SECONDS + (sets - 1) * restSeconds, source: 'rule' };
}
