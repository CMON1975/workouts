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
let archivedRoutineId;

function wuuid(n) {
  return `019dbaf7-0000-7000-8000-${String(n).padStart(12, '0')}`;
}
function suuid(n) {
  return `019dbaf7-0001-7000-8000-${String(n).padStart(12, '0')}`;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-w-test-'));
  dbPath = join(tmpDir, 'test.db');
  app = await buildApp({ dbPath, logger: false });
  await app.ready();

  const bicep = app.db.prepare(`SELECT id FROM templates WHERE name='Bicep Curls'`).get();
  bicepTplId = bicep.id;
  bicepColId = app.db.prepare(`SELECT id FROM template_columns WHERE template_id = ?`).get(bicepTplId).id;

  // Create an "Arms" routine with the seeded Bicep Curls.
  const arms = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'Arms', template_ids: [bicepTplId] },
  });
  armsRoutineId = arms.json().id;

  // Create a routine and archive it.
  const ar = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'OldRoutine', template_ids: [bicepTplId] },
  });
  archivedRoutineId = ar.json().id;
  await app.inject({
    method: 'PATCH', url: `/api/routines/${archivedRoutineId}`,
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

test('PATCH creates a new workout', async () => {
  const id = wuuid(2);
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
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
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 1),
  });
  const second = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 2),
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().server_version, 2);
});

test('PATCH with lower client_version returns 409 (LWW)', async () => {
  const id = wuuid(4);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 5),
  });
  const stale = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 3),
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().server_version, 5);
});

test('PATCH on finalized workout is a no-op', async () => {
  const id = wuuid(5);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 1),
  });
  await app.inject({
    method: 'POST', url: `/api/workouts/${id}/finalize`,
    payload: { client_version: 1 },
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 10),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().finalized, true);
});

test('PATCH with unknown routine_id returns 400', async () => {
  const id = wuuid(6);
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 1, 999999),
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH create against archived routine returns 400', async () => {
  const id = wuuid(7);
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 1, archivedRoutineId),
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH changing routine_id on existing workout returns 400', async () => {
  const id = wuuid(8);
  // Create with arms
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 1, armsRoutineId),
  });
  // Try to change routine — make a new non-archived routine
  const other = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'Other', template_ids: [bicepTplId] },
  });
  const otherId = other.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 2, otherId),
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH with bad UUID is rejected by schema', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/workouts/not-a-uuid',
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
    method: 'PATCH', url: `/api/workouts/${id}`,
    payload: workoutBody(id, 1),
  });
  const first = await app.inject({
    method: 'POST', url: `/api/workouts/${id}/finalize`,
    payload: { client_version: 1 },
  });
  assert.equal(first.statusCode, 200);
  const ts = first.json().finalized_at;
  assert.ok(ts > 0);

  const second = await app.inject({
    method: 'POST', url: `/api/workouts/${id}/finalize`,
    payload: { client_version: 1 },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().finalized_at, ts);
});

test('POST finalize on unknown workout returns 404', async () => {
  const id = wuuid(99);
  const res = await app.inject({
    method: 'POST', url: `/api/workouts/${id}/finalize`,
    payload: { client_version: 1 },
  });
  assert.equal(res.statusCode, 404);
});

test('GET /api/workouts/:id returns child sessions in started_at order, not routine order', async () => {
  // Create a routine with two templates where the routine order is the OPPOSITE
  // of the order we'll start the children — proves we order by start time, not position.
  const t2 = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: { name: 'PullUps', default_rows: 3, rows_fixed: 1, columns: [{ name: 'reps' }] },
  });
  const pullId = t2.json().id;
  const pullColId = t2.json().columns[0].id;

  const rt = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'UpperBody', template_ids: [pullId, bicepTplId] },
  });
  const upperId = rt.json().id;

  const wid = wuuid(10);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1, upperId),
  });

  // Routine position order: [PullUps, Bicep]. We start Bicep FIRST (earlier started_at).
  // Expectation: sessions come back as [Bicep, PullUps] — chronological, not position.
  const bicepSid = suuid(10);
  const pullSid = suuid(11);
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${bicepSid}`,
    payload: {
      id: bicepSid, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now() - 1000, updated_at: Date.now() - 1000,
      client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 10 }],
    },
  });
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${pullSid}`,
    payload: {
      id: pullSid, template_id: pullId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      values: [{ row_index: 0, column_id: pullColId, value_num: 5 }],
    },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/workouts/${wid}`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.routine_name, 'UpperBody');
  assert.deepEqual(body.sessions.map(s => s.template_id), [bicepTplId, pullId]);
});

test('GET /api/workouts/:id includes notes on child sessions', async () => {
  const wid = wuuid(80);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });
  const sid = suuid(80);
  const noteText = 'pump felt great — try +2 reps next time';
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
    payload: {
      id: sid, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      notes: noteText,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 10 }],
    },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/workouts/${wid}`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].notes, noteText);
});

