import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcrypt';
import { buildApp } from '../index.js';

const PASSWORD = 'hunter2';
let app;
let cookie;
let tmpDir;
let dbPath;
let bicepTplId;
let bicepColId;
let armsRoutineId;
let archivedRoutineId;

async function login() {
  const res = await app.inject({
    method: 'POST', url: '/api/login', payload: { password: PASSWORD },
  });
  assert.equal(res.statusCode, 204);
  cookie = res.headers['set-cookie'];
}

function wuuid(n) {
  return `019dbaf7-0000-7000-8000-${String(n).padStart(12, '0')}`;
}
function suuid(n) {
  return `019dbaf7-0001-7000-8000-${String(n).padStart(12, '0')}`;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-w-test-'));
  dbPath = join(tmpDir, 'test.db');
  const hash = await bcrypt.hash(PASSWORD, 4);
  app = await buildApp({
    dbPath, passwordHash: hash, sessionSecret: 'a'.repeat(64),
    isProd: false, logger: false,
  });
  await app.ready();
  await login();

  const bicep = app.db.prepare(`SELECT id FROM templates WHERE name='Bicep Curls'`).get();
  bicepTplId = bicep.id;
  bicepColId = app.db.prepare(`SELECT id FROM template_columns WHERE template_id = ?`).get(bicepTplId).id;

  // Create an "Arms" routine with the seeded Bicep Curls.
  const arms = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'Arms', template_ids: [bicepTplId] },
  });
  armsRoutineId = arms.json().id;

  // Create a routine and archive it.
  const ar = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'OldRoutine', template_ids: [bicepTplId] },
  });
  archivedRoutineId = ar.json().id;
  await app.inject({
    method: 'PATCH', url: `/api/routines/${archivedRoutineId}`, headers: { cookie },
    payload: { archived: true },
  });
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function workoutBody(id, clientVersion, routineId = null) {
  return {
    id,
    routine_id: routineId ?? armsRoutineId,
    started_at: Date.now(),
    updated_at: Date.now(),
    client_version: clientVersion,
  };
}

test('PATCH /api/workouts/:id requires auth', async () => {
  const id = wuuid(1);
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 1),
  });
  assert.equal(res.statusCode, 401);
});

test('PATCH creates a new workout', async () => {
  const id = wuuid(2);
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 1),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().server_version, 1);

  const row = app.db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
  assert.equal(row.routine_id, armsRoutineId);
  assert.equal(row.client_version, 1);
  assert.equal(row.finalized_at, null);
});

test('PATCH is idempotent on same id with higher client_version', async () => {
  const id = wuuid(3);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 1),
  });
  const second = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 2),
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().server_version, 2);
});

test('PATCH with lower client_version returns 409 (LWW)', async () => {
  const id = wuuid(4);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 5),
  });
  const stale = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 3),
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().server_version, 5);
});

test('PATCH on finalized workout is a no-op', async () => {
  const id = wuuid(5);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 1),
  });
  await app.inject({
    method: 'POST', url: `/api/workouts/${id}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 10),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().finalized, true);
});

test('PATCH with unknown routine_id returns 400', async () => {
  const id = wuuid(6);
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 1, 999999),
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH create against archived routine returns 400', async () => {
  const id = wuuid(7);
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 1, archivedRoutineId),
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH changing routine_id on existing workout returns 400', async () => {
  const id = wuuid(8);
  // Create with arms
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 1, armsRoutineId),
  });
  // Try to change routine — make a new non-archived routine
  const other = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'Other', template_ids: [bicepTplId] },
  });
  const otherId = other.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 2, otherId),
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH with bad UUID is rejected by schema', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/workouts/not-a-uuid', headers: { cookie },
    payload: {
      id: 'not-a-uuid', routine_id: armsRoutineId,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST finalize sets finalized_at and is idempotent', async () => {
  const id = wuuid(9);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`, headers: { cookie },
    payload: workoutBody(id, 1),
  });
  const first = await app.inject({
    method: 'POST', url: `/api/workouts/${id}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });
  assert.equal(first.statusCode, 200);
  const ts = first.json().finalized_at;
  assert.ok(ts > 0);

  const second = await app.inject({
    method: 'POST', url: `/api/workouts/${id}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().finalized_at, ts);
});

