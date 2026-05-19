import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../index.js';

let app;
let tmpDir;
let dbPath;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-tpl-test-'));
  dbPath = join(tmpDir, 'test.db');
  app = await buildApp({ dbPath, logger: false });
  await app.ready();
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('POST creates a sets-style template', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
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
    method: 'POST', url: '/api/templates',
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
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Deadlift', default_rows: 3, rows_fixed: 1,
      columns: [{ name: 'reps', unit: 'pounds' }],
    },
  });
  assert.equal(first.statusCode, 201);

  const dup = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Deadlift', default_rows: 3, rows_fixed: 1,
      columns: [{ name: 'reps', unit: 'pounds' }],
    },
  });
  assert.equal(dup.statusCode, 409);
});

test('POST with duplicate column names returns 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Bogus', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }, { name: 'X' }],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with zero columns is rejected by schema', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Empty', default_rows: 1, rows_fixed: 0,
      columns: [],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with bad value_type is rejected by schema', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'BadType', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x', value_type: 'blob' }],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH renames a template', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'OldName', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const id = create.json().id;

  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`,
    payload: { name: 'NewName' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().name, 'NewName');
});

test('PATCH rename to existing name returns 409', async () => {
  const a = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Alpha', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Beta', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${a.json().id}`,
    payload: { name: 'Beta' },
  });
  assert.equal(res.statusCode, 409);
});

test('PATCH archive hides template from default GET', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'ToArchive', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const id = create.json().id;

  const archive = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`,
    payload: { archived: true },
  });
  assert.equal(archive.statusCode, 200);
  assert.ok(archive.json().archived_at > 0);

  const def = await app.inject({ method: 'GET', url: '/api/templates' });
  const names = def.json().map(t => t.name);
  assert.ok(!names.includes('ToArchive'), 'archived is hidden by default');

  const all = await app.inject({
    method: 'GET', url: '/api/templates?include_archived=true',
  });
  const allNames = all.json().map(t => t.name);
  assert.ok(allNames.includes('ToArchive'), 'archived appears with include_archived');
});

test('PATCH archive=false restores a template', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Restoreable', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const id = create.json().id;
  await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`,
    payload: { archived: true },
  });
  const restore = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`,
    payload: { archived: false },
  });
  assert.equal(restore.statusCode, 200);
  assert.equal(restore.json().archived_at, null);
});

test('PATCH default_rows/rows_fixed updates template_defaults', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Reconfig', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`,
    payload: { default_rows: 8, rows_fixed: 1 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().default_rows, 8);
  assert.equal(res.json().rows_fixed, 1);
});

test('PATCH on missing template returns 404', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/templates/999999',
    payload: { name: 'Ghost' },
  });
  assert.equal(res.statusCode, 404);
});

