// Pacific time, so the DST change (2026-11-01) falls inside a test range.
process.env.TZ = 'America/Los_Angeles';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weekStart, weeklySeries, totals, byTemplate, formatDuration, formatCompact, weekLabel, METRICS,
  dateMs, rollingAverage, bodyInRange,
} from './stats.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const s = (startedAt, over = {}) => ({
  id: String(startedAt), template_id: 1, started_at: startedAt, category: 'strength',
  seconds: 600, time_source: 'stopwatch', kcal: 50, lifted_lb: 1000, bw_lb: 0, carried_lb: 0,
  reps: 20, distance_km: 0, ...over,
});

test('weekStart is local Monday midnight, across the DST change', () => {
  assert.equal(weekStart(at(2026, 10, 7)), at(2026, 10, 5, 0));
  assert.equal(weekStart(at(2026, 10, 5, 0)), at(2026, 10, 5, 0));
  assert.equal(weekStart(at(2026, 10, 11, 23)), at(2026, 10, 5, 0));
  assert.equal(weekStart(at(2026, 11, 4)), at(2026, 11, 2, 0));
  assert.equal(weekStart(at(2026, 11, 1, 3)), at(2026, 10, 26, 0));
});

test('weeklySeries zero-fills every week in the range, oldest first', () => {
  const now = at(2026, 11, 4);
  const sessions = [
    s(at(2026, 10, 27)),
    s(at(2026, 10, 28), { category: 'cardio', seconds: 2700 }),
    s(at(2026, 11, 3), { category: 'mobility', seconds: 300 }),
    s(at(2026, 9, 1)), // outside 4 weeks
  ];
  const weeks = weeklySeries(sessions, { range: '4w', metric: 'time', now });
  assert.deepEqual(weeks.map((w) => w.start), [at(2026, 10, 12, 0), at(2026, 10, 19, 0), at(2026, 10, 26, 0), at(2026, 11, 2, 0)]);
  assert.deepEqual(weeks.map((w) => w.total), [0, 0, 3300, 300]);
  assert.deepEqual(weeks[2].parts, { strength: 600, cardio: 2700, mobility: 0 });
  assert.equal(weeks[2].label, 'Oct 26');

  // "all" starts at the first session's week
  const all = weeklySeries(sessions, { range: 'all', metric: 'reps', now });
  assert.equal(all[0].start, at(2026, 8, 31, 0));
  assert.equal(all.length, 10);
  assert.deepEqual(all.at(-1).parts, { reps: 20 });
});

test('the weight metric stacks lifted, bodyweight and carried', () => {
  const now = at(2026, 10, 7);
  const [w] = weeklySeries([s(at(2026, 10, 6), { lifted_lb: 500, bw_lb: 2000, carried_lb: 3000 })], { range: '4w', metric: 'weight', now }).slice(-1);
  assert.deepEqual(w.parts, { lifted: 500, bodyweight: 2000, carried: 3000 });
  assert.equal(w.total, 5500);
  assert.deepEqual(METRICS.weight.keys, ['lifted', 'bodyweight', 'carried']);
});

test('totals: sums, measured share and active days', () => {
  const t = totals([
    s(at(2026, 10, 5, 8), { seconds: 600, time_source: 'stopwatch', distance_km: 0 }),
    s(at(2026, 10, 5, 18), { seconds: 300, time_source: 'span' }),
    s(at(2026, 10, 6), { seconds: 900, time_source: 'rule', category: 'cardio', distance_km: 3.75, lifted_lb: 0, bw_lb: 100, carried_lb: 50 }),
  ]);
  assert.equal(t.seconds, 1800);
  assert.equal(t.measured_seconds, 900);
  assert.equal(t.kcal, 150);
  assert.equal(t.lifted_lb, 2000);
  assert.equal(t.bw_lb, 100);
  assert.equal(t.carried_lb, 50);
  assert.equal(t.moved_lb, 2150);
  assert.equal(t.reps, 60);
  assert.equal(t.distance_km, 3.75);
  assert.equal(t.sessions, 3);
  assert.equal(t.active_days, 2);
});

test('byTemplate ranks exercises by the metric and folds the tail into Other', () => {
  const templates = [1, 2, 3].map((id) => ({ id, name: `T${id}` }));
  const rows = byTemplate([
    s(1, { template_id: 1, seconds: 100 }), s(2, { template_id: 2, seconds: 300 }),
    s(3, { template_id: 3, seconds: 50 }), s(4, { template_id: 1, seconds: 100 }),
  ], templates, 'time', { limit: 2 });
  assert.deepEqual(rows, [{ id: 2, name: 'T2', value: 300 }, { id: 1, name: 'T1', value: 200 }, { id: null, name: 'Other', value: 50 }]);
  // zero rows drop out
  assert.deepEqual(byTemplate([s(1, { carried_lb: 0, lifted_lb: 0, bw_lb: 0 })], templates, 'weight'), []);
});

test('formatting', () => {
  assert.equal(formatDuration(0), '0 m');
  assert.equal(formatDuration(3300), '55 m');
  assert.equal(formatDuration(3600 * 12 + 300), '12 h 05 m');
  assert.equal(formatCompact(0), '0');
  assert.equal(formatCompact(1284), '1,284');
  assert.equal(formatCompact(12_940), '12.9K');
  assert.equal(formatCompact(4_200_000), '4.2M');
  assert.equal(formatCompact(3.75), '3.8');
  assert.equal(weekLabel(at(2026, 1, 5)), 'Jan 5');
});

test('dateMs: a logged YYYY-MM-DD is local midnight', () => {
  assert.equal(dateMs('2026-10-05'), at(2026, 10, 5, 0));
  assert.equal(dateMs('2026-11-01'), at(2026, 11, 1, 0));
});

test('rollingAverage: trailing 7 calendar days, the day itself included', () => {
  const pts = rollingAverage([
    { date: '2026-09-01', kg: 102 }, { date: '2026-09-03', kg: 100 },
    { date: '2026-09-08', kg: 101 }, { date: '2026-09-09', kg: 99 },
  ], 'kg');
  assert.deepEqual(pts.map((p) => p.avg), [102, 101, 100.5, 100]);
  assert.deepEqual(pts.map((p) => p.value), [102, 100, 101, 99]);
  assert.equal(pts[0].ms, at(2026, 9, 1, 0));
  // a 7-day window across the DST change still spans 7 days
  const dst = rollingAverage([{ date: '2026-10-26', kg: 100 }, { date: '2026-11-01', kg: 98 }, { date: '2026-11-02', kg: 96 }], 'kg');
  assert.deepEqual(dst.map((p) => p.avg), [100, 99, 97]);
});

test('bodyInRange keeps readings from the range start; All keeps everything', () => {
  const now = at(2026, 10, 7);
  const pts = rollingAverage([{ date: '2026-08-01', kg: 103 }, { date: '2026-09-15', kg: 101 }, { date: '2026-10-06', kg: 100 }], 'kg');
  assert.deepEqual(bodyInRange(pts, '4w', now).map((p) => p.date), ['2026-09-15', '2026-10-06']);
  assert.equal(bodyInRange(pts, 'all', now).length, 3);
});
