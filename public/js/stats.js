// Stats aggregation over /api/stats sessions. Pure (no DOM) so node tests
// can drive it; weeks are local Mondays, built with Date arithmetic so a DST
// change doesn't shift a boundary by an hour.

const CATEGORIES = ['strength', 'cardio', 'mobility'];
const byCategory = (field) => (s, key) => (s.category === key ? s[field] : 0);
const LOAD_FIELD = { lifted: 'lifted_lb', bodyweight: 'bw_lb', carried: 'carried_lb' };

export const METRICS = {
  time: { label: 'Time', keys: CATEGORIES, value: byCategory('seconds'), format: (v) => formatDuration(v) },
  energy: { label: 'Energy', keys: CATEGORIES, value: byCategory('kcal'), format: (v) => `${formatCompact(v)} kcal` },
  weight: { label: 'Weight', keys: ['lifted', 'bodyweight', 'carried'], value: (s, key) => s[LOAD_FIELD[key]], format: (v) => `${formatCompact(v)} lb` },
  reps: { label: 'Reps', keys: ['reps'], value: (s) => s.reps, format: (v) => formatCompact(v) },
};

export const SERIES_LABELS = {
  strength: 'Strength', cardio: 'Cardio', mobility: 'Mobility',
  lifted: 'Lifted', bodyweight: 'Bodyweight (est.)', carried: 'Carried (est.)', reps: 'Reps',
};

export const RANGES = { '4w': 4, '12w': 12, all: null };

export function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function addWeeks(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + 7 * n);
  return d.getTime();
}

export function rangeStart(range, sessions, now) {
  const weeks = RANGES[range];
  const current = weekStart(now);
  if (weeks != null) return addWeeks(current, -(weeks - 1));
  const first = sessions.reduce((m, s) => Math.min(m, s.started_at), Infinity);
  return Number.isFinite(first) ? Math.min(weekStart(first), current) : current;
}

export function inRange(sessions, range, now) {
  const start = rangeStart(range, sessions, now);
  return sessions.filter((s) => s.started_at >= start);
}

const metricValue = (metric, s) => metric.keys.reduce((a, k) => a + (metric.value(s, k) || 0), 0);

export function weeklySeries(sessions, { range, metric: metricName, now }) {
  const metric = METRICS[metricName];
  const start = rangeStart(range, sessions, now);
  const current = weekStart(now);
  const weeks = [];
  for (let w = start; w <= current; w = addWeeks(w, 1)) {
    weeks.push({ start: w, label: weekLabel(w), parts: Object.fromEntries(metric.keys.map((k) => [k, 0])), total: 0 });
  }
  const index = new Map(weeks.map((w, i) => [w.start, i]));
  for (const s of sessions) {
    const i = index.get(weekStart(s.started_at));
    if (i == null) continue;
    for (const k of metric.keys) weeks[i].parts[k] += metric.value(s, k) || 0;
  }
  for (const w of weeks) w.total = metric.keys.reduce((a, k) => a + w.parts[k], 0);
  return weeks;
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export function totals(sessions) {
  const t = {
    seconds: 0, measured_seconds: 0, kcal: 0, lifted_lb: 0, bw_lb: 0, carried_lb: 0, moved_lb: 0,
    reps: 0, distance_km: 0, sessions: sessions.length, active_days: new Set(sessions.map((s) => dayKey(s.started_at))).size,
  };
  for (const s of sessions) {
    t.seconds += s.seconds;
    if (s.time_source === 'stopwatch' || s.time_source === 'span') t.measured_seconds += s.seconds;
    t.kcal += s.kcal;
    t.lifted_lb += s.lifted_lb;
    t.bw_lb += s.bw_lb;
    t.carried_lb += s.carried_lb;
    t.reps += s.reps;
    t.distance_km += s.distance_km;
  }
  t.moved_lb = t.lifted_lb + t.bw_lb + t.carried_lb;
  return t;
}

export function byTemplate(sessions, templates, metricName, { limit = 10 } = {}) {
  const metric = METRICS[metricName];
  const names = new Map(templates.map((t) => [t.id, t.name]));
  const sums = new Map();
  for (const s of sessions) sums.set(s.template_id, (sums.get(s.template_id) ?? 0) + metricValue(metric, s));
  const rows = [...sums].filter(([, v]) => v > 0)
    .map(([id, value]) => ({ id, name: names.get(id) ?? `#${id}`, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  if (rows.length <= limit) return rows;
  const other = rows.slice(limit).reduce((a, r) => a + r.value, 0);
  return [...rows.slice(0, limit), { id: null, name: 'Other', value: other }];
}

// Bar lengths as a percent of the track, floored at 1% so a sliver still shows.
// The longest row fills it: Other trails the ranking but can outweigh the leader.
export function barWidths(rows) {
  const top = Math.max(...rows.map((r) => r.value));
  return rows.map((r) => Math.max(1, (r.value / top) * 100));
}

export function coverage(sessions) {
  const out = { stopwatch: 0, span: 0, logged: 0, typical: 0, rule: 0 };
  for (const s of sessions) out[s.time_source] = (out[s.time_source] ?? 0) + 1;
  return out;
}

export function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export function formatCompact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 10 || Number.isInteger(n)) return grouped.format(n);
  return n.toFixed(1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function weekLabel(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Body series ({ date: 'YYYY-MM-DD', <key>: n }, one per day, ascending).
export function dateMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Day numbers from the calendar date itself, so a DST change can't make a
// "7-day" window 6 days and 23 hours.
const dayNumber = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

// Trailing average over `days` calendar days, the day itself included.
// Computed over the whole series so a range's first points still average
// over the days before it.
export function rollingAverage(series, key, days = 7) {
  const out = [];
  let from = 0;
  for (let i = 0; i < series.length; i++) {
    const today = dayNumber(series[i].date);
    while (dayNumber(series[from].date) <= today - days) from += 1;
    const window = series.slice(from, i + 1);
    out.push({
      date: series[i].date,
      ms: dateMs(series[i].date),
      value: series[i][key],
      avg: window.reduce((a, p) => a + p[key], 0) / window.length,
    });
  }
  return out;
}

export function bodyInRange(points, range, now) {
  if (RANGES[range] == null) return points;
  const start = rangeStart(range, [], now);
  return points.filter((p) => p.ms >= start);
}