test('PATCH with empty body returns 400', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'EmptyPatch', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${create.json().id}`,
    payload: {},
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH columns renames a column and preserves session_values', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'ColRename', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'reps' }, { name: 'weight', unit: 'kg' }],
    },
  });
  const tpl = create.json();
  const repsId = tpl.columns[0].id;
  const weightId = tpl.columns[1].id;

  // Record a session against the original column ids.
  const sid = '019dbaf6-6425-79fc-874e-df11ade615a0';
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
    payload: {
      id: sid, template_id: tpl.id,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
      values: [
        { row_index: 0, column_id: repsId, value_num: 10 },
        { row_index: 0, column_id: weightId, value_num: 50 },
      ],
    },
  });

  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: {
      columns: [
        { id: repsId, name: 'repetitions' },
        { id: weightId, name: 'weight', unit: 'kg' },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.columns[0].name, 'repetitions');
  assert.equal(body.columns[0].id, repsId, 'id stable after rename');

  // session_values still attached to the same column_id
  const get = await app.inject({
    method: 'GET', url: `/api/sessions/${sid}`,
  });
  const vals = get.json().values;
  assert.equal(vals.length, 2);
  assert.ok(vals.some(v => v.column_id === repsId && v.value_num === 10));
});

test('PATCH columns changes unit on an existing column', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'UnitFlip', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'weight', unit: 'kg' }],
    },
  });
  const tpl = create.json();
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: { columns: [{ id: tpl.columns[0].id, name: 'weight', unit: 'lb' }] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().columns[0].unit, 'lb');
});

test('PATCH columns adds a new column at the end', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'ColAdd', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'reps' }],
    },
  });
  const tpl = create.json();
  const repsId = tpl.columns[0].id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: {
      columns: [
        { id: repsId, name: 'reps' },
        { name: 'weight', unit: 'kg', value_type: 'number' },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const cols = res.json().columns;
  assert.equal(cols.length, 2);
  assert.equal(cols[0].id, repsId);
  assert.equal(cols[1].name, 'weight');
  assert.equal(cols[1].unit, 'kg');
  assert.equal(cols[1].position, 1);
});

test('PATCH columns reorders existing columns', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'ColReorder', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    },
  });
  const tpl = create.json();
  const [a, b, c] = tpl.columns;
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: {
      columns: [
        { id: c.id, name: 'c' },
        { id: a.id, name: 'a' },
        { id: b.id, name: 'b' },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().columns.map(x => x.id), [c.id, a.id, b.id]);
  assert.deepEqual(res.json().columns.map(x => x.position), [0, 1, 2]);
});

test('PATCH columns omitting an existing column does NOT delete it', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'NoImplicitDelete', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'a' }, { name: 'b' }],
    },
  });
  const tpl = create.json();
  const aId = tpl.columns[0].id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: { columns: [{ id: aId, name: 'a-renamed' }] },
  });
  assert.equal(res.statusCode, 200);
  const cols = res.json().columns;
  assert.equal(cols.length, 2, 'omitted column survives');
  assert.ok(cols.some(c => c.name === 'a-renamed'));
  assert.ok(cols.some(c => c.name === 'b'));
});

test('PATCH columns with empty name returns 400', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'BlankCol', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'reps' }],
    },
  });
  const tpl = create.json();
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: { columns: [{ id: tpl.columns[0].id, name: '   ' }] },
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH columns rejects id referencing a different template', async () => {
  const t1 = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: { name: 'ForeignA', default_rows: 1, rows_fixed: 0, columns: [{ name: 'a' }] },
  });
  const t2 = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: { name: 'ForeignB', default_rows: 1, rows_fixed: 0, columns: [{ name: 'b' }] },
  });
  const foreignColId = t2.json().columns[0].id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${t1.json().id}`,
    payload: { columns: [{ id: foreignColId, name: 'borrowed' }] },
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH columns rejects duplicate names in payload', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'DupCol', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'reps' }, { name: 'weight' }],
    },
  });
  const tpl = create.json();
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: {
      columns: [
        { id: tpl.columns[0].id, name: 'same' },
        { id: tpl.columns[1].id, name: 'same' },
      ],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('PATCH columns returns 409 when an active workout uses this template', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'ActiveGuard', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'reps' }],
    },
  });
  const tpl = create.json();

  const rt = await app.inject({
    method: 'POST', url: '/api/routines',
    payload: { name: 'ActiveGuardRoutine', template_ids: [tpl.id] },
  });
  const routineId = rt.json().id;

  const wid = '019dbaf7-9000-7000-8000-000000000001';
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: {
      id: wid, routine_id: routineId,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
    },
  });

  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: { columns: [{ id: tpl.columns[0].id, name: 'repetitions' }] },
  });
  assert.equal(res.statusCode, 409);

  // After finalizing the workout, the same patch succeeds.
  await app.inject({
    method: 'POST', url: `/api/workouts/${wid}/finalize`,
    payload: { client_version: 1 },
  });
  const ok = await app.inject({
    method: 'PATCH', url: `/api/templates/${tpl.id}`,
    payload: { columns: [{ id: tpl.columns[0].id, name: 'repetitions' }] },
  });
  assert.equal(ok.statusCode, 200);
});

test('GET last-session on unknown template returns 404', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/templates/999999/last-session',
  });
  assert.equal(res.statusCode, 404);
});

