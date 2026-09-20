import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMSS, createStopwatch, restSecondsFor, cardioPhasesFor,
  loadStopwatchState, saveStopwatchState, clearStopwatchState, workChainFor,
  intervalPhasesFor,
} from './stopwatch.js';

const T0 = 1_755_850_000_000;

function fakeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

test('formatMSS formats M:SS', () => {
  assert.equal(formatMSS(0), '0:00');
  assert.equal(formatMSS(7), '0:07');
  assert.equal(formatMSS(59), '0:59');
  assert.equal(formatMSS(60), '1:00');
  assert.equal(formatMSS(187), '3:07');
  assert.equal(formatMSS(3661), '61:01');
  assert.equal(formatMSS(null), '0:00');
  assert.equal(formatMSS(undefined), '0:00');
  assert.equal(formatMSS(-5), '0:00');
});

test('idle stopwatch shows 0 and null exercise time', () => {
  const { now } = fakeClock();
  const sw = createStopwatch({ now });
  assert.equal(sw.isRunning(), false);
  assert.equal(sw.displaySeconds(), 0);
  assert.equal(sw.exerciseSeconds(), null);
});

test('start counts wall-clock from epoch', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  clock.advance(187_000);
  assert.equal(sw.isRunning(), true);
  assert.equal(sw.displaySeconds(), 187);
  assert.equal(sw.exerciseSeconds(), 187);
});

test('lap resets display but not exercise total', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  clock.advance(60_000);
  sw.lap();
  assert.equal(sw.displaySeconds(), 0);
  clock.advance(30_000);
  assert.equal(sw.displaySeconds(), 30);
  assert.equal(sw.exerciseSeconds(), 90);
});

test('multiple laps keep the exercise total intact', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  for (let i = 0; i < 4; i++) {
    clock.advance(25_000);
    sw.lap();
  }
  clock.advance(10_000);
  assert.equal(sw.displaySeconds(), 10);
  assert.equal(sw.exerciseSeconds(), 110);
});

test('start while running and lap while idle are no-ops', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.lap(); // idle — must not start anything
  assert.equal(sw.isRunning(), false);
  sw.start();
  clock.advance(45_000);
  sw.start(); // running — must not reset the epoch
  assert.equal(sw.exerciseSeconds(), 45);
});

test('exerciseSeconds is a pure read', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  clock.advance(10_000);
  assert.equal(sw.exerciseSeconds(), 10);
  clock.advance(5_000);
  assert.equal(sw.exerciseSeconds(), 15, 'a later read reflects more elapsed time');
  assert.equal(sw.isRunning(), true, 'reading must not stop the stopwatch');
});

test('commitExercise resets to idle', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  clock.advance(30_000);
  sw.commitExercise();
  assert.equal(sw.isRunning(), false);
  assert.equal(sw.displaySeconds(), 0);
  assert.equal(sw.exerciseSeconds(), null);
});

test('negative elapsed clamps to 0 (clock skew)', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  clock.advance(-5_000);
  assert.equal(sw.displaySeconds(), 0);
  assert.equal(sw.exerciseSeconds(), 0);
});

test('survives eviction: restore from serialized state keeps counting', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now, exerciseIndex: 2 });
  sw.start();
  clock.advance(60_000);
  sw.lap();
  const snapshot = sw.toJSON();

  clock.advance(300_000); // 5 minutes away — tab evicted
  const restored = createStopwatch({ now: clock.now, exerciseIndex: 2, initial: snapshot });
  assert.equal(restored.isRunning(), true);
  assert.equal(restored.exerciseSeconds(), 360, 'away time counts — wall-clock stopwatch');
  assert.equal(restored.displaySeconds(), 300, 'lap-relative display is continuous too');
});

test('loadStopwatchState returns null on missing, corrupt, or wrong-shaped data', () => {
  const storage = fakeStorage();
  assert.equal(loadStopwatchState('w-1', 0, storage), null);

  storage.setItem('stopwatch:w-1', 'not json {');
  assert.equal(loadStopwatchState('w-1', 0, storage), null);

  storage.setItem('stopwatch:w-1', JSON.stringify({ v: 99, exerciseIndex: 0 }));
  assert.equal(loadStopwatchState('w-1', 0, storage), null);

  storage.setItem('stopwatch:w-1', JSON.stringify(['nope']));
  assert.equal(loadStopwatchState('w-1', 0, storage), null);
});

test('loadStopwatchState drops the running timer on exerciseIndex mismatch', () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const sw = createStopwatch({ now: clock.now, exerciseIndex: 1 });
  sw.start();
  saveStopwatchState('w-2', sw, storage);

  // Crash landed us on exercise 2; the stored running timer is exercise 1's.
  const state = loadStopwatchState('w-2', 2, storage);
  assert.ok(state, 'mismatch yields an idle state, not null');
  const restored = createStopwatch({ now: clock.now, exerciseIndex: 2, initial: state });
  assert.equal(restored.isRunning(), false);
  assert.equal(restored.exerciseSeconds(), null);
});

test('save/load/clear round-trip via storage', () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const sw = createStopwatch({ now: clock.now, exerciseIndex: 3 });
  sw.start();
  clock.advance(20_000);
  saveStopwatchState('w-3', sw, storage);

  const state = loadStopwatchState('w-3', 3, storage);
  const restored = createStopwatch({ now: clock.now, exerciseIndex: 3, initial: state });
  assert.equal(restored.exerciseSeconds(), 20);

  clearStopwatchState('w-3', storage);
  assert.equal(loadStopwatchState('w-3', 3, storage), null);
});

