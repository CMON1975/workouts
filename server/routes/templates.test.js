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

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: PASSWORD },
  });
  assert.equal(res.statusCode, 204);
  cookie = res.headers['set-cookie'];
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-tpl-test-'));
  dbPath = join(tmpDir, 'test.db');
  const hash = await bcrypt.hash(PASSWORD, 4);
  app = await buildApp({
    dbPath,
    passwordHash: hash,
    sessionSecret: 'a'.repeat(64),
    isProd: false,
    logger: false,
  });
  await app.ready();
  await login();
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/templates requires auth', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/templates',
    payload: {
      name: 'Nope', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  assert.equal(res.statusCode, 401);
});

test('POST creates a sets-style template', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Squats',
      default_rows: 5,
      rows_fixed: 1,
      columns: [{ name: 'reps', unit: 'pounds', value_type: 'number' }],
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.id > 0);
  assert.equal(body.name, 'Squats');
  assert.equal(body.default_rows, 5);
  assert.equal(body.rows_fixed, 1);
  assert.equal(body.archived_at, null);
  assert.equal(body.columns.length, 1);
  assert.equal(body.columns[0].name, 'reps');
  assert.equal(body.columns[0].unit, 'pounds');
  assert.equal(body.columns[0].position, 0);
});

test('POST creates a rows-style template with multiple columns in order', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Walk',
      default_rows: 1,
      rows_fixed: 0,
      columns: [
        { name: 'Time', unit: 'min' },
        { name: 'Incline' },
        { name: 'KPH' },
      ],
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.rows_fixed, 0);
  assert.deepEqual(body.columns.map(c => c.name), ['Time', 'Incline', 'KPH']);
  assert.deepEqual(body.columns.map(c => c.position), [0, 1, 2]);
  assert.equal(body.columns[1].unit, null);
  assert.equal(body.columns[0].value_type, 'number');
});

test('POST with duplicate name returns 409', async () => {
  const first = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Deadlift', default_rows: 3, rows_fixed: 1,
      columns: [{ name: 'reps', unit: 'pounds' }],
    },
  });
  assert.equal(first.statusCode, 201);

  const dup = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Deadlift', default_rows: 3, rows_fixed: 1,
      columns: [{ name: 'reps', unit: 'pounds' }],
    },
  });
  assert.equal(dup.statusCode, 409);
});

test('POST with duplicate column names returns 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Bogus', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }, { name: 'X' }],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with zero columns is rejected by schema', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Empty', default_rows: 1, rows_fixed: 0,
      columns: [],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with bad value_type is rejected by schema', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'BadType', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x', value_type: 'blob' }],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH renames a template', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'OldName', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const id = create.json().id;

  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`, headers: { cookie },
    payload: { name: 'NewName' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'NewName');
});

test('PATCH rename to existing name returns 409', async () => {
  const a = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Alpha', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Beta', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${a.json().id}`, headers: { cookie },
    payload: { name: 'Beta' },
  });
  assert.equal(res.statusCode, 409);
});

test('PATCH archive hides template from default GET', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'ToArchive', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const id = create.json().id;

  const archive = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`, headers: { cookie },
    payload: { archived: true },
  });
  assert.equal(archive.statusCode, 200);
  assert.ok(archive.json().archived_at > 0);

  const def = await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie } });
  const names = def.json().map(t => t.name);
  assert.ok(!names.includes('ToArchive'), 'archived is hidden by default');

  const all = await app.inject({
    method: 'GET', url: '/api/templates?include_archived=true', headers: { cookie },
  });
  const allNames = all.json().map(t => t.name);
  assert.ok(allNames.includes('ToArchive'), 'archived appears with include_archived');
});

test('PATCH archive=false restores a template', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Restoreable', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const id = create.json().id;
  await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`, headers: { cookie },
    payload: { archived: true },
  });
  const restore = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`, headers: { cookie },
    payload: { archived: false },
  });
  assert.equal(restore.statusCode, 200);
  assert.equal(restore.json().archived_at, null);
});

test('PATCH default_rows/rows_fixed updates template_defaults', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'Reconfig', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`, headers: { cookie },
    payload: { default_rows: 8, rows_fixed: 1 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().default_rows, 8);
  assert.equal(res.json().rows_fixed, 1);
});

test('PATCH on missing template returns 404', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/templates/999999', headers: { cookie },
    payload: { name: 'Ghost' },
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH with empty body returns 400', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'EmptyPatch', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${create.json().id}`, headers: { cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test('GET last-session requires auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/templates/1/last-session' });
  assert.equal(res.statusCode, 401);
});

test('GET last-session on unknown template returns 404', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/templates/999999/last-session', headers: { cookie },
  });
  assert.equal(res.statusCode, 404);
});

test('GET last-session with no finalized sessions returns null', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'NeverFinalized', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const tpl = create.json();
  const colId = tpl.columns[0].id;
  const draftId = '019dbaf6-6425-79fc-874e-df11ade61460';
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${draftId}`, headers: { cookie },
    payload: {
      id: draftId,
      template_id: tpl.id,
      started_at: Date.now(),
      updated_at: Date.now(),
      client_version: 1,
      values: [{ row_index: 0, column_id: colId, value_num: 1 }],
    },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/templates/${tpl.id}/last-session`, headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'null');
});

test('GET last-session returns the most recent finalized session with its values', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'BenchOne', default_rows: 3, rows_fixed: 1,
      columns: [{ name: 'reps' }],
    },
  });
  const tpl = create.json();
  const colId = tpl.columns[0].id;

  const olderId = '019dbaf6-6425-79fc-874e-df11ade61470';
  const newerId = '019dbaf6-6425-79fc-874e-df11ade61471';

  // Older session
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${olderId}`, headers: { cookie },
    payload: {
      id: olderId, template_id: tpl.id,
      started_at: Date.now() - 1000, updated_at: Date.now() - 1000,
      client_version: 1,
      values: [
        { row_index: 0, column_id: colId, value_num: 5 },
        { row_index: 1, column_id: colId, value_num: 6 },
      ],
    },
  });
  await app.inject({
    method: 'POST', url: `/api/sessions/${olderId}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });

  // Newer session
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${newerId}`, headers: { cookie },
    payload: {
      id: newerId, template_id: tpl.id,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      values: [
        { row_index: 0, column_id: colId, value_num: 7 },
        { row_index: 1, column_id: colId, value_num: 8 },
        { row_index: 2, column_id: colId, value_num: 9 },
      ],
    },
  });
  await app.inject({
    method: 'POST', url: `/api/sessions/${newerId}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/templates/${tpl.id}/last-session`, headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, newerId, 'returns most recent finalized');
  assert.equal(body.values.length, 3);
  assert.equal(body.values[0].value_num, 7);
  assert.equal(body.values[2].value_num, 9);
});

test('new template id can back a session', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name: 'RunnerCircuit', default_rows: 3, rows_fixed: 1,
      columns: [{ name: 'Distance', unit: 'km' }],
    },
  });
  const tpl = create.json();
  const colId = tpl.columns[0].id;
  const sid = '019dbaf6-6425-79fc-874e-df11ade61450';

  const patch = await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`, headers: { cookie },
    payload: {
      id: sid,
      template_id: tpl.id,
      started_at: Date.now(),
      updated_at: Date.now(),
      client_version: 1,
      values: [{ row_index: 0, column_id: colId, value_num: 1.5 }],
    },
  });
  assert.equal(patch.statusCode, 200);

  const get = await app.inject({
    method: 'GET', url: `/api/sessions/${sid}`, headers: { cookie },
  });
  assert.equal(get.json().values[0].value_num, 1.5);
});