test('GET last-session with no finalized sessions returns null', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'NeverFinalized', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'x' }],
    },
  });
  const tpl = create.json();
  const colId = tpl.columns[0].id;
  const draftId = '019dbaf6-6425-79fc-874e-df11ade61460';
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${draftId}`,
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
    method: 'GET', url: `/api/templates/${tpl.id}/last-session`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'null');
});

test('GET last-session returns the most recent finalized session with its values', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
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
    method: 'PATCH', url: `/api/drafts/${olderId}`,
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
    method: 'POST', url: `/api/sessions/${olderId}/finalize`,
    payload: { client_version: 1 },
  });

  // Newer session
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${newerId}`,
    payload: {
      id: newerId, template_id: tpl.id,
      started_at: Date.now(), updated_at: Date.now(),
      client_version: 1,
      notes: 'increase weight next time',
      values: [
        { row_index: 0, column_id: colId, value_num: 7 },
        { row_index: 1, column_id: colId, value_num: 8 },
        { row_index: 2, column_id: colId, value_num: 9 },
      ],
    },
  });
  await app.inject({
    method: 'POST', url: `/api/sessions/${newerId}/finalize`,
    payload: { client_version: 1 },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/templates/${tpl.id}/last-session`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, newerId, 'returns most recent finalized');
  assert.equal(body.values.length, 3);
  assert.equal(body.values[0].value_num, 7);
  assert.equal(body.values[2].value_num, 9);
  assert.equal(body.notes, 'increase weight next time');
});

test('new template id can back a session', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'RunnerCircuit', default_rows: 3, rows_fixed: 1,
      columns: [{ name: 'Distance', unit: 'km' }],
    },
  });
  const tpl = create.json();
  const colId = tpl.columns[0].id;
  const sid = '019dbaf6-6425-79fc-874e-df11ade61450';

  const patch = await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
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
    method: 'GET', url: `/api/sessions/${sid}`,
  });
  assert.equal(get.json().values[0].value_num, 1.5);
});

test('POST kind=checkbox stores description and synthesizes a completed column', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Stretch routine',
      kind: 'checkbox',
      description: '10 min full-body stretch',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.kind, 'checkbox');
  assert.equal(body.description, '10 min full-body stretch');
  assert.equal(body.default_rows, 1);
  assert.equal(body.rows_fixed, 1);
  assert.deepEqual(body.columns.map(c => c.name), ['completed']);
  assert.equal(body.columns[0].value_type, 'number');
});

test('POST kind=checkbox without description returns 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: { name: 'Cooldown', kind: 'checkbox' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST kind=checkbox with blank description returns 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: { name: 'Cooldown blank', kind: 'checkbox', description: '   ' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST kind=checkbox ignores client-supplied columns/defaults', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'Cooldown',
      kind: 'checkbox',
      description: 'Easy spin',
      default_rows: 7,
      rows_fixed: 0,
      columns: [{ name: 'irrelevant' }, { name: 'also bad' }],
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.default_rows, 1);
  assert.equal(body.rows_fixed, 1);
  assert.deepEqual(body.columns.map(c => c.name), ['completed']);
});

test('PATCH updates a template description', async () => {
  const create = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'CheckboxRename',
      kind: 'checkbox',
      description: 'Initial copy',
    },
  });
  const id = create.json().id;
  const res = await app.inject({
    method: 'PATCH', url: `/api/templates/${id}`,
    payload: { description: 'Updated copy' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().description, 'Updated copy');
});

test('POST defaults kind to standard and surfaces it on GET', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: {
      name: 'KindDefault', default_rows: 1, rows_fixed: 0,
      columns: [{ name: 'reps' }],
    },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().kind, 'standard');

  const list = await app.inject({ method: 'GET', url: '/api/templates' });
  const found = list.json().find(t => t.name === 'KindDefault');
  assert.equal(found?.kind, 'standard');
});

test('POST standard with no columns is rejected', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: { name: 'NoColsStandard' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST with bad kind is rejected by schema', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/templates',
    payload: { name: 'BadKind', kind: 'whatever' },
  });
  assert.equal(res.statusCode, 400);
});