test('setExerciseIndex restamps the index for the next exercise', () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const sw = createStopwatch({ now: clock.now, exerciseIndex: 0 });
  sw.start();
  sw.commitExercise();
  sw.setExerciseIndex(1);
  saveStopwatchState('w-4', sw, storage);
  const state = loadStopwatchState('w-4', 1, storage);
  assert.ok(state, 'saved state must match the advanced index');
});

test('startRest while idle is a no-op', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startRest();
  assert.equal(sw.isRunning(), false);
  assert.equal(sw.restRemaining(90), null, 'no countdown may anchor before the exercise timer exists');
});

test('rest countdown counts down and expires to inactive', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  assert.equal(sw.restRemaining(90), null, 'started but no countdown yet — idle full-rest display');
  clock.advance(10_000);
  sw.startRest();
  assert.equal(sw.restRemaining(90), 90);
  clock.advance(1_000);
  assert.equal(sw.restRemaining(90), 89);
  clock.advance(88_000);
  assert.equal(sw.restRemaining(90), 1);
  clock.advance(1_000);
  assert.equal(sw.restRemaining(90), null, 'expired countdown reads as inactive');
  assert.equal(sw.exerciseSeconds(), 100, 'exercise total unaffected by the countdown');
});

test('startRest mid-countdown restarts from full', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  sw.startRest();
  clock.advance(40_000);
  assert.equal(sw.restRemaining(90), 50);
  sw.startRest();
  assert.equal(sw.restRemaining(90), 90);
});

test('restRemainingMs gives exact ms to zero, null when idle or expired', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  assert.equal(sw.restRemainingMs(90), null);
  sw.startRest();
  clock.advance(500);
  assert.equal(sw.restRemainingMs(90), 89_500);
  clock.advance(89_500);
  assert.equal(sw.restRemainingMs(90), null, 'exactly zero remaining is expired');
});

test('restRemaining with null or non-positive restSeconds is null even when anchored', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  sw.startRest();
  assert.equal(sw.restRemaining(null), null);
  assert.equal(sw.restRemaining(0), null);
  assert.equal(sw.restRemainingMs(null), null);
  assert.equal(sw.restRemainingMs(0), null);
});

test('commitExercise clears the countdown', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.start();
  sw.startRest();
  sw.commitExercise();
  assert.equal(sw.restRemaining(90), null);
  assert.equal(sw.toJSON().restEpoch, null, 'an advance mid-countdown must not leak into the next exercise');
});

test('stopwatch state round-trips a countdown across eviction, away time counted', () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const sw = createStopwatch({ now: clock.now, exerciseIndex: 1 });
  sw.start();
  clock.advance(5_000);
  sw.startRest();
  saveStopwatchState('w-6', sw, storage);

  clock.advance(30_000); // tab evicted mid-countdown
  const state = loadStopwatchState('w-6', 1, storage);
  assert.equal(state.v, 4);
  const restored = createStopwatch({ now: clock.now, exerciseIndex: 1, initial: state });
  assert.equal(restored.restRemaining(90), 60, 'countdown continues from wall clock');
  assert.equal(restored.exerciseSeconds(), 35);
});

test('loadStopwatchState upgrades a v1 payload, keeping the running timer', () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  storage.setItem('stopwatch:w-7', JSON.stringify({
    v: 1, exerciseIndex: 2, startEpoch: T0 - 20_000, lapEpoch: T0 - 20_000,
  }));
  const state = loadStopwatchState('w-7', 2, storage);
  assert.ok(state, 'v1 payload must upgrade, not reject');
  assert.equal(state.v, 4);
  const restored = createStopwatch({ now: clock.now, exerciseIndex: 2, initial: state });
  assert.equal(restored.isRunning(), true);
  assert.equal(restored.exerciseSeconds(), 20, 'a deploy mid-workout keeps the running timer');
  assert.equal(restored.restRemaining(90), null, 'no countdown carried over from v1');
});

test('exerciseIndex mismatch idles the countdown too', () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const sw = createStopwatch({ now: clock.now, exerciseIndex: 1 });
  sw.start();
  sw.startRest();
  saveStopwatchState('w-8', sw, storage);

  const state = loadStopwatchState('w-8', 2, storage);
  assert.equal(state.restEpoch, null);
  const restored = createStopwatch({ now: clock.now, exerciseIndex: 2, initial: state });
  assert.equal(restored.restRemaining(90), null);
});

test('restSecondsFor resolves the prescribed rest for a template', () => {
  const prescribed = {
    exercises: [
      { template_id: 7, rest_seconds: 90 },
      { template_id: 9, rest_seconds: null },
    ],
  };
  assert.equal(restSecondsFor(prescribed, 7), 90);
});

