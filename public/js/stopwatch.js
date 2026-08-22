// Pure stopwatch core for routine runs. Zero DOM; app.js owns the rendering.
//
// All timing derives from absolute epoch timestamps compared against now() —
// nothing ticks or accumulates, so state survives iPhone tab freeze/eviction:
// restore the serialized epochs and the elapsed time is still correct, away
// time included (it is a wall-clock stopwatch).
//
// State: startEpoch anchors the exercise total, lapEpoch anchors the visible
// lap-relative display (Lap only moves lapEpoch). Both null = idle.
// exerciseIndex guards against restoring a running timer that belonged to an
// already-finalized exercise (crash between finalize success and commit).

const STATE_VERSION = 1;

export function formatMSS(seconds) {
  if (seconds == null || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function createStopwatch({ now = Date.now, exerciseIndex = 0, initial = null } = {}) {
  let idx = initial?.exerciseIndex ?? exerciseIndex;
  let startEpoch = initial?.startEpoch ?? null;
  let lapEpoch = initial?.lapEpoch ?? null;

  const elapsedFrom = (epoch) => Math.max(0, Math.floor((now() - epoch) / 1000));

  function start() {
    if (startEpoch != null) return;
    startEpoch = now();
    lapEpoch = startEpoch;
  }

  function lap() {
    if (startEpoch == null) return;
    lapEpoch = now();
  }

  function isRunning() { return startEpoch != null; }
  function exerciseSeconds() { return startEpoch == null ? null : elapsedFrom(startEpoch); }
  function displaySeconds() { return lapEpoch == null ? 0 : elapsedFrom(lapEpoch); }

  function commitExercise() {
    startEpoch = null;
    lapEpoch = null;
  }

  function setExerciseIndex(i) { idx = i; }

  function toJSON() {
    return { v: STATE_VERSION, exerciseIndex: idx, startEpoch, lapEpoch };
  }

  return { start, lap, isRunning, exerciseSeconds, displaySeconds, commitExercise, setExerciseIndex, toJSON };
}

function storageKey(workoutId) { return 'stopwatch:' + workoutId; }

export function loadStopwatchState(workoutId, exerciseIndex, storage = globalThis.localStorage) {
  let raw;
  try { raw = storage.getItem(storageKey(workoutId)); } catch (_) { return null; }
  if (!raw) return null;
  let state;
  try { state = JSON.parse(raw); } catch (_) { return null; }
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
  if (state.v !== STATE_VERSION || typeof state.exerciseIndex !== 'number') return null;
  if (state.exerciseIndex !== exerciseIndex) {
    // A stored running timer for a different exercise means we crashed after
    // its finalize landed; its duration is already on the server. Idle out.
    return { v: STATE_VERSION, exerciseIndex, startEpoch: null, lapEpoch: null };
  }
  return state;
}

export function saveStopwatchState(workoutId, sw, storage = globalThis.localStorage) {
  try { storage.setItem(storageKey(workoutId), JSON.stringify(sw.toJSON())); } catch (_) {}
}

export function clearStopwatchState(workoutId, storage = globalThis.localStorage) {
  try { storage.removeItem(storageKey(workoutId)); } catch (_) {}
}
