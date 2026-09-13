import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beepOffsets, chainBeepPlan, createBeeper, RECREATE_AFTER_MS } from './beeper.js';

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

// ---- ensureContext vs. the AudioContext lifecycle ----
//
// The Web Audio nodes stay untested, but the state machine around resume()
// is drivable with a fake AudioContext class — and it is where the field bug
// lived: iOS flips a running context to the non-standard 'interrupted' state
// on screen lock / app switch and never leaves it on its own.

function installFakeAudioContext(t, { resumeWorks = true } = {}) {
  const instances = [];
  class FakeAudioContext {
    constructor() {
      this.state = 'suspended'; // fresh contexts start suspended on iOS
      this.resumeCalls = 0;
      this.closed = false;
      this.currentTime = 0;
      this.onstatechange = null;
      this.starts = []; // audio-clock times oscillators were started at
      this.destination = {};
      instances.push(this);
    }
    resume() {
      this.resumeCalls += 1;
      if (resumeWorks) this.state = 'running';
      return Promise.resolve();
    }
    close() { this.closed = true; return Promise.resolve(); }
    // What iOS does on lock / app switch and on coming back.
    setState(state) { this.state = state; this.onstatechange?.(); }
    createOscillator() {
      const ctx = this;
      const osc = {
        frequency: { value: 0 },
        connect(n) { return n; },
        disconnect() {},
        start(at) { ctx.starts.push(at); osc.startedAt = at; },
        stop() { osc.stopped = true; },
      };
      return osc;
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect(n) { return n; },
      };
    }
  }
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  globalThis.AudioContext = FakeAudioContext;
  t.after(() => {
    if (prev) Object.defineProperty(globalThis, 'AudioContext', prev);
    else delete globalThis.AudioContext;
  });
  return instances;
}

test('ensureContext creates one context and resumes it out of suspended', (t) => {
  const instances = installFakeAudioContext(t);
  const beeper = createBeeper();
  assert.equal(beeper.isArmed(), false);
  beeper.ensureContext();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].state, 'running');
  assert.equal(beeper.isArmed(), true);
  beeper.ensureContext();
  assert.equal(instances.length, 1, 'later presses reuse the same context');
});

test('ensureContext does not redundantly resume a running context', (t) => {
  const instances = installFakeAudioContext(t);
  const beeper = createBeeper();
  beeper.ensureContext();
  const calls = instances[0].resumeCalls;
  beeper.ensureContext();
  assert.equal(instances[0].resumeCalls, calls);
});

test("ensureContext resumes a context iOS left in 'interrupted'", (t) => {
  const instances = installFakeAudioContext(t);
  const beeper = createBeeper();
  beeper.ensureContext(); // first press: created + resumed
  const ctx = instances[0];
  ctx.state = 'interrupted'; // screen locked between sets
  const calls = ctx.resumeCalls;
  beeper.ensureContext(); // next press must bring the audio back
  assert.equal(ctx.resumeCalls, calls + 1,
    'an interrupted context must be resumed, not just a suspended one');
});

test('chainBeepPlan: a 3-s lead-in yields two shorts and a go tone, then the work boundary', () => {
  const plan = chainBeepPlan([
    { kind: 'lead_in', seconds: 3 },
    { kind: 'work', seconds: 45, row: 0 },
  ], 0);
  assert.deepEqual(plan, [
    { atMs: 1000, kind: 'short' }, { atMs: 2000, kind: 'short' }, { atMs: 3000, kind: 'done' },
    { atMs: 45_000, kind: 'short' }, { atMs: 46_000, kind: 'short' }, { atMs: 47_000, kind: 'short' },
    { atMs: 48_000, kind: 'done' },
  ]);
});

// ---- Surviving iOS audio interruptions (HANDOFF 2026-09-13 beeps) ----
// The audio clock freezes while the context is interrupted, so anything
// scheduled before the freeze plays late by the away time — or never, when
// WebKit refuses the resume. The plan is kept wall-clock-anchored and
// re-armed on every return to 'running'; a resume that does not take gets
// a fresh context.

function clock(start = 100_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('schedule starts oscillators on the audio clock at base + offset', (t) => {
  const instances = installFakeAudioContext(t);
  const beeper = createBeeper();
  beeper.ensureContext();
  instances[0].currentTime = 10;
  beeper.schedule([{ atMs: 1000, kind: 'short' }, { atMs: 4000, kind: 'done' }]);
  assert.deepEqual(instances[0].starts, [11, 14]);
});

test('a context that comes back to running re-arms the plan shifted by the wall time away', (t) => {
  const instances = installFakeAudioContext(t);
  const c = clock();
  const beeper = createBeeper({ now: c.now });
  beeper.ensureContext();
  const ctx = instances[0];
  beeper.schedule([{ atMs: 5000, kind: 'short' }, { atMs: 8000, kind: 'done' }, { atMs: 20_000, kind: 'done' }]);
  ctx.starts = [];
  ctx.setState('interrupted');   // screen lock: audio clock stops at 0
  c.advance(9000);               // wall clock keeps going
  ctx.currentTime = 0.5;         // WebKit resumes the clock roughly where it froze
  ctx.setState('running');
  // 5 s and 8 s beeps are in the past; the 20 s one is now 11 s out.
  assert.deepEqual(ctx.starts, [11.5]);
});

test('ensureContext recreates the context when a resume does not take within the grace period', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instances = installFakeAudioContext(t, { resumeWorks: false });
  const c = clock();
  const beeper = createBeeper({ now: c.now });
  beeper.ensureContext();
  const first = instances[0];
  first.state = 'running';       // the gesture-backed first start worked
  beeper.schedule([{ atMs: 30_000, kind: 'done' }]);
  first.setState('interrupted'); // app switch
  c.advance(10_000);
  beeper.ensureContext();        // wake: resume() is refused, state stays interrupted
  assert.equal(instances.length, 1);
  t.mock.timers.tick(RECREATE_AFTER_MS);
  assert.equal(instances.length, 2, 'a fresh context replaces the stuck one');
  assert.equal(first.closed, true);
  const second = instances[1];
  second.setState('running');
  assert.deepEqual(second.starts, [20], 'the plan is re-armed on the new context, shifted by the away time');
  assert.equal(beeper.isArmed(), true);
});

test('ensureContext on a running context starts no recreate timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instances = installFakeAudioContext(t);
  const beeper = createBeeper();
  beeper.ensureContext();
  beeper.ensureContext();
  t.mock.timers.tick(RECREATE_AFTER_MS * 2);
  assert.equal(instances.length, 1);
});

test('cancel forgets the plan so a later return to running plays nothing', (t) => {
  const instances = installFakeAudioContext(t);
  const beeper = createBeeper();
  beeper.ensureContext();
  const ctx = instances[0];
  beeper.schedule([{ atMs: 5000, kind: 'done' }]);
  beeper.cancel();
  ctx.starts = [];
  ctx.setState('interrupted');
  ctx.setState('running');
  assert.deepEqual(ctx.starts, []);
});