test('restSecondsFor is null for every absent or invalid shape', () => {
  assert.equal(restSecondsFor(null, 7), null);
  assert.equal(restSecondsFor(undefined, 7), null);
  assert.equal(restSecondsFor({}, 7), null, 'stale cached prescription without exercises');
  assert.equal(restSecondsFor({ exercises: [] }, 7), null);
  assert.equal(restSecondsFor({ exercises: [{ template_id: 9, rest_seconds: 90 }] }, 7), null);
  assert.equal(restSecondsFor({ exercises: [{ template_id: 7, rest_seconds: null }] }, 7), null);
  assert.equal(restSecondsFor({ exercises: [{ template_id: 7, rest_seconds: 0 }] }, 7), null);
  assert.equal(restSecondsFor({ exercises: [{ template_id: 7, rest_seconds: -5 }] }, 7), null);
  assert.equal(restSecondsFor({ exercises: [{ template_id: 7, rest_seconds: 1.5 }] }, 7), null);
  assert.equal(restSecondsFor({ exercises: [{ template_id: 7, rest_seconds: '90' }] }, 7), null);
});

test('storage errors are swallowed (private mode, quota)', () => {
  const throwing = {
    getItem: () => { throw new Error('nope'); },
    setItem: () => { throw new Error('nope'); },
    removeItem: () => { throw new Error('nope'); },
  };
  const sw = createStopwatch({ now: () => T0 });
  assert.equal(loadStopwatchState('w-5', 0, throwing), null);
  saveStopwatchState('w-5', sw, throwing); // must not throw
  clearStopwatchState('w-5', throwing); // must not throw
});

// ---- Chained work/rest cycles (timed holds & carries) ----

const PLANK = {
  template: { id: 9, columns: [{ name: 'time' }] },
  prescribed: {
    exercises: [{ template_id: 9, rest_seconds: 60 }],
    targets: [
      { template_id: 9, row_index: 0, column_name: 'time', target_num: 45 },
      { template_id: 9, row_index: 1, column_name: 'time', target_num: 45 },
      { template_id: 9, row_index: 2, column_name: 'time', target_num: 40 },
    ],
  },
};

const CARRY = {
  template: { id: 10, columns: [{ name: 'weight' }, { name: 'time' }, { name: 'side' }] },
  prescribed: {
    exercises: [{ template_id: 10, rest_seconds: 90, rows_per_rest: 2 }],
    targets: [0, 1, 2, 3].flatMap(r => [
      { template_id: 10, row_index: r, column_name: 'weight', target_num: 35 },
      { template_id: 10, row_index: r, column_name: 'time', target_num: 30 },
    ]),
  },
};

test('workChainFor: plank derives one timed work row then rest', () => {
  const phases = workChainFor({ ...PLANK, completedRows: 0 });
  assert.deepEqual(phases, [
    { kind: 'work', seconds: 45, row: 0 },
    { kind: 'rest', seconds: 60 },
  ]);
  assert.deepEqual(workChainFor({ ...PLANK, completedRows: 1 }), [
    { kind: 'work', seconds: 45, row: 1 },
    { kind: 'rest', seconds: 60 },
  ], 'a middle row still rests');
});

test('workChainFor: rows_per_rest chains two carry sides before one rest', () => {
  assert.deepEqual(workChainFor({ ...CARRY, completedRows: 0 }), [
    { kind: 'work', seconds: 30, row: 0 },
    { kind: 'work', seconds: 30, row: 1 },
    { kind: 'rest', seconds: 90 },
  ]);
});

test('workChainFor: no rest after the final prescribed row (nothing to chain into)', () => {
  // Plank: row 2 is the last of 3 — its chain is the hold alone; the exercise
  // ends there instead of running dead rest time.
  assert.deepEqual(workChainFor({ ...PLANK, completedRows: 2 }), [
    { kind: 'work', seconds: 40, row: 2 },
  ]);
  // Carry: the second L/R pair is the last of 4 rows.
  assert.deepEqual(workChainFor({ ...CARRY, completedRows: 2 }), [
    { kind: 'work', seconds: 30, row: 2 },
    { kind: 'work', seconds: 30, row: 3 },
  ]);
  // Beyond the prescription no row is known to be final: the rest stays.
  assert.deepEqual(workChainFor({ ...PLANK, completedRows: 3 }), [
    { kind: 'work', seconds: null, row: 3 },
    { kind: 'rest', seconds: 60 },
  ]);
});

test('workChainFor: max hold (time column, no time targets) is open-ended work', () => {
  const prescribed = {
    exercises: [{ template_id: 9, rest_seconds: 60 }],
    targets: [],
  };
  assert.deepEqual(workChainFor({ template: PLANK.template, prescribed, completedRows: 0 }), [
    { kind: 'work', seconds: null, row: 0 },
    { kind: 'rest', seconds: 60 },
  ]);
});

test('workChainFor: prescribed rows exhausted falls back to open-ended work', () => {
  assert.deepEqual(workChainFor({ ...PLANK, completedRows: 3 }), [
    { kind: 'work', seconds: null, row: 3 },
    { kind: 'rest', seconds: 60 },
  ]);
});

test('workChainFor: inactive without rest_seconds or without a time column', () => {
  const noRest = { exercises: [], targets: PLANK.prescribed.targets };
  assert.equal(workChainFor({ template: PLANK.template, prescribed: noRest, completedRows: 0 }), null);
  const repLift = { id: 4, columns: [{ name: 'reps' }, { name: 'weight' }] };
  assert.equal(workChainFor({ template: repLift, prescribed: {
    exercises: [{ template_id: 4, rest_seconds: 120 }],
    targets: [{ template_id: 4, row_index: 0, column_name: 'reps', target_num: 8 }],
  }, completedRows: 0 }), null);
});

