import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMSS, createStopwatch, restSecondsFor,
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
  assert.deepEqual(workChainFor({ ...PLANK, completedRows: 2 }), [
    { kind: 'work', seconds: 40, row: 2 },
    { kind: 'rest', seconds: 60 },
  ]);
});

test('workChainFor: rows_per_rest chains two carry sides before one rest', () => {
  assert.deepEqual(workChainFor({ ...CARRY, completedRows: 0 }), [
    { kind: 'work', seconds: 30, row: 0 },
    { kind: 'work', seconds: 30, row: 1 },
    { kind: 'rest', seconds: 90 },
  ]);
  assert.deepEqual(workChainFor({ ...CARRY, completedRows: 2 }), [
    { kind: 'work', seconds: 30, row: 2 },
    { kind: 'work', seconds: 30, row: 3 },
    { kind: 'rest', seconds: 90 },
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
