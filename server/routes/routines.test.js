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
let bicepId;
let otherId;

async function login() {
  const res = await app.inject({
    method: 'POST', url: '/api/login', payload: { password: PASSWORD },
  });
  assert.equal(res.statusCode, 204);
  cookie = res.headers['set-cookie'];
}

async function createTemplate(name) {
  const res = await app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: {
      name, default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  assert.equal(res.statusCode, 201);
  return res.json().id;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-rt-test-'));
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

  // Seeded template is Bicep Curls; grab its id and create a second.
  bicepId = app.db.prepare(`SELECT id FROM templates WHERE name='Bicep Curls'`).get().id;
  otherId = await createTemplate('Pushups');
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/routines requires auth', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'Arms', template_ids: [bicepId] },
  });
  assert.equal(res.statusCode, 401);
});

test('POST creates a routine with ordered templates', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'Arms', template_ids: [bicepId, otherId] },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.id > 0);
  assert.equal(body.name, 'Arms');
  assert.equal(body.archived_at, null);
  assert.deepEqual(body.templates.map(t => t.id), [bicepId, otherId]);
  assert.deepEqual(body.templates.map(t => t.position), [0, 1]);
  // Embedded template shape matches what /api/templates returns.
  assert.ok(Array.isArray(body.templates[0].columns));
  assert.equal(typeof body.templates[0].default_rows, 'number');
});

test('POST with duplicate name returns 409', async () => {
  const dup = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'Arms', template_ids: [bicepId] },
  });
  assert.equal(dup.statusCode, 409);
});

test('POST with unknown template_id returns 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'Bogus', template_ids: [bicepId, 999999] },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with duplicate template_ids returns 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'Dupes', template_ids: [bicepId, bicepId] },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with empty template_ids is rejected by schema', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'Empty', template_ids: [] },
  });
  assert.equal(res.statusCode, 400);
});

test('GET /api/routines lists non-archived by default', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/routines', headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const names = res.json().map(r => r.name);
  assert.ok(names.includes('Arms'));
});

test('GET /api/routines/:id returns the routine with full templates', async () => {
  const list = await app.inject({
    method: 'GET', url: '/api/routines', headers: { cookie },
  });
  const arms = list.json().find(r => r.name === 'Arms');
  const res = await app.inject({
    method: 'GET', url: `/api/routines/${arms.id}`, headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'Arms');
  assert.equal(res.json().templates.length, 2);
});

test('GET /api/routines/:id on unknown returns 404', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/routines/999999', headers: { cookie },
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH renames a routine', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'OldName', template_ids: [bicepId] },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`, headers: { cookie },
    payload: { name: 'NewName' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'NewName');
});

test('PATCH rename to existing name returns 409', async () => {
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/1`, headers: { cookie },
    payload: { name: 'NewName' },  // collides with the previous test
  });
  assert.equal(res.statusCode, 409);
});

test('PATCH template_ids replaces and reorders', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'Reorderable', template_ids: [bicepId, otherId] },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`, headers: { cookie },
    payload: { template_ids: [otherId, bicepId] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().templates.map(t => t.id), [otherId, bicepId]);
});

test('PATCH template_ids with unknown id returns 400', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'BadEdit', template_ids: [bicepId] },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`, headers: { cookie },
    payload: { template_ids: [bicepId, 999999] },
  });
  assert.equal(res.statusCode, 400);
  // Transaction rolls back; original list is preserved.
  const after = await app.inject({
    method: 'GET', url: `/api/routines/${id}`, headers: { cookie },
  });
  assert.deepEqual(after.json().templates.map(t => t.id), [bicepId]);
});

test('PATCH archive hides from default GET; include_archived surfaces it', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'ToArchive', template_ids: [bicepId] },
  });
  const id = create.json().id;
  const arch = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`, headers: { cookie },
    payload: { archived: true },
  });
  assert.equal(arch.statusCode, 200);
  assert.ok(arch.json().archived_at > 0);

  const def = await app.inject({ method: 'GET', url: '/api/routines', headers: { cookie } });
  assert.ok(!def.json().some(r => r.name === 'ToArchive'));

  const all = await app.inject({
    method: 'GET', url: '/api/routines?include_archived=true', headers: { cookie },
  });
  assert.ok(all.json().some(r => r.name === 'ToArchive'));
});

test('PATCH archive=false restores', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'RestoreMe', template_ids: [bicepId] },
  });
  const id = create.json().id;
  await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`, headers: { cookie },
    payload: { archived: true },
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`, headers: { cookie },
    payload: { archived: false },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().archived_at, null);
});

test('PATCH on unknown routine returns 404', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/routines/999999', headers: { cookie },
    payload: { name: 'Ghost' },
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH with empty body returns 400', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines', headers: { cookie },
    payload: { name: 'EmptyPatch', template_ids: [bicepId] },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`, headers: { cookie },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test('templates shared across routines map to same row', async () => {
  // bicepId appears in Arms + NewName + Reorderable + others. Archiving a
  // template that's still referenced should remain intact (RESTRICT).
  const delRes = app.db.prepare('SELECT COUNT(*) AS n FROM routine_templates WHERE template_id = ?').get(bicepId);
  assert.ok(delRes.n > 1, 'same template referenced by multiple routines');
});
