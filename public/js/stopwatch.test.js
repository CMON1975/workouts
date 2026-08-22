import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMSS, createStopwatch,
  loadStopwatchState, saveStopwatchState, clearStopwatchState,
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
