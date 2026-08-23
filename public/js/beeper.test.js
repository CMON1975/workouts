import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beepOffsets, chainBeepPlan } from './beeper.js';

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

// ---- Whole-chain beep plan (one gesture arms every phase boundary) ----

test('chainBeepPlan beeps every known phase boundary of a carry chain', () => {
  const phases = [
    { kind: 'work', seconds: 30, row: 0 },
    { kind: 'work', seconds: 30, row: 1 },
    { kind: 'rest', seconds: 90 },
  ];
  const plan = chainBeepPlan(phases, 0);
  const dones = plan.filter(b => b.kind === 'done').map(b => b.atMs);
  const shorts = plan.filter(b => b.kind === 'short').map(b => b.atMs);
  assert.deepEqual(dones, [30_000, 60_000, 150_000]);
  assert.deepEqual(shorts, [
    27_000, 28_000, 29_000,
    57_000, 58_000, 59_000,
    147_000, 148_000, 149_000,
  ]);
  const sorted = [...plan].sort((a, b) => a.atMs - b.atMs);
  assert.deepEqual(plan, sorted, 'offsets come out schedule-ready');
});

test('chainBeepPlan drops offsets already in the past mid-chain', () => {
  const phases = [
    { kind: 'work', seconds: 30, row: 0 },
    { kind: 'rest', seconds: 60 },
  ];
  const plan = chainBeepPlan(phases, 28_500);
  assert.deepEqual(plan.map(b => [b.atMs, b.kind]), [
    [500, 'short'],
    [1_500, 'done'],
    [58_500, 'short'], [59_500, 'short'], [60_500, 'short'],
    [61_500, 'done'],
  ]);
});

test('chainBeepPlan stops at an open-ended phase — boundaries beyond it are unknowable', () => {
  assert.deepEqual(chainBeepPlan([
    { kind: 'work', seconds: null, row: 0 },
    { kind: 'rest', seconds: 60 },
  ], 0), []);
  const plan = chainBeepPlan([
    { kind: 'work', seconds: 45, row: 0 },
    { kind: 'work', seconds: null, row: 1 },
    { kind: 'rest', seconds: 60 },
  ], 0);
  assert.deepEqual(plan.filter(b => b.kind === 'done').map(b => b.atMs), [45_000],
    'only the first boundary is schedulable');
});

test('chainBeepPlan on garbage input yields no beeps', () => {
  assert.deepEqual(chainBeepPlan(null, 0), []);
  assert.deepEqual(chainBeepPlan([], 0), []);
});
