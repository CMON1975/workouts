// Pure stopwatch core for routine runs. Zero DOM; app.js owns the rendering.
//
// All timing derives from absolute epoch timestamps compared against now() —
// nothing ticks or accumulates, so state survives iPhone tab freeze/eviction:
// restore the serialized epochs and the elapsed time is still correct, away
// time included (it is a wall-clock stopwatch).
//
// State: startEpoch anchors the exercise total, lapEpoch anchors the visible
// lap-relative display (Lap only moves lapEpoch). Both null = idle.
// restEpoch anchors an active rest countdown (null = none); a countdown whose
// prescribed rest has fully elapsed reads as inactive again, so the display
// snaps back to the full rest duration.
// chainCompleted distinguishes "the program ran to its end" from "never
// started" once the chain is gone — an interval program shows done, not
// re-armed, after its cooldown (and after a reload past that point).
// exerciseIndex guards against restoring a running timer that belonged to an
// already-finalized exercise (crash between finalize success and commit).

const STATE_VERSION = 4;

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
  let restEpoch = initial?.restEpoch ?? null;
  // Chained work/rest cycle for timed holds/carries: { epoch, phases } where
  // phases = [{kind:'work', seconds|null, row}, ..., {kind:'rest', seconds}].
  // Like everything else it is epoch-anchored — sync() folds phases that have
  // fully elapsed (frozen-tab safe: auto-transitions need no ticks).
  let chain = initial?.chain ?? null;
  let completedWork = Array.isArray(initial?.completedWork) ? [...initial.completedWork] : [];
  let completedRowsCount = initial?.completedRowsCount ?? 0;
  let chainCompleted = initial?.chainCompleted === true;

  const elapsedFrom = (epoch) => Math.max(0, Math.floor((now() - epoch) / 1000));

  function sync() {
    while (chain) {
      const p = chain.phases[0];
      if (p == null) { chain = null; break; }
      if (typeof p.seconds !== 'number') break; // open-ended: press advances it
      const phaseEnd = chain.epoch + p.seconds * 1000;
      if (now() < phaseEnd) break;
      if (p.kind === 'work') {
        completedWork.push({ row: p.row, seconds: p.seconds });
        completedRowsCount += 1;
      }
      if (chain.phases.length > 1) {
        chain = { epoch: phaseEnd, phases: chain.phases.slice(1) };
      } else {
        chain = null;
        chainCompleted = true;
      }
    }
  }

  function start() {
    if (startEpoch != null) return;
    startEpoch = now();
    lapEpoch = startEpoch;
  }

  function lap() {
    if (startEpoch == null) return;
    lapEpoch = now();
  }

  function startRest() {
    if (startEpoch == null) return;
    restEpoch = now();
  }

  function isRunning() { return startEpoch != null; }
  function exerciseSeconds() { return startEpoch == null ? null : elapsedFrom(startEpoch); }
  function displaySeconds() { return lapEpoch == null ? 0 : elapsedFrom(lapEpoch); }

  function restRemaining(restSeconds) {
    if (restEpoch == null || restSeconds == null || restSeconds <= 0) return null;
    const elapsed = elapsedFrom(restEpoch);
    return elapsed >= restSeconds ? null : restSeconds - elapsed;
  }

  function restRemainingMs(restSeconds) {
    if (restEpoch == null || restSeconds == null || restSeconds <= 0) return null;
    const ms = restEpoch + restSeconds * 1000 - now();
    return ms > 0 ? ms : null;
  }

  function startChain(phases) {
    if (!Array.isArray(phases) || phases.length === 0) return;
    if (startEpoch == null) {
      startEpoch = now();
      lapEpoch = startEpoch;
    }
    restEpoch = null;
    chainCompleted = false;
    chain = { epoch: now(), phases: phases.map(p => ({ ...p })) };
  }

  function chainPhase() {
    sync();
    if (!chain) return null;
    const p = chain.phases[0];
    const elapsed = elapsedFrom(chain.epoch);
    const out = {
      kind: p.kind,
      seconds: p.seconds ?? null,
      elapsed,
      remaining: typeof p.seconds === 'number' ? p.seconds - elapsed : null,
    };
    if (p.kind === 'work') out.row = p.row;
    if (p.label != null) out.label = p.label;
    return out;
  }

  // Press during a chain: work ends early (actual elapsed recorded), rest is
  // cut short (chain done — the caller starts the next cycle's chain). Interval
  // phases (warmup/intense/easy/cooldown) skip straight to the next one.
  function advanceChain() {
    sync();
    if (!chain) return;
    const p = chain.phases[0];
    if (p.kind === 'work') {
      completedWork.push({ row: p.row, seconds: elapsedFrom(chain.epoch) });
      completedRowsCount += 1;
    }
    if (p.kind !== 'rest' && chain.phases.length > 1) {
      chain = { epoch: now(), phases: chain.phases.slice(1) };
    } else {
      chain = null;
      chainCompleted = true;
    }
  }

  function chainCompleted_() { sync(); return chainCompleted; }

  // Current phases + elapsed, for (re)scheduling the beep plan on wake.
  function chainSnapshot() {
    sync();
    if (!chain) return null;
    return {
      phases: chain.phases.map(p => ({ ...p })),
      elapsedMs: Math.max(0, now() - chain.epoch),
    };
  }

  function completedRows() { sync(); return completedRowsCount; }

  function takeCompletedWork() {
    sync();
    const out = completedWork;
    completedWork = [];
    return out;
  }

  function commitExercise() {
    startEpoch = null;
    lapEpoch = null;
    restEpoch = null;
    chain = null;
    chainCompleted = false;
    completedWork = [];
    completedRowsCount = 0;
  }

  function setExerciseIndex(i) { idx = i; }

  function toJSON() {
    sync();
    return {
      v: STATE_VERSION, exerciseIndex: idx, startEpoch, lapEpoch, restEpoch,
      chain, completedWork, completedRowsCount, chainCompleted,
    };
  }

  return {
    start, lap, startRest, isRunning, exerciseSeconds, displaySeconds,
    restRemaining, restRemainingMs, commitExercise, setExerciseIndex, toJSON,
    startChain, chainPhase, advanceChain, chainSnapshot, completedRows, takeCompletedWork,
    chainCompleted: chainCompleted_,
  };
}

