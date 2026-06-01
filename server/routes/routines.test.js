import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../index.js';

let app;
let tmpDir;
let dbPath;
let bicepId;
let otherId;

async function createTemplate(name) {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
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
  app = await buildApp({ dbPath, logger: false });
  await app.ready();

  // Seeded template is Bicep Curls; grab its id and create a second.
  bicepId = app.db.prepare(`SELECT id FROM templates WHERE name='Bicep Curls'`).get().id;
  otherId = await createTemplate('Pushups');
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('POST creates a routine with ordered templates', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines',
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
    method: 'POST', url: '/api/routines',
    payload: { name: 'Arms', template_ids: [bicepId] },
  });
  assert.equal(dup.statusCode, 409);
});

test('POST with unknown template_id returns 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'Bogus', template_ids: [bicepId, 999999] },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with duplicate template_ids returns 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'Dupes', template_ids: [bicepId, bicepId] },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with empty template_ids is rejected by schema', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'Empty', template_ids: [] },
  });
  assert.equal(res.statusCode, 400);
});

test('GET /api/routines lists non-archived by default', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/routines',
  });
  assert.equal(res.statusCode, 200);
  const names = res.json().map(r => r.name);
  assert.ok(names.includes('Arms'));
});

test('GET /api/routines/:id returns the routine with full templates', async () => {
  const list = await app.inject({
    method: 'GET', url: '/api/routines',
  });
  const arms = list.json().find(r => r.name === 'Arms');
  const res = await app.inject({
    method: 'GET', url: `/api/routines/${arms.id}`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'Arms');
  assert.equal(res.json().templates.length, 2);
});

test('GET /api/routines/:id on unknown returns 404', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/routines/999999',
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH renames a routine', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'OldName', template_ids: [bicepId] },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`,
    payload: { name: 'NewName' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'NewName');
});

test('PATCH rename to existing name returns 409', async () => {
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/1`,
    payload: { name: 'NewName' },  // collides with the previous test
  });
  assert.equal(res.statusCode, 409);
});

test('PATCH template_ids replaces and reorders', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'Reorderable', template_ids: [bicepId, otherId] },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`,
    payload: { template_ids: [otherId, bicepId] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().templates.map(t => t.id), [otherId, bicepId]);
});

test('PATCH template_ids with unknown id returns 400', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'BadEdit', template_ids: [bicepId] },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`,
    payload: { template_ids: [bicepId, 999999] },
  });
  assert.equal(res.statusCode, 400);
  // Transaction rolls back; original list is preserved.
  const after = await app.inject({
    method: 'GET', url: `/api/routines/${id}`,
  });
  assert.deepEqual(after.json().templates.map(t => t.id), [bicepId]);
});

test('PATCH archive hides from default GET; include_archived surfaces it', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'ToArchive', template_ids: [bicepId] },
  });
  const id = create.json().id;
  const arch = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`,
    payload: { archived: true },
  });
  assert.equal(arch.statusCode, 200);
  assert.ok(arch.json().archived_at > 0);

  const def = await app.inject({ method: 'GET', url: '/api/routines' });
  assert.ok(!def.json().some(r => r.name === 'ToArchive'));

  const all = await app.inject({
    method: 'GET', url: '/api/routines?include_archived=true',
  });
  assert.ok(all.json().some(r => r.name === 'ToArchive'));
});

test('PATCH archive=false restores', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'RestoreMe', template_ids: [bicepId] },
  });
  const id = create.json().id;
  await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`,
    payload: { archived: true },
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`,
    payload: { archived: false },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().archived_at, null);
});

test('PATCH on unknown routine returns 404', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/routines/999999',
    payload: { name: 'Ghost' },
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH with empty body returns 400', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'EmptyPatch', template_ids: [bicepId] },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${id}`,
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

function wuuid(n) {
  return `019dbaf7-0002-7000-8000-${String(n).padStart(12, '0')}`;
}

test('PATCH template_ids returns 409 when an active workout exists', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'LiveRoutine', template_ids: [bicepId, otherId] },
  });
  const routineId = create.json().id;

  const wid = wuuid(1);
  const start = await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: {
      id: wid, routine_id: routineId,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
    },
  });
  assert.equal(start.statusCode, 200);

  const blocked = await app.inject({
    method: 'PATCH', url: `/api/routines/${routineId}`,
    payload: { template_ids: [otherId, bicepId] },
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().workout_id, wid);

  // Original order preserved (transaction rolled back the guard).
  const after = await app.inject({
    method: 'GET', url: `/api/routines/${routineId}`,
  });
  assert.deepEqual(after.json().templates.map(t => t.id), [bicepId, otherId]);
});