test('chain: carry auto-advances L -> R -> rest -> done without presses', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startChain(workChainFor({ ...CARRY, completedRows: 0 }));
  assert.equal(sw.isRunning(), true, 'first press also starts the exercise timer');
  assert.deepEqual(sw.chainPhase(), { kind: 'work', row: 0, seconds: 30, elapsed: 0, remaining: 30 });
  clock.advance(30_000);
  assert.equal(sw.chainPhase().row, 1, 'right side starts itself');
  clock.advance(5_000);
  assert.deepEqual(sw.chainPhase(), { kind: 'work', row: 1, seconds: 30, elapsed: 5, remaining: 25 });
  clock.advance(25_000);
  assert.equal(sw.chainPhase().kind, 'rest');
  clock.advance(90_000);
  assert.equal(sw.chainPhase(), null, 'chain complete, idle');
  assert.equal(sw.completedRows(), 2);
  assert.deepEqual(sw.takeCompletedWork(), [
    { row: 0, seconds: 30 },
    { row: 1, seconds: 30 },
  ]);
  assert.deepEqual(sw.takeCompletedWork(), [], 'drained');
});

test('chain: press mid-work ends the phase early and records actual elapsed', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startChain(workChainFor({ ...PLANK, completedRows: 1 }));
  clock.advance(33_000);
  sw.advanceChain();
  assert.equal(sw.chainPhase().kind, 'rest');
  assert.equal(sw.chainPhase().remaining, 60, 'rest re-anchored at the press');
  assert.deepEqual(sw.takeCompletedWork(), [{ row: 1, seconds: 33 }]);
});

test('chain: open-ended work never auto-advances; press moves it to rest', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startChain(workChainFor({ ...PLANK, completedRows: 3 }));
  clock.advance(600_000);
  assert.deepEqual(sw.chainPhase(), { kind: 'work', row: 3, seconds: null, elapsed: 600, remaining: null });
  sw.advanceChain();
  assert.equal(sw.chainPhase().kind, 'rest');
  assert.deepEqual(sw.takeCompletedWork(), [{ row: 3, seconds: 600 }]);
});

test('chain: press during rest completes the chain immediately', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startChain(workChainFor({ ...PLANK, completedRows: 0 }));
  clock.advance(45_000);
  assert.equal(sw.chainPhase().kind, 'rest');
  clock.advance(10_000);
  sw.advanceChain();
  assert.equal(sw.chainPhase(), null, 'rest cut short; armed for the next press');
  assert.equal(sw.completedRows(), 1);
});

test('chain: survives eviction mid-chain and folds phases that elapsed while away', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now, exerciseIndex: 1 });
  sw.startChain(workChainFor({ ...CARRY, completedRows: 0 }));
  clock.advance(12_000);
  const snapshot = JSON.parse(JSON.stringify(sw.toJSON()));
  clock.advance(50_000); // away: L ends at 30s, R at 60s; we're 2s into rest
  const restored = createStopwatch({ now: clock.now, exerciseIndex: 1, initial: snapshot });
  assert.deepEqual(restored.chainPhase(), { kind: 'rest', seconds: 90, elapsed: 2, remaining: 88 });
  assert.equal(restored.completedRows(), 2);
  assert.deepEqual(restored.takeCompletedWork(), [
    { row: 0, seconds: 30 },
    { row: 1, seconds: 30 },
  ]);
});

test('chain: v2 state upgrades to v3 with no chain and keeps epochs', () => {
  const storage = fakeStorage();
  storage.setItem('stopwatch:w1', JSON.stringify({
    v: 2, exerciseIndex: 3, startEpoch: T0, lapEpoch: T0, restEpoch: T0 + 60_000,
  }));
  const state = loadStopwatchState('w1', 3, storage);
  assert.equal(state.startEpoch, T0);
  assert.equal(state.restEpoch, T0 + 60_000);
  assert.equal(state.chain, null);
  assert.deepEqual(state.completedWork, []);
  assert.equal(state.completedRowsCount, 0);
});

test('chain: exercise-index mismatch resets chain state too', () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const sw = createStopwatch({ now: clock.now, exerciseIndex: 1 });
  sw.startChain(workChainFor({ ...PLANK, completedRows: 0 }));
  saveStopwatchState('w1', sw, storage);
  const state = loadStopwatchState('w1', 2, storage);
  assert.equal(state.startEpoch, null);
  assert.equal(state.chain, null);
});

test('chain: commitExercise clears chain, log, and row count', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startChain(workChainFor({ ...PLANK, completedRows: 0 }));
  clock.advance(45_000);
  sw.commitExercise();
  assert.equal(sw.chainPhase(), null);
  assert.equal(sw.completedRows(), 0);
  assert.deepEqual(sw.takeCompletedWork(), []);
  assert.equal(sw.isRunning(), false);
});

// Interval programs: warmup, then work/easy x rounds, then cooldown (optionally
// split into equal steps so a treadmill speed drop gets its own countdown).
const INTERVALS = {
  exercises: [{
    template_id: 33,
    rest_seconds: null,
    rows_per_rest: null,
    intervals: {
      warmup_seconds: 480, work_seconds: 60, easy_seconds: 120, rounds: 8,
      cooldown_seconds: 300, cooldown_step_seconds: 60,
    },
  }],
};

