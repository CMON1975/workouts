import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beepOffsets } from './beeper.js';

test('beepOffsets plans three shorts and a done tone', () => {
  assert.deepEqual(beepOffsets(90_000), [
    { atMs: 87_000, kind: 'short' },
    { atMs: 88_000, kind: 'short' },
    { atMs: 89_000, kind: 'short' },
    { atMs: 90_000, kind: 'done' },
  ]);
});

test('beepOffsets drops shorts that are not strictly in the future', () => {
  // A 3s countdown must not beep at the press instant itself.
  assert.deepEqual(beepOffsets(3_000), [
    { atMs: 1_000, kind: 'short' },
    { atMs: 2_000, kind: 'short' },
    { atMs: 3_000, kind: 'done' },
  ]);
  assert.deepEqual(beepOffsets(2_000), [
    { atMs: 1_000, kind: 'short' },
    { atMs: 2_000, kind: 'done' },
  ]);
  assert.deepEqual(beepOffsets(1_000), [{ atMs: 1_000, kind: 'done' }]);
  assert.deepEqual(beepOffsets(500), [{ atMs: 500, kind: 'done' }]);
});

test('beepOffsets is empty for expired or invalid input', () => {
  assert.deepEqual(beepOffsets(0), []);
  assert.deepEqual(beepOffsets(-100), []);
  assert.deepEqual(beepOffsets(null), []);
  assert.deepEqual(beepOffsets(undefined), []);
  assert.deepEqual(beepOffsets(NaN), []);
});
