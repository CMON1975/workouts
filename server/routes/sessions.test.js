import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../index.js';

let app;
let tmpDir;
let dbPath;
let bicepTplId;
let bicepColId;
let armsRoutineId;

function suuid(n) {
  return `019dbaf8-0000-7000-8000-${String(n).padStart(12, '0')}`;
}
function wuuid(n) {
  return `019dbaf8-0001-7000-8000-${String(n).padStart(12, '0')}`;
}

async function createDraft(id, { workoutId = null, value = 5, clientVersion = 1 } = {}) {
  return app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`,
    payload: {
      id, template_id: bicepTplId,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: clientVersion,
      ...(workoutId !== null ? { workout_id: workoutId } : {}),
      values: [{ row_index: 0, column_id: bicepColId, value_num: value }],
    },
  });
}

async function finalizeSession(id, clientVersion = 1) {
  return app.inject({
    method: 'POST', url: `/api/sessions/${id}/finalize`,
    payload: { client_version: clientVersion },
  });
}

async function createWorkout(id, { finalize = false } = {}) {
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: {
      id, routine_id: armsRoutineId,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
    },
  });
  if (finalize) {
    await app.inject({
      method: 'POST', url: `/api/workouts/${id}/finalize`,
      payload: { client_version: 1 },
    });
  }
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-s-test-'));
  dbPath = join(tmpDir, 'test.db');
  app = await buildApp({ dbPath, logger: false });
  await app.ready();

  const bicep = app.db.prepare(`SELECT id FROM templates WHERE name='Bicep Curls'`).get();
  bicepTplId = bicep.id;
  bicepColId = app.db.prepare(`SELECT id FROM template_columns WHERE template_id = ?`).get(bicepTplId).id;

  const arms = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'Arms', template_ids: [bicepTplId] },
  });
  armsRoutineId = arms.json().id;
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('DELETE /api/sessions/:id deletes an ad-hoc finalized session and its values', async () => {
  const id = suuid(2);
  await createDraft(id, { value: 11 });
  await finalizeSession(id);

  const valsBefore = app.db
    .prepare('SELECT COUNT(*) AS n FROM session_values WHERE session_id = ?').get(id).n;
  assert.equal(valsBefore, 1);

  const res = await app.inject({
    method: 'DELETE', url: `/api/sessions/${id}`,
  });
  assert.equal(res.statusCode, 204);

  const row = app.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
  assert.equal(row, undefined);
  const valsAfter = app.db
    .prepare('SELECT COUNT(*) AS n FROM session_values WHERE session_id = ?').get(id).n;
  assert.equal(valsAfter, 0);
});

test('DELETE /api/sessions/:id returns 404 for unknown id', async () => {
  const res = await app.inject({
    method: 'DELETE', url: `/api/sessions/${suuid(999)}`,
  });
  assert.equal(res.statusCode, 404);
});

test('DELETE /api/sessions/:id returns 409 when session belongs to an unfinalized workout', async () => {
  const wid = wuuid(10);
  await createWorkout(wid); // not finalized

  const sid = suuid(10);
  await createDraft(sid, { workoutId: wid });
  await finalizeSession(sid); // session finalized but its workout is not

  const res = await app.inject({
    method: 'DELETE', url: `/api/sessions/${sid}`,
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.workout_id, wid);

  const row = app.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sid);
  assert.ok(row, 'session must remain when its workout is active');
});

test('DELETE /api/sessions/:id deletes a child session of a finalized workout without touching the workout', async () => {
  const wid = wuuid(11);
  const childA = suuid(11);
  const childB = suuid(12);
  await createWorkout(wid);
  await createDraft(childA, { workoutId: wid, value: 7 });
  await finalizeSession(childA);
  await createDraft(childB, { workoutId: wid, value: 8 });
  await finalizeSession(childB);
  // Now finalize the workout itself so the children are inside a finalized workout.
  await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 1 },
  });

  const res = await app.inject({
    method: 'DELETE', url: `/api/sessions/${childA}`,
  });
  assert.equal(res.statusCode, 204);

  const rowA = app.db.prepare('SELECT id FROM sessions WHERE id = ?').get(childA);
  assert.equal(rowA, undefined);
  const rowB = app.db.prepare('SELECT id FROM sessions WHERE id = ?').get(childB);
  assert.ok(rowB, 'sibling child session must remain');
  const w = app.db.prepare('SELECT id, finalized_at FROM workouts WHERE id = ?').get(wid);
  assert.ok(w, 'workout must remain');
  assert.ok(w.finalized_at, 'workout finalized_at must remain');
});