test('intervalPhasesFor: the full treadmill program, in order, with labels', () => {
  const phases = intervalPhasesFor(INTERVALS, 33);
  assert.equal(phases.length, 1 + 8 * 2 + 5);
  assert.deepEqual(phases[0], { kind: 'warmup', seconds: 480, label: 'warmup' });
  assert.deepEqual(phases[1], { kind: 'intense', seconds: 60, label: 'intense 1/8' });
  assert.deepEqual(phases[2], { kind: 'easy', seconds: 120, label: 'easy 1/8' });
  assert.deepEqual(phases[15], { kind: 'intense', seconds: 60, label: 'intense 8/8' });
  assert.deepEqual(phases[16], { kind: 'easy', seconds: 120, label: 'easy 8/8' });
  assert.deepEqual(phases[17], { kind: 'cooldown', seconds: 60, label: 'cooldown 1/5' });
  assert.deepEqual(phases[21], { kind: 'cooldown', seconds: 60, label: 'cooldown 5/5' });
  assert.equal(phases.reduce((a, p) => a + p.seconds, 0), 480 + 8 * 180 + 300);
});

test('intervalPhasesFor: adapts to different numbers and omitted sections', () => {
  const build = (intervals) => intervalPhasesFor({ exercises: [{ template_id: 1, intervals }] }, 1);
  // No warmup / no cooldown: just the rounds.
  assert.deepEqual(build({ work_seconds: 30, easy_seconds: 30, rounds: 2 }), [
    { kind: 'intense', seconds: 30, label: 'intense 1/2' },
    { kind: 'easy', seconds: 30, label: 'easy 1/2' },
    { kind: 'intense', seconds: 30, label: 'intense 2/2' },
    { kind: 'easy', seconds: 30, label: 'easy 2/2' },
  ]);
  // Cooldown without a step is one countdown; with a step that doesn't divide
  // evenly the last step carries the remainder.
  assert.deepEqual(build({ work_seconds: 20, easy_seconds: 0, rounds: 1, cooldown_seconds: 90 }), [
    { kind: 'intense', seconds: 20, label: 'intense 1/1' },
    { kind: 'cooldown', seconds: 90, label: 'cooldown' },
  ]);
  assert.deepEqual(
    build({ work_seconds: 20, easy_seconds: 0, rounds: 1, cooldown_seconds: 150, cooldown_step_seconds: 60 }).slice(1),
    [
      { kind: 'cooldown', seconds: 60, label: 'cooldown 1/3' },
      { kind: 'cooldown', seconds: 60, label: 'cooldown 2/3' },
      { kind: 'cooldown', seconds: 30, label: 'cooldown 3/3' },
    ],
  );
  // A step at least as long as the cooldown is the same as no step.
  assert.deepEqual(build({ work_seconds: 20, easy_seconds: 0, rounds: 1, cooldown_seconds: 60, cooldown_step_seconds: 60 }).slice(1), [
    { kind: 'cooldown', seconds: 60, label: 'cooldown' },
  ]);
});

test('intervalPhasesFor: null for every absent or unusable shape', () => {
  assert.equal(intervalPhasesFor(null, 33), null);
  assert.equal(intervalPhasesFor({}, 33), null);
  assert.equal(intervalPhasesFor({ exercises: [] }, 33), null);
  assert.equal(intervalPhasesFor(INTERVALS, 34), null, 'other template');
  assert.equal(intervalPhasesFor({ exercises: [{ template_id: 1, rest_seconds: 90 }] }, 1), null, 'rest only');
  assert.equal(intervalPhasesFor({ exercises: [{ template_id: 1, intervals: null }] }, 1), null);
  assert.equal(intervalPhasesFor({ exercises: [{ template_id: 1, intervals: 'x' }] }, 1), null);
  assert.equal(intervalPhasesFor({ exercises: [{ template_id: 1, intervals: { easy_seconds: 60, rounds: 4 } }] }, 1), null, 'no work');
  assert.equal(intervalPhasesFor({ exercises: [{ template_id: 1, intervals: { work_seconds: 60, easy_seconds: 60, rounds: 0 } }] }, 1), null, 'no rounds');
});

test('chain: interval phases run continuously, carry labels, and end completed', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  assert.equal(sw.chainCompleted(), false, 'idle is not completed');
  sw.startChain(intervalPhasesFor({
    exercises: [{ template_id: 1, intervals: { warmup_seconds: 10, work_seconds: 5, easy_seconds: 5, rounds: 2, cooldown_seconds: 10, cooldown_step_seconds: 5 } }],
  }, 1));
  assert.equal(sw.isRunning(), true, 'starting the program starts the exercise clock');
  assert.deepEqual(sw.chainPhase(), { kind: 'warmup', seconds: 10, elapsed: 0, remaining: 10, label: 'warmup' });
  clock.advance(10_000);
  assert.deepEqual(sw.chainPhase(), { kind: 'intense', seconds: 5, elapsed: 0, remaining: 5, label: 'intense 1/2' });
  clock.advance(7_000);
  assert.deepEqual(sw.chainPhase(), { kind: 'easy', seconds: 5, elapsed: 2, remaining: 3, label: 'easy 1/2' });
  clock.advance(13_000); // through intense 2 and easy 2
  assert.equal(sw.chainPhase().label, 'cooldown 1/2');
  assert.equal(sw.chainCompleted(), false, 'still running');
  clock.advance(10_000);
  assert.equal(sw.chainPhase(), null);
  assert.equal(sw.chainCompleted(), true, 'ran out by time');
  assert.equal(sw.completedRows(), 0, 'interval phases are not work rows');
  assert.deepEqual(sw.takeCompletedWork(), [], 'nothing to autofill');
  assert.equal(sw.isRunning(), true, 'exercise clock keeps going after the program');
});

