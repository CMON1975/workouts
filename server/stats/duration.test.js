import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweptSessionIds, typicalSecondsPerSet, sessionSeconds } from './duration.js';

const MIN = 60_000;

test('sweptSessionIds: a stamp shared with siblings or with the workout', () => {
  const sessions = [
    // swept workout: both children carry the sweep's one `now`
    { id: 'a', workout_id: 'w1', finalized_at: 5000, workout_finalized_at: 5000 },
    { id: 'b', workout_id: 'w1', finalized_at: 5000, workout_finalized_at: 5000 },
    // single-child sweep: only the workout match gives it away
    { id: 'c', workout_id: 'w2', finalized_at: 9000, workout_finalized_at: 9000 },
    // normal run: each Next finalizes separately, then the workout
    { id: 'd', workout_id: 'w3', finalized_at: 1000, workout_finalized_at: 3000 },
    { id: 'e', workout_id: 'w3', finalized_at: 2000, workout_finalized_at: 3000 },
    // ad-hoc session
    { id: 'f', workout_id: null, finalized_at: 4000, workout_finalized_at: null },
  ];
  assert.deepEqual([...sweptSessionIds(sessions)].sort(), ['a', 'b', 'c']);
});

test('typicalSecondsPerSet: per-template median, only with 3+ samples', () => {
  const typical = typicalSecondsPerSet([
    { template_id: 1, seconds: 600, sets: 4 },
    { template_id: 1, seconds: 800, sets: 4 },
    { template_id: 1, seconds: 400, sets: 2 },
    { template_id: 2, seconds: 300, sets: 3 },
    { template_id: 2, seconds: 300, sets: 3 },
  ]);
  // per set: 150, 200, 200
  assert.equal(typical.get(1), 200);
  assert.equal(typical.has(2), false);
});

const base = {
  session: { template_id: 1, started_at: 0, finalized_at: 10 * MIN, duration_seconds: null },
  facts: { sets: 4, work_seconds: 0 },
  category: 'strength', kind: 'standard', swept: false, typical: new Map(), rest: null,
};
const run = (over = {}) => sessionSeconds({
  ...base, ...over,
  session: { ...base.session, ...over.session },
  facts: { ...base.facts, ...over.facts },
});

test('tier 1: the stopwatch, when plausible', () => {
  assert.deepEqual(run({ session: { duration_seconds: 700 } }), { seconds: 700, source: 'stopwatch' });
});

test('tier 2: finished minus started, unless implausible or swept', () => {
  assert.deepEqual(run(), { seconds: 600, source: 'span' });
  // 5 s for 4 sets is an aborted run: below 30 s a set
  assert.equal(run({ session: { duration_seconds: 5 } }).source, 'span');
  // a re-finalize days later
  assert.notEqual(run({ session: { finalized_at: 509_378_000 } }).source, 'span');
  // the sweep's stamp says nothing about when the sets ended
  assert.notEqual(run({ swept: true }).source, 'span');
});

test('tier 3: logged work time (cardio), or work plus prescribed rest (holds)', () => {
  const lost = { session: { finalized_at: 999 * MIN } };
  assert.deepEqual(run({ ...lost, category: 'cardio', facts: { sets: 1, work_seconds: 2700 } }), { seconds: 2700, source: 'logged' });
  // 3 x 60 s farmer carries, 90 s rest between them
  assert.deepEqual(run({ ...lost, facts: { sets: 3, work_seconds: 180 }, rest: { rest_seconds: 90, rows_per_rest: 1 } }),
    { seconds: 360, source: 'logged' });
  // suitcase: two rows (left, right) per rest
  assert.deepEqual(run({ ...lost, facts: { sets: 4, work_seconds: 240 }, rest: { rest_seconds: 90, rows_per_rest: 2 } }),
    { seconds: 330, source: 'logged' });
});

test('tier 4: the template\'s typical pace; it also rejects relative outliers', () => {
  const typical = new Map([[1, 150]]);
  assert.deepEqual(run({ typical, session: { finalized_at: 999 * MIN } }), { seconds: 600, source: 'typical' });
  // a 40-minute stopwatch on a lift that usually takes 10 is a forgotten timer
  assert.equal(run({ typical, session: { duration_seconds: 2400 } }).source, 'span');
});

test('tier 5: the set rule, and fixed fallbacks', () => {
  const lost = { session: { finalized_at: 999 * MIN } };
  assert.deepEqual(run(lost), { seconds: 4 * 40 + 3 * 90, source: 'rule' });
  assert.deepEqual(run({ ...lost, rest: { rest_seconds: 180, rows_per_rest: null } }), { seconds: 4 * 40 + 3 * 180, source: 'rule' });
  assert.deepEqual(run({ ...lost, kind: 'checkbox', category: 'mobility', facts: { sets: 1 } }), { seconds: 600, source: 'rule' });
  assert.deepEqual(run({ ...lost, category: 'cardio', facts: { sets: 1, work_seconds: 0 } }), { seconds: 1800, source: 'rule' });
});

test('caps by category: a 75-minute walk stands, a 75-minute press does not', () => {
  const long = { session: { duration_seconds: 4515, finalized_at: 999 * MIN } };
  assert.equal(run({ ...long, category: 'cardio', facts: { sets: 1, work_seconds: 4200 } }).source, 'stopwatch');
  assert.notEqual(run(long).source, 'stopwatch');
  // a retro-ticked checkbox (20 s) is not a mobility session's length
  assert.equal(run({ kind: 'checkbox', category: 'mobility', facts: { sets: 1 }, session: { duration_seconds: 20, finalized_at: 20_000 } }).source, 'rule');
});