test('POST finalize on unknown workout returns 404', async () => {
  const id = wuuid(99);
  const res = await app.inject({
    method: 'POST', url: `/api/workouts/${id}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });
  assert.equal(res.statusCode, 404);
});

test('GET /api/workouts/:id returns workout with child sessions in routine order', async () => {
  // Create a routine with two templates so we can verify ordering.
  const t2 = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: { name: 'PullUps', default_rows: 3, rows_fixed: 1, columns: [{ name: 'reps' }] },
  });
  const pullId = t2.json().id;
  const pullColId = t2.json().columns[0].id;

  const rt = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'UpperBody', template_ids: [pullId, bicepTplId] },
  });
  const upperId = rt.json().id;

  const wid = wuuid(10);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`, headers: { cookie },
    payload: workoutBody(wid, 1, upperId),
  });

  // Add the Bicep child first, PullUps second — routine order is PullUps THEN Bicep.
  const bicepSid = suuid(10);
  const pullSid = suuid(11);
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${bicepSid}`, headers: { cookie },
    payload: {
      id: bicepSid, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now() - 1000, updated_at: Date.now() - 1000,
      client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 10 }],
    },
  });
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${pullSid}`, headers: { cookie },
    payload: {
      id: pullSid, template_id: pullId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      values: [{ row_index: 0, column_id: pullColId, value_num: 5 }],
    },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/workouts/${wid}`, headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.routine_name, 'UpperBody');
  // Routine position: PullUps (0), Bicep (1).
  assert.deepEqual(body.sessions.map(s => s.template_id), [pullId, bicepTplId]);
});

test('GET /api/workouts/:id on unknown returns 404', async () => {
  const res = await app.inject({
    method: 'GET', url: `/api/workouts/${wuuid(999)}`, headers: { cookie },
  });
  assert.equal(res.statusCode, 404);
});

test('GET /api/workouts?finalized=true lists finalized only', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/workouts?finalized=true', headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  for (const w of res.json()) assert.ok(w.finalized_at != null);
});

test('GET /api/workouts?routine_id filters correctly', async () => {
  const res = await app.inject({
    method: 'GET', url: `/api/workouts?routine_id=${armsRoutineId}`, headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  for (const w of res.json()) assert.equal(w.routine_id, armsRoutineId);
});

test('PATCH /api/drafts accepts and stores workout_id', async () => {
  const wid = wuuid(20);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`, headers: { cookie },
    payload: workoutBody(wid, 1),
  });
  const sid = suuid(20);
  const res = await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`, headers: { cookie },
    payload: {
      id: sid, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 11 }],
    },
  });
  assert.equal(res.statusCode, 200);

  const row = app.db.prepare('SELECT workout_id FROM sessions WHERE id = ?').get(sid);
  assert.equal(row.workout_id, wid);
});

test('PATCH /api/drafts with unknown workout_id returns 400 (FK)', async () => {
  const sid = suuid(21);
  const res = await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`, headers: { cookie },
    payload: {
      id: sid, template_id: bicepTplId,
      workout_id: wuuid(777),  // nonexistent
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 1 }],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH /api/drafts omitting workout_id defaults to NULL on insert', async () => {
  const sid = suuid(22);
  const res = await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`, headers: { cookie },
    payload: {
      id: sid, template_id: bicepTplId,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 2 }],
    },
  });
  assert.equal(res.statusCode, 200);
  const row = app.db.prepare('SELECT workout_id FROM sessions WHERE id = ?').get(sid);
  assert.equal(row.workout_id, null);
});
