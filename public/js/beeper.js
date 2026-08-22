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