test('chain: a press skips to the next interval phase; skipping the last completes', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startChain(intervalPhasesFor({
    exercises: [{ template_id: 1, intervals: { warmup_seconds: 60, work_seconds: 5, easy_seconds: 5, rounds: 1 } }],
  }, 1));
  clock.advance(3_000);
  sw.advanceChain();
  assert.deepEqual(sw.chainPhase(), { kind: 'intense', seconds: 5, elapsed: 0, remaining: 5, label: 'intense 1/1' });
  sw.advanceChain();
  assert.equal(sw.chainPhase().kind, 'easy');
  sw.advanceChain();
  assert.equal(sw.chainPhase(), null);
  assert.equal(sw.chainCompleted(), true, 'skipping the last phase completes the program');
  assert.deepEqual(sw.takeCompletedWork(), []);
});

test('chain: completed flag clears on restart and on commitExercise, survives eviction', () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const sw = createStopwatch({ now: clock.now });
  const phases = [{ kind: 'intense', seconds: 5, label: 'intense 1/1' }];
  sw.startChain(phases);
  clock.advance(5_000);
  assert.equal(sw.chainCompleted(), true);
  saveStopwatchState('w1', sw, storage);
  const restored = createStopwatch({ now: clock.now, initial: loadStopwatchState('w1', 0, storage) });
  assert.equal(restored.chainCompleted(), true, 'done state persists across eviction');
  sw.startChain(phases);
  assert.equal(sw.chainCompleted(), false, 'restarted');
  clock.advance(5_000);
  assert.equal(sw.chainCompleted(), true);
  sw.commitExercise();
  assert.equal(sw.chainCompleted(), false, 'next exercise starts clean');
});

test('chain: v3 state upgrades to v4 with chainCompleted false and keeps the chain', () => {
  const storage = fakeStorage();
  const chain = { epoch: T0, phases: [{ kind: 'rest', seconds: 60 }] };
  storage.setItem('stopwatch:w1', JSON.stringify({
    v: 3, exerciseIndex: 2, startEpoch: T0, lapEpoch: T0, restEpoch: null,
    chain, completedWork: [{ row: 0, seconds: 30 }], completedRowsCount: 1,
  }));
  const state = loadStopwatchState('w1', 2, storage);
  assert.equal(state.chainCompleted, false);
  assert.deepEqual(state.chain, chain);
  assert.equal(state.completedRowsCount, 1);
  const sw = createStopwatch({ now: () => T0 + 1_000, initial: state });
  assert.equal(sw.chainPhase().kind, 'rest', 'mid-chain state still resumes');
});

// ---- lead_in_seconds: a "get set" countdown before the pressed work phase ----

const HOLD = {
  template: { id: 11, columns: [{ name: 'time' }] },
  prescribed: {
    exercises: [{ template_id: 11, rest_seconds: 10, rows_per_rest: 4, lead_in_seconds: 3 }],
    targets: [0, 1, 2, 3].map(r => (
      { template_id: 11, row_index: r, column_name: 'time', target_num: 45 }
    )),
  },
};

test('workChainFor: lead_in_seconds puts a lead-in before every work phase, none before rest', () => {
  assert.deepEqual(workChainFor({ ...HOLD, completedRows: 0 }), [
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'work', seconds: 45, row: 0 },
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'work', seconds: 45, row: 1 },
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'work', seconds: 45, row: 2 },
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'work', seconds: 45, row: 3 },
  ]);
  // With rests in the chain the rest runs on into the next work by itself
  // and its own T-3 beeps are the get-set (HANDOFF 2026-09-20): no lead-in
  // after a rest. The side switch inside a round (no rest) keeps its own.
  const prescribed = {
    ...HOLD.prescribed,
    exercises: [{ template_id: 11, rest_seconds: 10, rows_per_rest: 2, lead_in_seconds: 3 }],
  };
  assert.deepEqual(workChainFor({ template: HOLD.template, prescribed, completedRows: 0 }), [
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'work', seconds: 45, row: 0 },
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'work', seconds: 45, row: 1 },
    { kind: 'rest', seconds: 10 },
    { kind: 'work', seconds: 45, row: 2 },
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'work', seconds: 45, row: 3 },
  ]);
});

