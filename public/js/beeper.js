// Rest-countdown beeps. The planner is pure and tested; the Web Audio
// wrapper is a thin untestable shell around it (added with the UI wiring).
//
// Offsets are relative to "now" and computed from the *remaining* time, not
// the full rest duration, so the same planner serves both a fresh press and
// a wake-time reschedule after the tab was hidden mid-countdown.

// Plan the beeps for a countdown with remainingMs left: a short beep at each
// of the last three whole seconds (only when strictly in the future — a 3s
// rest must not beep at the press instant) and a distinct done tone at zero.
export function beepOffsets(remainingMs) {
  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs) || remainingMs <= 0) {
    return [];
  }
  const plan = [];
  for (const back of [3000, 2000, 1000]) {
    const atMs = remainingMs - back;
    if (atMs > 0) plan.push({ atMs, kind: 'short' });
  }
  plan.push({ atMs: remainingMs, kind: 'done' });
  return plan;
}

// Plan the beeps for a whole work/rest chain from its phase list: every phase
// boundary gets the T-3..T-1 shorts plus the done tone (the same language
// everywhere — before a carry hand-switch they prime the exchange, before the
// rest end they prime the next set). elapsedMs shifts the plan for a wake-time
// reschedule mid-chain; already-past offsets drop out. Planning stops at an
// open-ended (null seconds) phase — boundaries beyond it are unknowable until
// the press that ends it, which reschedules.
export function chainBeepPlan(phases, elapsedMs = 0) {
  if (!Array.isArray(phases)) return [];
  const plan = [];
  let cumMs = 0;
  for (const p of phases) {
    if (typeof p?.seconds !== 'number' || p.seconds < 0) break; // 0 = untimed set, passes through
    cumMs += p.seconds * 1000;
    plan.push(...beepOffsets(cumMs - elapsedMs));
  }
  return plan;
}

// Tone shapes, tuned on-device: short marks at T-3..T-1, a longer higher
// done tone at zero so the end is unambiguous without looking.
const TONES = {
  short: { freq: 880, durMs: 120, gain: 0.25 },
  done: { freq: 1318, durMs: 450, gain: 0.3 },
};

// A resume that has not taken effect after this long is treated as refused
// and the next gesture replaces the context (iOS can leave an 'interrupted'
// context stuck). Never from a timer: a context made outside a gesture stays
// locked until the next one.
export const RECREATE_AFTER_MS = 1500;

// While beeps are still owed and the context is not running, the resume is
// retried this often. Siri takes the audio session with the page still
// visible, so no wake fires, and a chain gets no press until the next
// exercise.
export const RESUME_RETRY_MS = 1000;

// Thin Web Audio shell around beepOffsets. Beeps are scheduled on the audio
// clock at press time — the app's 250ms display tick is cosmetic and dies
// when the tab freezes, so it can never be the trigger. Everything degrades
// to silence (no throw into the press path) when audio is unavailable;
// hidden-tab / locked-screen playback is best-effort by platform design.
//
// Surviving iOS interruptions: the audio clock freezes while the context is
// interrupted (screen lock, app switch), so anything scheduled before the
// freeze plays late by the away time — or never, if WebKit refuses the
// resume. The last plan is kept anchored to the wall clock and re-armed on
// every return to 'running', whenever that turns out to be. WebKit can also
// hand a context back from the background locked, or silent while it reports
// 'running', and a reload does not clear that; so the first gesture after the
// page was hidden, or after a resume refused for RECREATE_AFTER_MS, replaces
// the context with one made inside that gesture.
export function createBeeper({ now = Date.now, setTimeout = globalThis.setTimeout } = {}) {
  let ctx = null;
  let pending = [];
  let plan = null;        // { at: wall ms, offsets } — the beeps still wanted
  let wasRunning = false; // last observed ctx state, for edge detection
  let resumeAskedAt = null; // wall ms of the first resume() not yet taken
  let stale = false;      // the page was hidden since ctx was made
  let retryTimer = null;

  function AC() { return globalThis.AudioContext || globalThis.webkitAudioContext; }

  // True while the plan still has a beep in the future.
  function owed() {
    if (!plan) return false;
    const elapsed = now() - plan.at;
    return plan.offsets.some(({ atMs }) => atMs > elapsed);
  }

  // Keep resuming a non-running context while beeps are owed. Never
  // recreate from here: a context made outside a gesture stays locked until
  // the next gesture, and the one held now was unlocked by an earlier one.
  function retryResume() {
    if (retryTimer != null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!ctx || ctx.state === 'running' || !owed()) return;
      resume();
      retryResume();
    }, RESUME_RETRY_MS);
  }

  function stopPending() {
    for (const osc of pending) {
      try { osc.stop(); osc.disconnect(); } catch (_) {}
    }
    pending = [];
  }

  // Put the plan's still-future beeps on the audio clock as it stands now.
  function arm() {
    stopPending();
    if (!ctx || !plan) return;
    const elapsed = now() - plan.at;
    try {
      const base = ctx.currentTime;
      for (const { atMs, kind } of plan.offsets) {
        const rel = atMs - elapsed;
        if (rel <= 0) continue;
        const { freq, durMs, gain } = TONES[kind];
        const at = base + rel / 1000;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.frequency.value = freq;
        env.gain.setValueAtTime(gain, at);
        env.gain.exponentialRampToValueAtTime(0.001, at + durMs / 1000);
        osc.connect(env).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + durMs / 1000);
        pending.push(osc);
      }
    } catch (_) {
      stopPending();
    }
  }

  // Re-arm on the not-running → running edge: the clock was frozen in
  // between, so everything scheduled before it is stale. Off that edge,
  // keep trying to get back to it while beeps are owed.
  function noteState() {
    const running = ctx?.state === 'running';
    if (running) resumeAskedAt = null;
    if (running && !wasRunning) arm();
    else if (!running && owed()) retryResume();
    wasRunning = running;
  }

  function attach(c) {
    ctx = c;
    wasRunning = false;
    resumeAskedAt = null;
    stale = false;
    try { c.onstatechange = noteState; } catch (_) {}
  }

  function resume() {
    if (!ctx || ctx.state === 'running') return;
    resumeAskedAt ??= now();
    try {
      const p = ctx.resume();
      if (p?.then) p.then(noteState, () => {});
    } catch (_) {}
  }

  function refused() {
    return resumeAskedAt != null && now() - resumeAskedAt >= RECREATE_AFTER_MS;
  }

  function replace() {
    const old = ctx;
    try { old.onstatechange = null; old.close?.(); } catch (_) {}
    attach(new (AC())());
  }

  // Must run synchronously in a user-gesture handler (iOS unlock): every
  // press, and any tap in a run, so the context is warm one gesture before
  // the first countdown and a locked one is swapped where that can work.
  function ensureContext() {
    try {
      if (!AC()) return;
      if (!ctx) attach(new (AC())());
      else if (stale || refused()) replace();
      resume();
      noteState();
    } catch (_) {
      ctx = null;
    }
  }

  // The page is back (tab wake, no gesture). Once a gesture has unlocked a
  // context WebKit allows resuming it from here, which a chain needs: it gets
  // no press until the next exercise. The replacement waits for a gesture.
  function wake() {
    if (!ctx) return;
    stale = true;
    resume();
    noteState();
  }

  function cancel() {
    plan = null;
    stopPending();
  }

  function schedule(offsets) {
    plan = offsets?.length ? { at: now(), offsets } : null;
    arm();
  }

  function isArmed() { return ctx != null; }

  return { ensureContext, wake, schedule, cancel, isArmed };
}
