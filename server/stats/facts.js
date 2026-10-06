// One session's cells -> the quantities the stats page adds up. Pure: the
// route hands in rows, the rule says how the exercise counts.
import {
  LB_PER_KG, cellRaw, parseLoad, parseReps, parseSeconds, parseSpeedKph, parseGradePct, parseDistanceKm,
} from './parse.js';
import { CARRY_STEPS_PER_SECOND, HANDLE } from './constants.js';

const role = (column) => {
  const n = String(column?.name ?? '').trim().toLowerCase();
  if (n === 'kph') return 'speed';
  return ['weight', 'reps', 'time', 'speed', 'pace', 'incline', 'distance', 'completed'].includes(n) ? n : null;
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ticked = (raw) => raw != null && /^(1(\.0+)?|true|yes|done|✓)$/i.test(raw);

export function sessionFacts({ template, columns, values, rule, localDate, bodyKg }) {
  const colById = new Map(columns.map((c) => [c.id, c]));
  const rows = new Map();
  for (const v of values) {
    const raw = cellRaw(v);
    const column = colById.get(v.column_id);
    if (raw == null || !column) continue;
    if (!rows.has(v.row_index)) rows.set(v.row_index, []);
    rows.get(v.row_index).push({ raw, column, role: role(column) });
  }

  const facts = {
    counted: false, sets: 0, reps: 0, lifted_lb: 0, carried_lb: 0, bw_lb: 0, corrected: 0,
    work_seconds: 0, distance_km: 0, distance_logged: false, speed_kph: null, grade_pct: null, unparsed: 0,
  };
  const speeds = [];
  const grades = [];
  let loggedKm = null;
  const cardio = rule.category === 'cardio';
  const handleOff = rule.handle && localDate < HANDLE.before ? HANDLE.lb_per_db : 0;

  for (const cells of rows.values()) {
    const cell = (r) => cells.find((c) => c.role === r);
    const completed = cell('completed');
    if (template.kind === 'checkbox' || (completed && cells.length === 1)) {
      if (ticked(completed?.raw)) { facts.counted = true; facts.sets += 1; }
      continue;
    }
    facts.counted = true;
    facts.sets += 1;
    const read = (c, fn) => {
      if (!c) return null;
      const out = fn(c);
      // "0" reads as nothing done, which is not the same as unreadable.
      if (out == null && !/^0+(\.0+)?$/.test(c.raw)) facts.unparsed += 1;
      return out;
    };

    const reps = read(cell('reps'), (c) => parseReps(c.raw));
    const repTotal = reps == null ? 0
      : reps.count * (reps.sides === 'per_side' || (reps.sides === 'bare' && rule.per_side) ? 2 : 1);
    facts.reps += repTotal;
    if (rule.bw_fraction > 0) facts.bw_lb += rule.bw_fraction * bodyKg * LB_PER_KG * repTotal;

    const seconds = read(cell('time'), (c) => parseSeconds(c.raw, c.column, cardio ? 60 : 1));
    if (seconds != null) facts.work_seconds += seconds;

    const load = read(cell('weight'), (c) => parseLoad(c.raw, c.column.unit));
    // Carries move their load every step of the logged time; lifts every rep.
    const moves = rule.carry ? (seconds ?? 0) * CARRY_STEPS_PER_SECOND : rule.hold ? 0 : repTotal;
    if (load && moves > 0) {
      const total = load.total || (load.implements == null && rule.value_is === 'total');
      // A total is one implement carrying every handle in the pair.
      const implementsMoved = total ? 1 : load.implements ?? Math.max(rule.dbs, 1);
      const shed = handleOff * (total ? Math.max(rule.dbs, 1) : 1);
      if (shed > 0) facts.corrected += 1;
      const moved = Math.max(0, load.lb - shed) * implementsMoved * moves;
      if (rule.carry) facts.carried_lb += moved; else facts.lifted_lb += moved;
    }
    const speed = read(cell('speed') ?? cell('pace'), (c) => parseSpeedKph(c.raw, c.column));
    if (speed != null) speeds.push(speed);
    const grade = read(cell('incline'), (c) => parseGradePct(c.raw));
    if (grade != null) grades.push(grade);
    const km = read(cell('distance'), (c) => parseDistanceKm(c.raw, c.column));
    if (km != null) loggedKm = (loggedKm ?? 0) + km;
  }

  facts.speed_kph = mean(speeds);
  facts.grade_pct = mean(grades);
  // Without a logged distance, cardio covers speed x time.
  facts.distance_logged = loggedKm != null;
  facts.distance_km = loggedKm
    ?? (cardio && facts.speed_kph != null ? facts.speed_kph * facts.work_seconds / 3600 : 0);
  return facts;
}