// HANDOFF 2026-09-13 (third ask): with a lead-in prescribed the whole
// exercise runs from one press, rests included — work, rest, get set, work …
// to the last row. Without a lead-in the rest still ends on a press.
test('workChainFor: lead_in_seconds makes the chain continuous through every rest', () => {
  const prescribed = {
    exercises: [{ template_id: 11, rest_seconds: 90, rows_per_rest: 1, lead_in_seconds: 3 }],
    targets: [0, 1, 2].map(r => (
      { template_id: 11, row_index: r, column_name: 'time', target_num: 45 }
    )),
  };
  // Only the press gets a lead-in (HANDOFF 2026-09-20): the rest countdown's
  // own T-3 beeps are the get-set for every set after it.
  const lead = { kind: 'lead_in', seconds: 3, label: 'get set' };
  assert.deepEqual(workChainFor({ template: HOLD.template, prescribed, completedRows: 0 }), [
    lead, { kind: 'work', seconds: 45, row: 0 }, { kind: 'rest', seconds: 90 },
    { kind: 'work', seconds: 45, row: 1 }, { kind: 'rest', seconds: 90 },
    { kind: 'work', seconds: 45, row: 2 },
  ]);
  // Resuming mid-exercise picks up from the next row on a fresh press, so
  // that first row gets the lead-in again; still continuous after it.
  assert.deepEqual(workChainFor({ template: HOLD.template, prescribed, completedRows: 1 }), [
    lead, { kind: 'work', seconds: 45, row: 1 }, { kind: 'rest', seconds: 90 },
    { kind: 'work', seconds: 45, row: 2 },
  ]);
  // An open-ended (max-hold) row inside the chain stays press-ended, then
  // the rest and the following rows carry on by themselves.
  const withMax = { ...prescribed, targets: prescribed.targets.filter(t => t.row_index !== 1) };
  assert.deepEqual(workChainFor({ template: HOLD.template, prescribed: withMax, completedRows: 0 }), [
    lead, { kind: 'work', seconds: 45, row: 0 }, { kind: 'rest', seconds: 90 },
    { kind: 'work', seconds: null, row: 1 }, { kind: 'rest', seconds: 90 },
    { kind: 'work', seconds: 45, row: 2 },
  ]);
  // No lead-in: unchanged, one group then a press-ended rest.
  const noLead = { ...prescribed, exercises: [{ template_id: 11, rest_seconds: 90, rows_per_rest: 1 }] };
  assert.deepEqual(workChainFor({ template: HOLD.template, prescribed: noLead, completedRows: 0 }), [
    { kind: 'work', seconds: 45, row: 0 }, { kind: 'rest', seconds: 90 },
  ]);
});

test('workChainFor: no lead-in without lead_in_seconds, or when it is invalid', () => {
  assert.deepEqual(workChainFor({ ...PLANK, completedRows: 0 }).map(p => p.kind), ['work', 'rest']);
  for (const bad of [0, -3, 1.5, '3', null]) {
    const prescribed = {
      ...HOLD.prescribed,
      exercises: [{ template_id: 11, rest_seconds: 10, rows_per_rest: 4, lead_in_seconds: bad }],
    };
    assert.deepEqual(
      workChainFor({ template: HOLD.template, prescribed, completedRows: 0 }).map(p => p.kind),
      ['work', 'work', 'work', 'work'],
      `lead_in_seconds ${JSON.stringify(bad)} must not add a lead-in`,
    );
  }
});

test('chain: lead-in runs itself into work, is never recorded, and a press skips it', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startChain(workChainFor({ ...HOLD, completedRows: 0 }));
  assert.deepEqual(sw.chainPhase(), { kind: 'lead_in', seconds: 3, elapsed: 0, remaining: 3, label: 'get set' });
  clock.advance(3_000);
  assert.deepEqual(sw.chainPhase(), { kind: 'work', row: 0, seconds: 45, elapsed: 0, remaining: 45 });
  clock.advance(45_000);
  assert.equal(sw.chainPhase().kind, 'lead_in', 'side switch gets its own lead-in');
  clock.advance(1_000);
  sw.advanceChain(); // pressed during the lead-in: straight to work
  assert.deepEqual(sw.chainPhase(), { kind: 'work', row: 1, seconds: 45, elapsed: 0, remaining: 45 });
  clock.advance(45_000 + 3_000 + 45_000 + 3_000 + 45_000);
  assert.equal(sw.chainPhase(), null, 'chain complete');
  assert.equal(sw.completedRows(), 4);
  assert.deepEqual(sw.takeCompletedWork(), [
    { row: 0, seconds: 45 }, { row: 1, seconds: 45 }, { row: 2, seconds: 45 }, { row: 3, seconds: 45 },
  ]);
});

test('intervalPhasesFor: lead_in_seconds prefixes one lead-in before the program', () => {
  const prescribed = {
    exercises: [{ template_id: 33, lead_in_seconds: 3, intervals: { work_seconds: 30, easy_seconds: 30, rounds: 1 } }],
  };
  assert.deepEqual(intervalPhasesFor(prescribed, 33), [
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'intense', seconds: 30, label: 'intense 1/1' },
    { kind: 'easy', seconds: 30, label: 'easy 1/1' },
  ]);
  assert.equal(intervalPhasesFor(INTERVALS, 33)[0].kind, 'warmup', 'no lead-in unless prescribed');
});

// ---- Rep rows inside a timed template (HANDOFF 2026-09-06, dip 138 s) ----
// Dip progression: row 0 is a 10-s support hold (time target), rows 1-3 are
// partial-rep sets prescribed by reps only. A row whose only numeric targets
// are on non-time columns is a rep set: the press means "set done", the rest
// counts down, and nothing is recorded into the time cell. Open-ended
// count-up stays reserved for rows with no numeric target at all (max holds).

const DIP = {
  template: { id: 31, columns: [{ name: 'time' }, { name: 'reps' }] },
  prescribed: {
    exercises: [{ template_id: 31, rest_seconds: 120 }],
    targets: [
      { template_id: 31, row_index: 0, column_name: 'time', target_num: 10 },
      ...[1, 2, 3].map(r => ({ template_id: 31, row_index: r, column_name: 'reps', target_num: 3 })),
    ],
  },
};

