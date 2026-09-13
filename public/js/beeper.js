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
    if (typeof p?.seconds !== 'number' || p.seconds <= 0) break;
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
// and the context is replaced (iOS can leave an 'interrupted' context stuck).
export const RECREATE_AFTER_MS = 1500;

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
// every return to 'running', whenever that turns out to be; a resume that
// does not take within RECREATE_AFTER_MS gets a fresh context instead.
export function createBeeper({ now = Date.now, setTimeout = globalThis.setTimeout } = {}) {
  let ctx = null;
  let pending = [];
  let plan = null;        // { at: wall ms, offsets } — the beeps still wanted
  let wasRunning = false; // last observed ctx state, for edge detection
  let recreateTimer = null;

  function AC() { return globalThis.AudioContext || globalThis.webkitAudioContext; }

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
  // between, so everything scheduled before it is stale.
  function noteState() {
    const running = ctx?.state === 'running';
    if (running && !wasRunning) arm();
    wasRunning = running;
  }

  function attach(c) {
    ctx = c;
    wasRunning = false;
    try { c.onstatechange = noteState; } catch (_) {}
  }

  function resume() {
    if (!ctx || ctx.state === 'running') return;
    try {
      const p = ctx.resume();
      if (p?.then) p.then(noteState, () => {});
    } catch (_) {}
  }

  function recreate() {
    const old = ctx;
    try { old?.close?.(); } catch (_) {}
    try {
      attach(new (AC())());
      resume();
      noteState();
    } catch (_) {
      ctx = null;
    }
  }

  // Must run synchronously in a user-gesture handler (iOS unlock). Called on
  // every press so the context is warm one gesture before the first countdown.
  function ensureContext() {
    try {
      if (!AC()) return;
      if (!ctx) attach(new (AC())());
      if (ctx.state !== 'running') {
        resume();
        if (recreateTimer == null) {
          recreateTimer = setTimeout(() => {
            recreateTimer = null;
            if (ctx && ctx.state !== 'running') recreate();
          }, RECREATE_AFTER_MS);
        }
      }
      noteState();
    } catch (_) {
      ctx = null;
    }
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

  return { ensureContext, schedule, cancel, isArmed };
}
