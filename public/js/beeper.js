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

// Tone shapes, tuned on-device: short marks at T-3..T-1, a longer higher
// done tone at zero so the end is unambiguous without looking.
const TONES = {
  short: { freq: 880, durMs: 120, gain: 0.25 },
  done: { freq: 1318, durMs: 450, gain: 0.3 },
};

// Thin Web Audio shell around beepOffsets. Beeps are scheduled on the audio
// clock at press time — the app's 250ms display tick is cosmetic and dies
// when the tab freezes, so it can never be the trigger. Everything degrades
// to silence (no throw into the press path) when audio is unavailable;
// hidden-tab / locked-screen playback is best-effort by platform design.
export function createBeeper() {
  let ctx = null;
  let pending = [];

  // Must run synchronously in a user-gesture handler (iOS unlock). Called on
  // every press so the context is warm one gesture before the first countdown.
  function ensureContext() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      if (!ctx) ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
    } catch (_) {
      ctx = null;
    }
  }

  function cancel() {
    for (const osc of pending) {
      try { osc.stop(); osc.disconnect(); } catch (_) {}
    }
    pending = [];
  }

  function schedule(offsets) {
    cancel();
    if (!ctx || !offsets?.length) return;
    try {
      const base = ctx.currentTime;
      for (const { atMs, kind } of offsets) {
        const { freq, durMs, gain } = TONES[kind];
        const at = base + atMs / 1000;
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
      cancel();
    }
  }

  function isArmed() { return ctx != null; }

  return { ensureContext, schedule, cancel, isArmed };
}