const isTimeColumn = (name) => typeof name === 'string' && name.trim().toLowerCase() === 'time';

// Derive the chain (work phases then one rest) the next press should start.
// Chain mode is active only when the template records time (a column named
// "time", matched like the weight autofill) AND a rest is prescribed —
// rep lifts have rest but no time column and keep the plain press-for-rest
// behavior. Work durations come from numeric time-column targets, read as
// seconds; a row without one counts up until pressed. rows_per_rest chains
// that many rows before the rest (suitcase carry L/R = 2; default 1). The
// rest only follows when a prescribed row is left to chain into — after the
// final row the exercise just ends (no dead rest time); beyond the
// prescription nothing is known to be final, so open-ended sets keep it.
export function workChainFor({ prescribed, template, completedRows = 0 }) {
  if (!template?.columns?.some(c => isTimeColumn(c?.name))) return null;
  const entry = prescribed?.exercises?.find(e => e.template_id === template.id);
  const rest = entry?.rest_seconds;
  if (!Number.isInteger(rest) || rest <= 0) return null;
  const rpr = Number.isInteger(entry.rows_per_rest) && entry.rows_per_rest >= 1
    ? entry.rows_per_rest : 1;

  const rowSeconds = new Map();
  let maxRow = -1;
  for (const t of prescribed?.targets ?? []) {
    if (t.template_id !== template.id) continue;
    if (t.row_index > maxRow) maxRow = t.row_index;
    if (isTimeColumn(t.column_name) && typeof t.target_num === 'number' && t.target_num > 0) {
      rowSeconds.set(t.row_index, Math.round(t.target_num));
    }
  }

  const phases = [];
  const rowCount = maxRow + 1;
  if (completedRows >= rowCount) {
    // Beyond the prescription (or none): open-ended work, press to end it.
    phases.push({ kind: 'work', seconds: null, row: completedRows });
    phases.push({ kind: 'rest', seconds: rest });
    return phases;
  }
  const end = Math.min(completedRows + rpr, rowCount);
  for (let r = completedRows; r < end; r++) {
    phases.push({ kind: 'work', seconds: rowSeconds.get(r) ?? null, row: r });
  }
  if (end < rowCount) phases.push({ kind: 'rest', seconds: rest });
  return phases;
}

