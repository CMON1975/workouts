// Past sessions is two server lists (ad-hoc sessions, workouts) merged by
// time. Paging them independently means a page from one list can reach
// further back than the other; anything older than a full list's last item
// may still interleave with rows that list hasn't returned yet, so those
// wait in `carry` until the next page (or until every list is exhausted).
const tsOf = (row) => row.finalized_at ?? row.started_at;

export function mergeHistoryPage({
  sessions, workouts, limit, carry,
  sessionsExhausted = false, workoutsExhausted = false,
}) {
  const fresh = [
    ...sessions.map(s => ({ type: 'session', session: s, ts: tsOf(s) })),
    ...workouts.map(w => ({ type: 'workout', workout: w, ts: tsOf(w) })),
  ];
  const all = [...carry, ...fresh].sort((a, b) => b.ts - a.ts);

  const sessionsFull = !sessionsExhausted && sessions.length >= limit;
  const workoutsFull = !workoutsExhausted && workouts.length >= limit;
  const frontier = Math.max(
    sessionsFull ? tsOf(sessions[sessions.length - 1]) : -Infinity,
    workoutsFull ? tsOf(workouts[workouts.length - 1]) : -Infinity,
  );

  if (!sessionsFull && !workoutsFull) {
    return { items: all, carry: [], next: null };
  }
  return {
    items: all.filter(i => i.ts >= frontier),
    carry: all.filter(i => i.ts < frontier),
    next: {
      sessionsBefore: sessionsFull ? tsOf(sessions[sessions.length - 1]) : null,
      workoutsBefore: workoutsFull ? tsOf(workouts[workouts.length - 1]) : null,
    },
  };
}