test('PATCH name-only is allowed during an active workout', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'LiveRename', template_ids: [bicepId] },
  });
  const routineId = create.json().id;

  const wid = wuuid(2);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: {
      id: wid, routine_id: routineId,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
    },
  });

  const res = await app.inject({
    method: 'PATCH', url: `/api/routines/${routineId}`,
    payload: { name: 'LiveRenamed' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'LiveRenamed');
});

test('PATCH template_ids succeeds once the active workout is finalized', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'PostFinalize', template_ids: [bicepId, otherId] },
  });
  const routineId = create.json().id;

  const wid = wuuid(3);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: {
      id: wid, routine_id: routineId,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
    },
  });

  // Reorder blocked while active.
  const blocked = await app.inject({
    method: 'PATCH', url: `/api/routines/${routineId}`,
    payload: { template_ids: [otherId, bicepId] },
  });
  assert.equal(blocked.statusCode, 409);

  // Finalize, retry — succeeds.
  const fin = await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 1 },
  });
  assert.equal(fin.statusCode, 200);

  const ok = await app.inject({
    method: 'PATCH', url: `/api/routines/${routineId}`,
    payload: { template_ids: [otherId, bicepId] },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().templates.map(t => t.id), [otherId, bicepId]);
});

// --- routine ordering (sort_position) ---

async function makeRoutine(name) {
  const res = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name, template_ids: [bicepId] },
  });
  assert.equal(res.statusCode, 201);
  return res.json();
}

test('routine carries a numeric sort_position', async () => {
  const r = await makeRoutine('PosShape');
  assert.equal(typeof r.sort_position, 'number');
});

test('a new routine appends after existing ones', async () => {
  const a = await makeRoutine('AppendA');
  const b = await makeRoutine('AppendB');
  assert.ok(b.sort_position > a.sort_position, 'later routine gets a higher sort_position');
});

test('GET /api/routines is ordered by sort_position', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/routines' });
  assert.equal(res.statusCode, 200);
  const positions = res.json().map(r => r.sort_position);
  const sorted = positions.slice().sort((x, y) => x - y);
  assert.deepEqual(positions, sorted, 'list comes back in ascending sort_position order');
});

test('PUT /api/routines/order persists a custom order', async () => {
  const a = await makeRoutine('OrderA');
  const b = await makeRoutine('OrderB');
  const c = await makeRoutine('OrderC');

  const res = await app.inject({
    method: 'PUT', url: '/api/routines/order',
    payload: { ids: [c.id, a.id, b.id] },
  });
  assert.equal(res.statusCode, 200);

  // The three appear in the new relative order in a fresh GET.
  const list = (await app.inject({ method: 'GET', url: '/api/routines' })).json();
  const seen = list.map(r => r.id).filter(id => [a.id, b.id, c.id].includes(id));
  assert.deepEqual(seen, [c.id, a.id, b.id]);
});

test('PUT /api/routines/order with an unknown id returns 404', async () => {
  const a = await makeRoutine('Order404');
  const res = await app.inject({
    method: 'PUT', url: '/api/routines/order',
    payload: { ids: [a.id, 999999] },
  });
  assert.equal(res.statusCode, 404);
});

test('PUT /api/routines/order with duplicate ids returns 400', async () => {
  const a = await makeRoutine('OrderDup');
  const res = await app.inject({
    method: 'PUT', url: '/api/routines/order',
    payload: { ids: [a.id, a.id] },
  });
  assert.equal(res.statusCode, 400);
});

test('PUT /api/routines/order with empty ids is rejected by schema', async () => {
  const res = await app.inject({
    method: 'PUT', url: '/api/routines/order',
    payload: { ids: [] },
  });
  assert.equal(res.statusCode, 400);
});