// Interval program phases for one template, from the prescription's
// `intervals` object: warmup (if any), then (intense, easy) x rounds, then the
// cooldown — split into equal steps when cooldown_step_seconds is shorter
// than the cooldown, so each treadmill speed drop gets its own countdown and
// beep. Every phase is timed, so the chain runs itself end to end from one
// press. Labels are what the bar shows under the readout. Null = not an
// interval exercise (or an unusable program).
export function intervalPhasesFor(prescribed, templateId) {
  const cfg = prescribed?.exercises?.find(e => e.template_id === templateId)?.intervals;
  if (cfg == null || typeof cfg !== 'object') return null;
  const secs = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
  const work = secs(cfg.work_seconds);
  const easy = secs(cfg.easy_seconds);
  const rounds = secs(cfg.rounds);
  if (work === 0 || rounds === 0) return null;

  const phases = [];
  const warmup = secs(cfg.warmup_seconds);
  if (warmup > 0) phases.push({ kind: 'warmup', seconds: warmup, label: 'warmup' });
  for (let r = 1; r <= rounds; r++) {
    phases.push({ kind: 'intense', seconds: work, label: `intense ${r}/${rounds}` });
    if (easy > 0) phases.push({ kind: 'easy', seconds: easy, label: `easy ${r}/${rounds}` });
  }
  const cooldown = secs(cfg.cooldown_seconds);
  const step = secs(cfg.cooldown_step_seconds);
  if (cooldown > 0 && step > 0 && step < cooldown) {
    const n = Math.ceil(cooldown / step);
    for (let i = 1, left = cooldown; i <= n; i++, left -= step) {
      phases.push({ kind: 'cooldown', seconds: Math.min(step, left), label: `cooldown ${i}/${n}` });
    }
  } else if (cooldown > 0) {
    phases.push({ kind: 'cooldown', seconds: cooldown, label: 'cooldown' });
  }
  return phases;
}

// Prescribed rest for one template, from the cached /api/prescriptions/active
// payload. Null-safe against a missing prescription, a stale cached shape
// without `exercises`, and non-positive/non-integer values — null means
// "no rest prescribed", which falls back to count-up Start/Lap.
export function restSecondsFor(prescribed, templateId) {
  const r = prescribed?.exercises?.find(e => e.template_id === templateId)?.rest_seconds;
  return Number.isInteger(r) && r > 0 ? r : null;
}

function storageKey(workoutId) { return 'stopwatch:' + workoutId; }

export function loadStopwatchState(workoutId, exerciseIndex, storage = globalThis.localStorage) {
  let raw;
  try { raw = storage.getItem(storageKey(workoutId)); } catch (_) { return null; }
  if (!raw) return null;
  let state;
  try { state = JSON.parse(raw); } catch (_) { return null; }
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
  if (state.v === 1) {
    // v1 predates rest countdowns; upgrade so a deploy mid-workout keeps the
    // running exercise timer.
    state = { ...state, v: 2, restEpoch: null };
  }
  if (state.v === 2) {
    // v2 predates chained work/rest cycles.
    state = { ...state, v: 3, chain: null, completedWork: [], completedRowsCount: 0 };
  }
  if (state.v === 3) {
    // v3 predates the completed flag (interval programs).
    state = { ...state, v: STATE_VERSION, chainCompleted: false };
  }
  if (state.v !== STATE_VERSION || typeof state.exerciseIndex !== 'number') return null;
  if (state.exerciseIndex !== exerciseIndex) {
    // A stored running timer for a different exercise means we crashed after
    // its finalize landed; its duration is already on the server. Idle out.
    return {
      v: STATE_VERSION, exerciseIndex, startEpoch: null, lapEpoch: null, restEpoch: null,
      chain: null, completedWork: [], completedRowsCount: 0, chainCompleted: false,
    };
  }
  return state;
}

export function saveStopwatchState(workoutId, sw, storage = globalThis.localStorage) {
  try { storage.setItem(storageKey(workoutId), JSON.stringify(sw.toJSON())); } catch (_) {}
}

export function clearStopwatchState(workoutId, storage = globalThis.localStorage) {
  try { storage.removeItem(storageKey(workoutId)); } catch (_) {}
}
