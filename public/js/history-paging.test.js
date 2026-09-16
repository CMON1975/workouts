import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistoryPage } from './history-paging.js';

const S = (ts) => ({ id: `s${ts}`, finalized_at: ts });
const W = (ts) => ({ id: `w${ts}`, finalized_at: ts });
const ids = (items) => items.map(i => (i.type === 'session' ? i.session : i.workout).id);

test('mergeHistoryPage interleaves both lists newest first and is done when neither page was full', () => {
  const r = mergeHistoryPage({ sessions: [S(50), S(10)], workouts: [W(30)], limit: 3, carry: [] });
  assert.deepEqual(ids(r.items), ['s50', 'w30', 's10']);
  assert.deepEqual(r.carry, []);
  assert.equal(r.next, null);
});

test('mergeHistoryPage holds back items older than a full list\'s last item', () => {
  // Sessions page is full (limit 2), so anything older than s30 might still
  // be interleaved with unfetched sessions; w20 waits in the carry.
  const r = mergeHistoryPage({ sessions: [S(40), S(30)], workouts: [W(50), W(20)], limit: 2, carry: [] });
  assert.deepEqual(ids(r.items), ['w50', 's40', 's30']);
  assert.deepEqual(ids(r.carry), ['w20']);
  // Both lists were full, so both get a cursor.
  assert.deepEqual(r.next, { sessionsBefore: 30, workoutsBefore: 20 });
});

test('mergeHistoryPage stops asking for a list that came back short', () => {
  const r = mergeHistoryPage({ sessions: [S(40), S(30)], workouts: [W(50)], limit: 2, carry: [] });
  assert.deepEqual(ids(r.items), ['w50', 's40', 's30']);
  assert.deepEqual(r.next, { sessionsBefore: 30, workoutsBefore: null });
});

test('mergeHistoryPage merges the carry from the previous page and null-cursor lists are skipped', () => {
  // Second page: workouts exhausted (null cursor => nothing fetched), the
  // carried w20 now interleaves with the older sessions.
  const r = mergeHistoryPage({ sessions: [S(25), S(15)], workouts: [], limit: 2, carry: [{ type: 'workout', workout: W(20), ts: 20 }], workoutsExhausted: true });
  assert.deepEqual(ids(r.items), ['s25', 'w20', 's15']);
  assert.deepEqual(r.next, { sessionsBefore: 15, workoutsBefore: null });
});

test('mergeHistoryPage flushes the carry once every list is exhausted', () => {
  const r = mergeHistoryPage({ sessions: [S(5)], workouts: [], limit: 2, carry: [{ type: 'workout', workout: W(20), ts: 20 }], workoutsExhausted: true });
  assert.deepEqual(ids(r.items), ['w20', 's5']);
  assert.equal(r.next, null);
});

test('mergeHistoryPage falls back to started_at for the sort key', () => {
  const r = mergeHistoryPage({ sessions: [{ id: 'a', finalized_at: null, started_at: 7 }], workouts: [], limit: 5, carry: [] });
  assert.equal(r.items[0].ts, 7);
});