test('GET /api/workouts?routine_id includes notes on child sessions', async () => {
  const wid = wuuid(81);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });
  const sid = suuid(81);
  const noteText = 'list-route note check';
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
    payload: {
      id: sid, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      notes: noteText,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 9 }],
    },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/workouts?routine_id=${armsRoutineId}`,
  });
  assert.equal(res.statusCode, 200);
  const found = res.json().find(w => w.id === wid);
  assert.ok(found, 'workout listed');
  const child = found.sessions.find(s => s.id === sid);
  assert.ok(child, 'child session listed');
  assert.equal(child.notes, noteText);
});

test('GET /api/workouts/:id on unknown returns 404', async () => {
  const res = await app.inject({
    method: 'GET', url: `/api/workouts/${wuuid(999)}`,
  });
  assert.equal(res.statusCode, 404);
});

test('GET /api/workouts?finalized=true lists finalized only', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/workouts?finalized=true',
  });
  assert.equal(res.statusCode, 200);
  for (const w of res.json()) assert.ok(w.finalized_at != null);
});

test('GET /api/workouts?routine_id filters correctly', async () => {
  const res = await app.inject({
    method: 'GET', url: `/api/workouts?routine_id=${armsRoutineId}`,
  });
  assert.equal(res.statusCode, 200);
  for (const w of res.json()) assert.equal(w.routine_id, armsRoutineId);
});

test('PATCH /api/drafts accepts and stores workout_id', async () => {
  const wid = wuuid(20);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });
  const sid = suuid(20);
  const res = await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
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
    method: 'PATCH', url: `/api/drafts/${sid}`,
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

test('GET /api/workouts/:id includes values for each child session', async () => {
  // Build a fresh workout with one sub-session that has values we can identify.
  const rt = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'WithValues', template_ids: [bicepTplId] },
  });
  const routId = rt.json().id;
  const wid = wuuid(30);
  const sid = suuid(30);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: routId, started_at: Date.now(), updated_at: Date.now(), client_version: 1 },
  });
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
    payload: {
      id: sid, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
      values: [
        { row_index: 0, column_id: bicepColId, value_num: 10 },
        { row_index: 1, column_id: bicepColId, value_num: 12 },
      ],
    },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/workouts/${wid}`,
  });
  assert.equal(res.statusCode, 200);
  const child = res.json().sessions[0];
  assert.ok(Array.isArray(child.values));
  assert.equal(child.values.length, 2);
  assert.equal(child.values[0].value_num, 10);
  assert.equal(child.values[1].value_num, 12);
});

test('GET /api/sessions?include_workout_sessions=false excludes workout-linked sessions', async () => {
  // Create an ad-hoc (no workout_id) finalized session and a workout-linked finalized session.
  const adHocSid = suuid(40);
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${adHocSid}`,
    payload: {
      id: adHocSid, template_id: bicepTplId,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 7 }],
    },
  });
  await app.inject({
    method: 'POST', url: `/api/sessions/${adHocSid}/finalize`,
    payload: { client_version: 1 },
  });

  const wid = wuuid(40);
  const workoutSid = suuid(41);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: armsRoutineId, started_at: Date.now(), updated_at: Date.now(), client_version: 1 },
  });
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${workoutSid}`,
    payload: {
      id: workoutSid, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 9 }],
    },
  });
  await app.inject({
    method: 'POST', url: `/api/sessions/${workoutSid}/finalize`,
    payload: { client_version: 1 },
  });

  const included = await app.inject({
    method: 'GET', url: '/api/sessions?finalized=true',
  });
  const includedIds = included.json().map(s => s.id);
  assert.ok(includedIds.includes(adHocSid));
  assert.ok(includedIds.includes(workoutSid), 'default includes workout-linked');

  const excluded = await app.inject({
    method: 'GET', url: '/api/sessions?finalized=true&include_workout_sessions=false',
  });
  const excludedIds = excluded.json().map(s => s.id);
  assert.ok(excludedIds.includes(adHocSid), 'ad-hoc still included');
  assert.ok(!excludedIds.includes(workoutSid), 'workout-linked excluded');
});

test('PATCH /api/drafts omitting workout_id defaults to NULL on insert', async () => {
  const sid = suuid(22);
  const res = await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
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

test('DELETE /api/workouts/:id returns 404 for unknown id', async () => {
  const res = await app.inject({
    method: 'DELETE', url: `/api/workouts/${wuuid(998)}`,
  });
  assert.equal(res.statusCode, 404);
});

test('DELETE /api/workouts/:id returns 409 when workout is unfinalized', async () => {
  const wid = wuuid(51);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });

  const res = await app.inject({
    method: 'DELETE', url: `/api/workouts/${wid}`,
  });
  assert.equal(res.statusCode, 409);

  const row = app.db.prepare('SELECT id FROM workouts WHERE id = ?').get(wid);
  assert.ok(row, 'unfinalized workout must remain');
});

