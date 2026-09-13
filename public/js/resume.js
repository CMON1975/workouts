// Server-side fallback for resuming a routine run when the local record is
// gone (IndexedDB lost or never written — HANDOFF 2026-09-13). The server
// holds the open workout and its sessions; this rebuilds what the runner
// keeps in memory from that. Pure functions, no I/O.

// A run never spans days; an open workout older than this is abandoned, and
// the weekly publish sweep is the place that closes it.
export const OPEN_WORKOUT_MAX_AGE_MS = 12 * 3_600_000;

export function pickOpenWorkout({ workouts, routines, now = Date.now(), maxAgeMs = OPEN_WORKOUT_MAX_AGE_MS }) {
  if (!Array.isArray(workouts)) return null;
  const runnable = (w) => {
    const routine = routines.find(r => r.id === w.routine_id);
    return routine && routine.templates?.length > 0;
  };
  const candidates = workouts.filter(w =>
    w.finalized_at == null && now - w.started_at <= maxAgeMs && runnable(w),
  );
  candidates.sort((a, b) => b.started_at - a.started_at);
  return candidates[0] ?? null;
}

// Maps the workout's sessions onto routine positions by template (in start
// order, so a template that appears twice fills its slots in sequence) and
// picks the first position whose session is missing or still a draft.
// `complete` means every position is finalized: only the Finish was lost.
export function rebuildActiveWorkout({ workout, routine }) {
  const sessionIds = {};
  const finalizedAt = {};
  const sessions = [...(workout.sessions ?? [])].sort((a, b) => a.started_at - b.started_at);
  for (const s of sessions) {
    const idx = routine.templates.findIndex(
      (t, i) => t.id === s.template_id && sessionIds[i] === undefined,
    );
    if (idx === -1) continue;
    sessionIds[idx] = s.id;
    finalizedAt[idx] = s.finalized_at;
  }
  const n = routine.templates.length;
  let currentIndex = -1;
  for (let i = 0; i < n; i += 1) {
    if (sessionIds[i] === undefined || finalizedAt[i] == null) { currentIndex = i; break; }
  }
  const complete = currentIndex === -1;
  return {
    workoutId: workout.id,
    workoutClientVersion: workout.client_version ?? 1,
    startedAt: workout.started_at,
    currentIndex: complete ? n - 1 : currentIndex,
    sessionIds,
    complete,
  };
}