test('workChainFor: a reps-only row is an untimed set — no count-up, straight to rest', () => {
  assert.deepEqual(workChainFor({ ...DIP, completedRows: 0 }), [
    { kind: 'work', seconds: 10, row: 0 },
    { kind: 'rest', seconds: 120 },
  ]);
  assert.deepEqual(workChainFor({ ...DIP, completedRows: 1 }), [
    { kind: 'work', seconds: 0, row: 1, untimed: true },
    { kind: 'rest', seconds: 120 },
  ]);
  assert.deepEqual(workChainFor({ ...DIP, completedRows: 3 }), [
    { kind: 'work', seconds: 0, row: 3, untimed: true },
  ], 'last row: no rest to chain into');
  // No lead-in before an untimed set (nothing to get set for), one before a hold.
  const withLead = { ...DIP, prescribed: { ...DIP.prescribed,
    exercises: [{ template_id: 31, rest_seconds: 120, lead_in_seconds: 3 }] } };
  assert.deepEqual(workChainFor({ ...withLead, completedRows: 1 }).map(p => p.kind),
    ['work', 'rest', 'work', 'rest', 'work']);
  assert.deepEqual(workChainFor({ ...withLead, completedRows: 0 }).slice(0, 2).map(p => p.kind),
    ['lead_in', 'work']);
});

test('chain: an untimed set folds straight into its rest and records no time', () => {
  let t = 1_000_000;
  const sw = createStopwatch({ now: () => t });
  sw.start();
  sw.startChain(workChainFor({ ...DIP, completedRows: 1 }));
  const phase = sw.chainPhase();
  assert.equal(phase.kind, 'rest');
  assert.equal(phase.remaining, 120);
  assert.equal(sw.completedRows(), 1);
  assert.deepEqual(sw.takeCompletedWork(), []);
  t += 120_000;
  assert.equal(sw.chainPhase(), null);
  assert.equal(sw.chainCompleted(), true);
  assert.deepEqual(sw.takeCompletedWork(), []);
});

// ---- cardio lead-in (HANDOFF 2026-09-20): Zone 2 / Long Walk carry a
// lead-in alone — no rest (cardio never pipes one), no interval program —
// and their time targets are minutes. Press → get set → a countdown of the
// target read as minutes (open count-up without one). Nothing is recorded:
// the minutes cell stays a manual entry.

const WALK = {
  template: { id: 40, columns: [{ name: 'time' }, { name: 'hr' }] },
  prescribed: {
    exercises: [{ template_id: 40, lead_in_seconds: 3 }],
    targets: [{ template_id: 40, row_index: 0, column_name: 'time', target_num: 45 }],
  },
};

test('cardioPhasesFor: lead-in then a countdown of the time target in minutes', () => {
  assert.deepEqual(cardioPhasesFor(WALK), [
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'cardio', seconds: 2700, label: 'go' },
  ]);
  // No numeric time target: open count-up, press to end.
  const open = { ...WALK, prescribed: { ...WALK.prescribed, targets: [] } };
  assert.deepEqual(cardioPhasesFor(open), [
    { kind: 'lead_in', seconds: 3, label: 'get set' },
    { kind: 'cardio', seconds: null, label: 'go' },
  ]);
});

test('cardioPhasesFor: null without a lead-in, a time column, or alongside rest / intervals', () => {
  const withEntry = (entry) => ({ ...WALK, prescribed: { ...WALK.prescribed, exercises: [entry] } });
  assert.equal(cardioPhasesFor(withEntry({ template_id: 40 })), null, 'no lead-in');
  assert.equal(cardioPhasesFor(withEntry({ template_id: 40, lead_in_seconds: 0 })), null);
  assert.equal(cardioPhasesFor(withEntry({ template_id: 40, lead_in_seconds: 3, rest_seconds: 90 })), null, 'rest → work chain');
  assert.equal(cardioPhasesFor(withEntry({
    template_id: 40, lead_in_seconds: 3, intervals: { work_seconds: 60, easy_seconds: 120, rounds: 5 },
  })), null, 'intervals → interval program');
  assert.equal(cardioPhasesFor({ ...WALK, template: { id: 40, columns: [{ name: 'hr' }] } }), null, 'no time column');
  assert.equal(cardioPhasesFor({ template: WALK.template, prescribed: null }), null);
});

test('chain: a cardio program runs the lead-in into the countdown, records nothing, and a press ends it', () => {
  const clock = fakeClock();
  const sw = createStopwatch({ now: clock.now });
  sw.startChain(cardioPhasesFor(WALK));
  clock.advance(3_000);
  assert.deepEqual(sw.chainPhase(), { kind: 'cardio', seconds: 2700, elapsed: 0, remaining: 2700, label: 'go' });
  clock.advance(2_700_000);
  assert.equal(sw.chainPhase(), null);
  assert.equal(sw.chainCompleted(), true);
  assert.deepEqual(sw.takeCompletedWork(), []);
  assert.equal(sw.completedRows(), 0);

  const open = createStopwatch({ now: clock.now });
  open.startChain(cardioPhasesFor({ ...WALK, prescribed: { ...WALK.prescribed, targets: [] } }));
  clock.advance(3_000 + 600_000);
  assert.deepEqual(open.chainPhase(), { kind: 'cardio', seconds: null, elapsed: 600, remaining: null, label: 'go' });
  open.advanceChain();
  assert.equal(open.chainPhase(), null);
  assert.equal(open.chainCompleted(), true);
  assert.deepEqual(open.takeCompletedWork(), []);
});