test('DELETE /api/workouts/:id removes the workout, all child sessions, and their values', async () => {
  const wid = wuuid(52);
  const sidA = suuid(52);
  const sidB = suuid(53);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${sidA}`,
    payload: {
      id: sidA, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
      values: [
        { row_index: 0, column_id: bicepColId, value_num: 10 },
        { row_index: 1, column_id: bicepColId, value_num: 12 },
      ],
    },
  });
  await app.inject({
    method: 'POST', url: `/api/sessions/${sidA}/finalize`,
    payload: { client_version: 1 },
  });
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${sidB}`,
    payload: {
      id: sidB, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 5 }],
    },
  });
  await app.inject({
    method: 'POST', url: `/api/sessions/${sidB}/finalize`,
    payload: { client_version: 1 },
  });
  await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 1 },
  });

  const valsBefore = app.db.prepare(
    'SELECT COUNT(*) AS n FROM session_values WHERE session_id IN (?, ?)'
  ).get(sidA, sidB).n;
  assert.equal(valsBefore, 3);

  const res = await app.inject({
    method: 'DELETE', url: `/api/workouts/${wid}`,
  });
  assert.equal(res.statusCode, 204);

  const wRow = app.db.prepare('SELECT id FROM workouts WHERE id = ?').get(wid);
  assert.equal(wRow, undefined);
  const sRows = app.db.prepare(
    'SELECT id FROM sessions WHERE id IN (?, ?)'
  ).all(sidA, sidB);
  assert.equal(sRows.length, 0, 'child sessions must be gone');
  const valsAfter = app.db.prepare(
    'SELECT COUNT(*) AS n FROM session_values WHERE session_id IN (?, ?)'
  ).get(sidA, sidB).n;
  assert.equal(valsAfter, 0, 'session_values must cascade');
});

async function addChildSession(wid, sid, { durationSeconds = null, finalize = true } = {}) {
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
    payload: {
      id: sid, template_id: bicepTplId, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      values: [{ row_index: 0, column_id: bicepColId, value_num: 8 }],
    },
  });
  if (finalize) {
    await app.inject({
      method: 'POST', url: `/api/sessions/${sid}/finalize`,
      payload: {
        client_version: 1,
        ...(durationSeconds !== null ? { duration_seconds: durationSeconds } : {}),
      },
    });
  }
}

test('workout finalize stores the sum of child session durations', async () => {
  const wid = wuuid(90);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });
  await addChildSession(wid, suuid(90), { durationSeconds: 100 });
  await addChildSession(wid, suuid(91), { durationSeconds: 50 });
  await addChildSession(wid, suuid(92)); // finalized without a duration

  const res = await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 1 },
  });
  assert.equal(res.statusCode, 200);

  const row = app.db.prepare('SELECT duration_seconds FROM workouts WHERE id = ?').get(wid);
  assert.equal(row.duration_seconds, 150);
});

test('workout finalize leaves duration_seconds NULL when no session has one', async () => {
  const wid = wuuid(91);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });
  await addChildSession(wid, suuid(93));

  await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 1 },
  });

  const row = app.db.prepare('SELECT duration_seconds FROM workouts WHERE id = ?').get(wid);
  assert.equal(row.duration_seconds, null);
});

test('workout finalize replay preserves the recorded total', async () => {
  const wid = wuuid(92);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });
  await addChildSession(wid, suuid(94), { durationSeconds: 100 });
  await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 1 },
  });

  // A later session duration must not leak into the frozen total on replay.
  await addChildSession(wid, suuid(95), { durationSeconds: 50 });
  const replay = await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 2 },
  });
  assert.equal(replay.statusCode, 200);

  const row = app.db.prepare('SELECT duration_seconds FROM workouts WHERE id = ?').get(wid);
  assert.equal(row.duration_seconds, 100);
});

test('GET workouts list and detail expose duration_seconds on workout and child sessions', async () => {
  const wid = wuuid(93);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: workoutBody(wid, 1),
  });
  await addChildSession(wid, suuid(96), { durationSeconds: 75 });
  await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 1 },
  });

  const detail = await app.inject({ method: 'GET', url: `/api/workouts/${wid}` });
  const dBody = detail.json();
  assert.equal(dBody.duration_seconds, 75);
  assert.equal(dBody.sessions[0].duration_seconds, 75);

  const list = await app.inject({ method: 'GET', url: '/api/workouts' });
  const inList = list.json().find(w => w.id === wid);
  assert.equal(inList.duration_seconds, 75);
  assert.equal(inList.sessions[0].duration_seconds, 75);
});
