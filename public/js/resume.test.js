import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOpenWorkout, rebuildActiveWorkout, OPEN_WORKOUT_MAX_AGE_MS } from './resume.js';

const H = 3_600_000;
const NOW = 1_000 * H;
const routines = [
  { id: 3, name: 'Tue', templates: [{ id: 33 }] },
  { id: 5, name: 'Mon', templates: [{ id: 30 }, { id: 31 }, { id: 32 }] },
  { id: 9, name: 'Empty', templates: [] },
];

test('pickOpenWorkout returns null for nothing open', () => {
  assert.equal(pickOpenWorkout({ workouts: [], routines, now: NOW }), null);
  assert.equal(pickOpenWorkout({ workouts: null, routines, now: NOW }), null);
});

test('pickOpenWorkout takes the newest recent open workout with a runnable routine', () => {
  const workouts = [
    { id: 'old', routine_id: 3, started_at: NOW - OPEN_WORKOUT_MAX_AGE_MS - 1, finalized_at: null },
    { id: 'done', routine_id: 3, started_at: NOW - H, finalized_at: NOW },
    { id: 'gone', routine_id: 99, started_at: NOW - H, finalized_at: null },
    { id: 'empty', routine_id: 9, started_at: NOW - H, finalized_at: null },
    { id: 'older-ok', routine_id: 5, started_at: NOW - 2 * H, finalized_at: null },
    { id: 'newest-ok', routine_id: 3, started_at: NOW - H, finalized_at: null },
  ];
  assert.equal(pickOpenWorkout({ workouts, routines, now: NOW }).id, 'newest-ok');
});

test('rebuildActiveWorkout maps sessions onto routine positions and resumes at the first open one', () => {
  const routine = routines[1];
  const workout = {
    id: 'w1', routine_id: 5, started_at: NOW - H, client_version: 1,
    sessions: [
      { id: 's0', template_id: 30, started_at: 1, finalized_at: 5 },
      { id: 's1', template_id: 31, started_at: 2, finalized_at: null },
    ],
  };
  assert.deepEqual(rebuildActiveWorkout({ workout, routine }), {
    workoutId: 'w1',
    workoutClientVersion: 1,
    startedAt: NOW - H,
    currentIndex: 1,
    sessionIds: { 0: 's0', 1: 's1' },
    complete: false,
  });
});

test('rebuildActiveWorkout resumes at the first position with no session yet', () => {
  const routine = routines[1];
  const workout = {
    id: 'w2', routine_id: 5, started_at: NOW - H, client_version: 1,
    sessions: [{ id: 's0', template_id: 30, started_at: 1, finalized_at: 5 }],
  };
  const r = rebuildActiveWorkout({ workout, routine });
  assert.equal(r.currentIndex, 1);
  assert.deepEqual(r.sessionIds, { 0: 's0' });
  assert.equal(r.complete, false);
});

test('rebuildActiveWorkout flags a workout whose every exercise is finalized (only Finish was lost)', () => {
  const routine = routines[0];
  const workout = {
    id: 'w3', routine_id: 3, started_at: NOW - H, client_version: 1,
    sessions: [{ id: 's0', template_id: 33, started_at: 1, finalized_at: 5 }],
  };
  const r = rebuildActiveWorkout({ workout, routine });
  assert.equal(r.complete, true);
  assert.equal(r.currentIndex, 0);
});

test('rebuildActiveWorkout ignores sessions for templates not in the routine and orders duplicates by start', () => {
  const routine = { id: 7, templates: [{ id: 40 }, { id: 40 }, { id: 41 }] };
  const workout = {
    id: 'w4', routine_id: 7, started_at: NOW - H, client_version: 2,
    sessions: [
      { id: 'later', template_id: 40, started_at: 20, finalized_at: null },
      { id: 'stray', template_id: 99, started_at: 5, finalized_at: 6 },
      { id: 'first', template_id: 40, started_at: 10, finalized_at: 15 },
    ],
  };
  const r = rebuildActiveWorkout({ workout, routine });
  assert.deepEqual(r.sessionIds, { 0: 'first', 1: 'later' });
  assert.equal(r.currentIndex, 1);
  assert.equal(r.workoutClientVersion, 2);
});
