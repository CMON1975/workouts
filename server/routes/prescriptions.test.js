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
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-presc-test-'));
  dbPath = join(tmpDir, 'test.db');
  app = await buildApp({ dbPath, logger: false });
  await app.ready();
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('migration 006: prescriptions table exists with expected columns', () => {
  const cols = app.db.prepare('PRAGMA table_info(prescriptions)').all();
  const names = cols.map(c => c.name);
  assert.deepEqual(
    names.sort(),
    ['created_at', 'ends_on', 'id', 'notes', 'routine_id', 'source', 'starts_on'].sort()
  );
  const notNull = new Set(cols.filter(c => c.notnull).map(c => c.name));
  // `id` is INTEGER PRIMARY KEY (rowid alias) — SQLite reports notnull=0 but it's effectively required.
  for (const n of ['routine_id', 'starts_on', 'ends_on', 'created_at']) {
    assert.ok(notNull.has(n), `${n} must be NOT NULL`);
  }
});

test('migration 006: prescription_targets table exists with expected columns', () => {
  const cols = app.db.prepare('PRAGMA table_info(prescription_targets)').all();
  const names = cols.map(c => c.name);
  assert.deepEqual(
    names.sort(),
    [
      'column_id', 'cue', 'prescription_id', 'row_index',
      'target_num', 'target_text', 'template_id',
    ].sort()
  );
  const pk = cols.filter(c => c.pk > 0).map(c => c.name).sort();
  assert.deepEqual(
    pk,
    ['column_id', 'prescription_id', 'row_index', 'template_id'].sort()
  );
});

test('migration 006: prescriptions(routine_id) FK cascades on routine delete', () => {
  // Seed a routine + prescription and confirm cascade removes the prescription.
  app.db.exec(`
    INSERT INTO routines (name, created_at, sort_position) VALUES ('PrescCascade', ${Date.now()}, 99);
  `);
  const r = app.db.prepare(`SELECT id FROM routines WHERE name = 'PrescCascade'`).get();
  const ins = app.db.prepare(`
    INSERT INTO prescriptions (routine_id, starts_on, ends_on, created_at)
    VALUES (?, '2026-06-08', '2026-06-14', ?)
  `).run(r.id, Date.now());
  const presId = ins.lastInsertRowid;
  app.db.prepare('DELETE FROM routines WHERE id = ?').run(r.id);
  const after = app.db.prepare('SELECT id FROM prescriptions WHERE id = ?').get(presId);
  assert.equal(after, undefined, 'prescription should cascade-delete with routine');
});

test('migration 007: workouts has nullable prescription_id column', () => {
  const cols = app.db.prepare('PRAGMA table_info(workouts)').all();
  const presCol = cols.find(c => c.name === 'prescription_id');
  assert.ok(presCol, 'workouts.prescription_id column must exist');
  assert.equal(presCol.notnull, 0, 'prescription_id must be nullable');
  const idxs = app.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workouts'`).all();
  assert.ok(
    idxs.some(i => i.name === 'ix_workouts_prescription'),
    'ix_workouts_prescription index must exist'
  );
});

test('migration 007: deleting a prescription sets workouts.prescription_id to NULL', () => {
  app.db.exec(`
    INSERT INTO routines (name, created_at, sort_position) VALUES ('PresSetNull', ${Date.now()}, 101);
  `);
  const r = app.db.prepare(`SELECT id FROM routines WHERE name = 'PresSetNull'`).get();
  const presIns = app.db.prepare(`
    INSERT INTO prescriptions (routine_id, starts_on, ends_on, created_at)
    VALUES (?, '2026-07-06', '2026-07-12', ?)
  `).run(r.id, Date.now());
  const presId = presIns.lastInsertRowid;
  const wid = '019dbaf7-9999-7000-8000-000000000007';
  app.db.prepare(`
    INSERT INTO workouts (id, routine_id, started_at, updated_at, prescription_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(wid, r.id, Date.now(), Date.now(), presId);
  app.db.prepare('DELETE FROM prescriptions WHERE id = ?').run(presId);
  const row = app.db.prepare('SELECT prescription_id FROM workouts WHERE id = ?').get(wid);
  assert.equal(row.prescription_id, null, 'workout.prescription_id should be NULL after prescription deleted');
});

test('migration 012: prescription_exercises table exists with expected columns', () => {
  const cols = app.db.prepare('PRAGMA table_info(prescription_exercises)').all();
  const names = cols.map(c => c.name);
  assert.deepEqual(
    names.sort(),
    ['prescription_id', 'rest_seconds', 'rows_per_rest', 'template_id'].sort()
  );
  const pk = cols.filter(c => c.pk > 0).map(c => c.name).sort();
  assert.deepEqual(pk, ['prescription_id', 'template_id'].sort());
  const notNull = new Set(cols.filter(c => c.notnull).map(c => c.name));
  for (const n of ['prescription_id', 'template_id']) {
    assert.ok(notNull.has(n), `${n} must be NOT NULL`);
  }
  const restCol = cols.find(c => c.name === 'rest_seconds');
  assert.equal(restCol.notnull, 0, 'rest_seconds must be nullable');
});

test('migration 012: prescription_exercises cascades on prescription delete', () => {
  app.db.exec(`
    INSERT INTO routines (name, created_at, sort_position) VALUES ('RestCascade', ${Date.now()}, 102);
    INSERT INTO templates (name, created_at) VALUES ('RestCascadeTpl', ${Date.now()});
  `);
  const r = app.db.prepare(`SELECT id FROM routines WHERE name = 'RestCascade'`).get();
  const t = app.db.prepare(`SELECT id FROM templates WHERE name = 'RestCascadeTpl'`).get();
  const presIns = app.db.prepare(`
    INSERT INTO prescriptions (routine_id, starts_on, ends_on, created_at)
    VALUES (?, '2026-08-17', '2026-08-23', ?)
  `).run(r.id, Date.now());
  const presId = presIns.lastInsertRowid;
  app.db.prepare(`
    INSERT INTO prescription_exercises (prescription_id, template_id, rest_seconds)
    VALUES (?, ?, 90)
  `).run(presId, t.id);
  app.db.prepare('DELETE FROM prescriptions WHERE id = ?').run(presId);
  const row = app.db.prepare('SELECT * FROM prescription_exercises WHERE prescription_id = ?').get(presId);
  assert.equal(row, undefined, 'prescription_exercises row should cascade-delete with prescription');
});

function nextId(prefix = 'p') {
  // Tests share the test app + DB; randomize routine/template names within a test
  // run by appending a monotonic counter so tests don't collide on UNIQUE name.
  nextId._n = (nextId._n ?? 0) + 1;
  return `${prefix}${nextId._n}`;
}

function sampleStandardExercise(name, targets = null) {
  return {
    template_name: name,
    kind: 'standard',
    columns: [
      { name: 'reps', unit: null, value_type: 'number' },
      { name: 'weight', unit: 'pounds', value_type: 'number' },
    ],
    default_rows: 4,
    rows_fixed: 1,
    targets: targets ?? [
      { row_index: 0, column: 'reps', target_num: 6 },
      { row_index: 0, column: 'weight', target_num: 22.5, cue: 'RPE 7' },
      { row_index: 1, column: 'reps', target_num: 6 },
      { row_index: 1, column: 'weight', target_num: 22.5 },
    ],
  };
}

function sampleCheckboxExercise(name, description = '1 min hip 90/90 each side') {
  return {
    template_name: name,
    kind: 'checkbox',
    description,
    targets: [{ row_index: 0, column: 'completed', target_num: 1, cue: 'just do it' }],
  };
}

test('POST /api/prescriptions/import — happy path creates routine, template, prescription, targets', async () => {
  const routineName = nextId('Routine');
  const templateName = nextId('Tpl');
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-08',
      week_ends_on: '2026-06-14',
      source: 'test',
      days: [
        {
          routine_name: routineName,
          notes: 'Phase 2 wk 6',
          exercises: [sampleStandardExercise(templateName)],
        },
      ],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  assert.equal(body.prescriptions.length, 1);
  assert.equal(body.prescriptions[0].routine_name, routineName);
  assert.equal(body.prescriptions[0].starts_on, '2026-06-08');
  assert.ok(body.prescriptions[0].id > 0);

  const r = app.db.prepare(`SELECT id, sort_position FROM routines WHERE name = ?`).get(routineName);
  assert.ok(r, 'routine created');
  const t = app.db.prepare(`SELECT id, kind FROM templates WHERE name = ?`).get(templateName);
  assert.ok(t, 'template created');
  assert.equal(t.kind, 'standard');

  const cols = app.db.prepare(`SELECT name, position FROM template_columns WHERE template_id = ? ORDER BY position`).all(t.id);
  assert.deepEqual(cols.map(c => c.name), ['reps', 'weight']);

  const rt = app.db.prepare(`SELECT template_id, position FROM routine_templates WHERE routine_id = ?`).all(r.id);
  assert.equal(rt.length, 1);
  assert.equal(rt[0].template_id, t.id);

  const targets = app.db.prepare(`
    SELECT pt.row_index, pt.target_num, pt.cue, tc.name AS column_name
      FROM prescription_targets pt
      JOIN template_columns tc ON tc.id = pt.column_id
     WHERE pt.prescription_id = ?
     ORDER BY pt.row_index, tc.position
  `).all(body.prescriptions[0].id);
  assert.equal(targets.length, 4);
  assert.deepEqual(targets[0], { row_index: 0, target_num: 6, cue: null, column_name: 'reps' });
  assert.deepEqual(targets[1], { row_index: 0, target_num: 22.5, cue: 'RPE 7', column_name: 'weight' });
});

test('POST /api/prescriptions/import — rest_seconds lands in prescription_exercises', async () => {
  const routineName = nextId('RestRoutine');
  const withRest = nextId('RestTpl');
  const withoutRest = nextId('NoRestTpl');
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-17',
      week_ends_on: '2026-08-23',
      days: [
        {
          routine_name: routineName,
          exercises: [
            { ...sampleStandardExercise(withRest), rest_seconds: 90 },
            sampleStandardExercise(withoutRest),
          ],
        },
      ],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const presId = res.json().prescriptions[0].id;
  const tWith = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(withRest);
  const rows = app.db.prepare(
    'SELECT template_id, rest_seconds FROM prescription_exercises WHERE prescription_id = ?'
  ).all(presId);
  assert.deepEqual(rows, [{ template_id: tWith.id, rest_seconds: 90 }]);
});

test('POST /api/prescriptions/import — rest_seconds accepted with empty targets', async () => {
  const routineName = nextId('RestEmptyRoutine');
  const templateName = nextId('RestEmptyTpl');
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-17',
      week_ends_on: '2026-08-23',
      days: [
        {
          routine_name: routineName,
          exercises: [{ ...sampleStandardExercise(templateName, []), rest_seconds: 120 }],
        },
      ],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const presId = res.json().prescriptions[0].id;
  const rows = app.db.prepare(
    'SELECT rest_seconds FROM prescription_exercises WHERE prescription_id = ?'
  ).all(presId);
  assert.deepEqual(rows, [{ rest_seconds: 120 }]);
});

test('POST /api/prescriptions/import — invalid rest_seconds rejected with 400', async () => {
  for (const bad of [0, 3601, 'ninety', 1.5]) {
    const res = await app.inject({
      method: 'POST', url: '/api/prescriptions/import',
      payload: {
        week_starts_on: '2026-08-17',
        week_ends_on: '2026-08-23',
        days: [
          {
            routine_name: nextId('BadRestRoutine'),
            exercises: [{ ...sampleStandardExercise(nextId('BadRestTpl')), rest_seconds: bad }],
          },
        ],
      },
    });
    assert.equal(res.statusCode, 400, `rest_seconds ${JSON.stringify(bad)} should be rejected`);
  }
});

test('POST /api/prescriptions/import — duplicate template in one day is rejected (characterization)', async () => {
  // routine_templates has UNIQUE (routine_id, template_id), so a day can never
  // hold the same exercise twice — the import fails before rest handling runs.
  // Pinned here so the health-repo contract can say "no duplicate templates".
  const routineName = nextId('DupRestRoutine');
  const templateName = nextId('DupRestTpl');
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-17',
      week_ends_on: '2026-08-23',
      days: [
        {
          routine_name: routineName,
          exercises: [
            { ...sampleStandardExercise(templateName), rest_seconds: 45 },
            { ...sampleStandardExercise(templateName, []), rest_seconds: 60 },
          ],
        },
      ],
    },
  });
  assert.equal(res.statusCode, 500, res.body);
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const pres = app.db.prepare('SELECT id FROM prescriptions WHERE routine_id = ?').all(r?.id ?? -1);
  assert.equal(pres.length, 0, 'failed import must not leave a prescription behind');
});

test('GET /api/prescriptions/active — single mode carries exercises with rest_seconds', async () => {
  const routineName = nextId('ActiveRestRoutine');
  const templateName = nextId('ActiveRestTpl');
  const imp = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-17',
      week_ends_on: '2026-08-23',
      days: [
        {
          routine_name: routineName,
          exercises: [{ ...sampleStandardExercise(templateName), rest_seconds: 90 }],
        },
      ],
    },
  });
  assert.equal(imp.statusCode, 201, imp.body);
  const routineId = imp.json().prescriptions[0].routine_id;
  const t = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(templateName);

  const res = await app.inject({ method: 'GET', url: `/api/prescriptions/active?routine_id=${routineId}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().exercises, [{ template_id: t.id, rest_seconds: 90, rows_per_rest: null }]);
});

test('GET /api/prescriptions/active — exercises is an empty array when no rest prescribed', async () => {
  const routineName = nextId('NoRestActiveRoutine');
  const imp = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-17',
      week_ends_on: '2026-08-23',
      days: [
        {
          routine_name: routineName,
          exercises: [sampleStandardExercise(nextId('NoRestActiveTpl'))],
        },
      ],
    },
  });
  assert.equal(imp.statusCode, 201, imp.body);
  const routineId = imp.json().prescriptions[0].routine_id;

  const res = await app.inject({ method: 'GET', url: `/api/prescriptions/active?routine_id=${routineId}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().exercises, []);
});

test('GET /api/prescriptions/active — array mode carries exercises per routine', async () => {
  const routineName = nextId('ArrRestRoutine');
  const templateName = nextId('ArrRestTpl');
  const imp = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-17',
      week_ends_on: '2026-08-23',
      days: [
        {
          routine_name: routineName,
          exercises: [{ ...sampleStandardExercise(templateName), rest_seconds: 75 }],
        },
      ],
    },
  });
  assert.equal(imp.statusCode, 201, imp.body);
  const routineId = imp.json().prescriptions[0].routine_id;
  const t = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(templateName);

  const res = await app.inject({ method: 'GET', url: '/api/prescriptions/active' });
  assert.equal(res.statusCode, 200, res.body);
  const entry = res.json().find(e => e.routine_id === routineId);
  assert.ok(entry, 'array mode entry for the imported routine');
  assert.deepEqual(entry.exercises, [{ template_id: t.id, rest_seconds: 75, rows_per_rest: null }]);
});

test('POST /api/prescriptions/import — find-or-create reuses existing routine + template', async () => {
  const routineName = nextId('ReuseRoutine');
  const templateName = nextId('ReuseTpl');
  // First import — create.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-08',
      week_ends_on: '2026-06-14',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const tBefore = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(templateName);
  const rBefore = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);

  // Second import — should reuse same ids.
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-15',
      week_ends_on: '2026-06-21',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  assert.equal(res.statusCode, 201);
  const tAfter = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(templateName);
  const rAfter = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  assert.equal(tBefore.id, tAfter.id, 'template id stable across re-import');
  assert.equal(rBefore.id, rAfter.id, 'routine id stable across re-import');
});

test('POST /api/prescriptions/import — re-import for same routine + week inserts NEW prescription row', async () => {
  const routineName = nextId('SameWeek');
  const templateName = nextId('SameWeekTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-22',
      week_ends_on: '2026-06-28',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const second = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-22',
      week_ends_on: '2026-06-28',
      days: [{
        routine_name: routineName,
        exercises: [sampleStandardExercise(templateName, [
          { row_index: 0, column: 'reps', target_num: 99 },
          { row_index: 0, column: 'weight', target_num: 30 },
        ])],
      }],
    },
  });
  assert.equal(second.statusCode, 201);
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const rows = app.db.prepare(
    'SELECT id FROM prescriptions WHERE routine_id = ? AND starts_on = ? ORDER BY id'
  ).all(r.id, '2026-06-22');
  assert.equal(rows.length, 2, 'two prescriptions for the same (routine, starts_on)');
});

test('GET /api/prescriptions/active?routine_id=X returns most recent applicable prescription with targets', async () => {
  const routineName = nextId('ActiveRoutine');
  const templateName = nextId('ActiveTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-05-04',
      week_ends_on: '2026-05-10',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName, [
        { row_index: 0, column: 'reps', target_num: 5 },
      ])] }],
    },
  });
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-05-11',
      week_ends_on: '2026-05-17',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName, [
        { row_index: 0, column: 'reps', target_num: 7 },
      ])] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const res = await app.inject({
    method: 'GET',
    url: `/api/prescriptions/active?routine_id=${r.id}&on=2026-05-13`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.starts_on, '2026-05-11', 'most recent applicable');
  const target = body.targets.find(t => t.column_name === 'reps');
  assert.equal(target.target_num, 7);
});

test('GET /api/prescriptions/active?routine_id=X (no on) returns the latest for the routine, even if future (preview Sunday publish)', async () => {
  const routine = nextId('SingleLatest');
  const tpl = nextId('SingleLatestTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-02-09',
      week_ends_on: '2026-02-15',
      days: [{ routine_name: routine, exercises: [sampleStandardExercise(tpl, [
        { row_index: 0, column: 'reps', target_num: 3 },
      ])] }],
    },
  });
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2099-02-01',
      week_ends_on: '2099-02-07',
      days: [{ routine_name: routine, exercises: [sampleStandardExercise(tpl, [
        { row_index: 0, column: 'reps', target_num: 88 },
      ])] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routine);
  const res = await app.inject({ method: 'GET', url: `/api/prescriptions/active?routine_id=${r.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.starts_on, '2099-02-01', 'future prescription wins when no ?on=');
  const reps = body.targets.find(t => t.column_name === 'reps');
  assert.equal(reps.target_num, 88);
});

test('GET /api/prescriptions/active (no routine_id) returns array with most-recent prescription per routine, fully populated', async () => {
  const routineA = nextId('ArrayActiveA');
  const routineB = nextId('ArrayActiveB');
  const tpl = nextId('ArrayActiveTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-04-01',
      week_ends_on: '2026-04-07',
      days: [
        { routine_name: routineA, exercises: [sampleStandardExercise(tpl)] },
        { routine_name: routineB, exercises: [sampleStandardExercise(tpl)] },
      ],
    },
  });

  const res = await app.inject({ method: 'GET', url: '/api/prescriptions/active?on=2026-04-04' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(Array.isArray(body), 'returns array');
  const mineA = body.find(r => r.routine_name === routineA);
  const mineB = body.find(r => r.routine_name === routineB);
  assert.ok(mineA, `expected ${routineA} in response`);
  assert.ok(mineB, `expected ${routineB} in response`);
  for (const item of [mineA, mineB]) {
    assert.ok(item.routine_id > 0, 'routine_id present');
    assert.ok(item.prescription?.id > 0, 'prescription nested object');
    assert.equal(item.prescription.starts_on, '2026-04-01');
    assert.ok(Array.isArray(item.targets) && item.targets.length > 0, 'targets array populated');
    for (const t of item.targets) {
      assert.ok(t.template_name, 'template_name resolved');
      assert.ok(t.column_name, 'column_name resolved');
    }
  }
});

test('GET /api/prescriptions/active (no routine_id) returns the most recent applicable per routine, honoring ?on=', async () => {
  const routine = nextId('ArrayMostRecent');
  const tpl = nextId('ArrayMostRecentTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-03-02',
      week_ends_on: '2026-03-08',
      days: [{ routine_name: routine, exercises: [sampleStandardExercise(tpl, [
        { row_index: 0, column: 'reps', target_num: 5 },
      ])] }],
    },
  });
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-03-09',
      week_ends_on: '2026-03-15',
      days: [{ routine_name: routine, exercises: [sampleStandardExercise(tpl, [
        { row_index: 0, column: 'reps', target_num: 9 },
      ])] }],
    },
  });

  const res = await app.inject({ method: 'GET', url: '/api/prescriptions/active?on=2026-03-11' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const mine = body.find(r => r.routine_name === routine);
  assert.ok(mine, `expected ${routine} in response`);
  assert.equal(mine.prescription.starts_on, '2026-03-09', 'most recent applicable wins');
  const reps = mine.targets.find(t => t.column_name === 'reps');
  assert.equal(reps.target_num, 9);
});

test('GET /api/prescriptions/active (no routine_id, no on) returns the latest per routine regardless of starts_on (preview future prescriptions)', async () => {
  const routine = nextId('ArrayLatest');
  const tpl = nextId('ArrayLatestTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-02-02',
      week_ends_on: '2026-02-08',
      days: [{ routine_name: routine, exercises: [sampleStandardExercise(tpl, [
        { row_index: 0, column: 'reps', target_num: 3 },
      ])] }],
    },
  });
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2099-01-01',
      week_ends_on: '2099-01-07',
      days: [{ routine_name: routine, exercises: [sampleStandardExercise(tpl, [
        { row_index: 0, column: 'reps', target_num: 99 },
      ])] }],
    },
  });

  const res = await app.inject({ method: 'GET', url: '/api/prescriptions/active' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const mine = body.find(r => r.routine_name === routine);
  assert.ok(mine, `expected ${routine} in response`);
  assert.equal(mine.prescription.starts_on, '2099-01-01', 'future prescription is the latest');
  const reps = mine.targets.find(t => t.column_name === 'reps');
  assert.equal(reps.target_num, 99);
});

test('GET /api/prescriptions/active (no routine_id) skips routines that have no applicable prescription', async () => {
  const routine = nextId('ArrayNoPresc');
  app.db.prepare(
    'INSERT INTO routines (name, created_at, sort_position) VALUES (?, ?, ?)'
  ).run(routine, Date.now(), 400);
  const res = await app.inject({ method: 'GET', url: '/api/prescriptions/active?on=2026-01-01' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const found = body.find(r => r.routine_name === routine);
  assert.equal(found, undefined, 'routine without prescription is not in the array');
});

test('GET /api/prescriptions/active returns null when no prescription applies', async () => {
  const routineName = nextId('NoActive');
  app.db.exec(`
    INSERT INTO routines (name, created_at, sort_position) VALUES ('${routineName}', ${Date.now()}, 200);
  `);
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const res = await app.inject({
    method: 'GET',
    url: `/api/prescriptions/active?routine_id=${r.id}&on=2026-05-04`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'null');
});

test('POST /api/prescriptions/import — 409 when an active workout exists on a touched routine', async () => {
  const routineName = nextId('ActiveWorkoutGate');
  const templateName = nextId('ActiveWorkoutTpl');
  // Seed prescription + routine + template.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-01',
      week_ends_on: '2026-06-07',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  // Create an unfinalized workout on that routine.
  const wid = '019dbaf7-aaaa-7000-8000-000000000aaa';
  const res1 = await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: r.id, started_at: Date.now(), updated_at: Date.now(), client_version: 1 },
  });
  assert.equal(res1.statusCode, 200);

  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-08',
      week_ends_on: '2026-06-14',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /active workout/i);
});

test('POST /api/prescriptions/import — 400 when create_if_missing=false and template missing', async () => {
  const routineName = nextId('NoCreate');
  const templateName = nextId('NoCreateTpl');
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-08',
      week_ends_on: '2026-06-14',
      create_if_missing: false,
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /template/i);
  // Rollback check: routine must not exist either.
  assert.equal(
    app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName),
    undefined
  );
});

test('POST /api/prescriptions/import — 409 column shape mismatch on existing template', async () => {
  const routineName = nextId('ShapeRoutine');
  const templateName = nextId('ShapeTpl');
  // Seed template via a first import.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-08',
      week_ends_on: '2026-06-14',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  // Now try to prescribe a target on a column that doesn't exist on the template.
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-15',
      week_ends_on: '2026-06-21',
      days: [{
        routine_name: routineName,
        exercises: [{
          ...sampleStandardExercise(templateName),
          targets: [{ row_index: 0, column: 'distance', target_num: 5 }],
        }],
      }],
    },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /column.*distance|template_shape_mismatch/i);
});

test('POST /api/prescriptions/import — 400 when max_new_templates exceeded (rollback)', async () => {
  const routineName = nextId('CapRoutine');
  const tpls = [nextId('CapA'), nextId('CapB'), nextId('CapC')];
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-08',
      week_ends_on: '2026-06-14',
      max_new_templates: 2,
      days: [{
        routine_name: routineName,
        exercises: tpls.map(n => sampleStandardExercise(n)),
      }],
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /max_new_templates/);
  // Rollback: none of the templates should exist.
  for (const n of tpls) {
    assert.equal(app.db.prepare('SELECT id FROM templates WHERE name = ?').get(n), undefined);
  }
  assert.equal(app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName), undefined);
});

test('POST /api/prescriptions/import — checkbox template round-trip', async () => {
  const routineName = nextId('CbRoutine');
  const templateName = nextId('CbTpl');
  const desc = '1 min hip 90/90 each side, 1 min couch stretch';
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-06-08',
      week_ends_on: '2026-06-14',
      days: [{
        routine_name: routineName,
        exercises: [sampleCheckboxExercise(templateName, desc)],
      }],
    },
  });
  assert.equal(res.statusCode, 201);
  const t = app.db.prepare('SELECT id, kind, description FROM templates WHERE name = ?').get(templateName);
  assert.equal(t.kind, 'checkbox');
  assert.equal(t.description, desc);

  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const active = await app.inject({
    method: 'GET',
    url: `/api/prescriptions/active?routine_id=${r.id}&on=2026-06-10`,
  });
  assert.equal(active.statusCode, 200);
  const body = active.json();
  assert.equal(body.targets.length, 1);
  assert.equal(body.targets[0].column_name, 'completed');
  assert.equal(body.targets[0].target_num, 1);
  assert.equal(body.targets[0].cue, 'just do it');
});

test('POST /api/prescriptions/import — finalize_pending=true deletes empty draft on touched routine and proceeds', async () => {
  const routineName = nextId('FinalizeEmptyRoutine');
  const templateName = nextId('FinalizeEmptyTpl');
  // Seed routine + template via initial import.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-03',
      week_ends_on: '2026-08-09',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  // Create an empty unfinalized workout (no child sessions).
  const wid = '019ec999-aaaa-7000-8000-000000000001';
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: r.id, started_at: Date.now(), updated_at: Date.now(), client_version: 1 },
  });
  // Confirm draft exists, no sessions.
  assert.equal(app.db.prepare('SELECT id FROM workouts WHERE id = ?').get(wid)?.id, wid);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE workout_id = ?').get(wid).n, 0);

  // Re-import with finalize_pending=true — should succeed AND delete the empty draft.
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-10',
      week_ends_on: '2026-08-16',
      finalize_pending: true,
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const draftAfter = app.db.prepare('SELECT id FROM workouts WHERE id = ?').get(wid);
  assert.equal(draftAfter, undefined, 'empty draft should be deleted');
});

test('POST /api/prescriptions/import — finalize_pending=true finalizes a draft that has child sessions', async () => {
  const routineName = nextId('FinalizeWithDataRoutine');
  const templateName = nextId('FinalizeWithDataTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-03',
      week_ends_on: '2026-08-09',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const tpl = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(templateName);
  const tplCol = app.db.prepare(`SELECT id FROM template_columns WHERE template_id = ? AND name = 'reps'`).get(tpl.id);

  const wid = '019ec999-aaaa-7000-8000-000000000002';
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: r.id, started_at: Date.now(), updated_at: Date.now(), client_version: 1 },
  });
  // Drop a real child session with a recorded value.
  const sid = '019ec999-bbbb-7000-8000-000000000002';
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${sid}`,
    payload: {
      id: sid, template_id: tpl.id, workout_id: wid,
      started_at: Date.now(), updated_at: Date.now(), client_version: 1,
      values: [{ row_index: 0, column_id: tplCol.id, value_num: 7 }],
    },
  });

  // Re-import with finalize_pending=true.
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-10',
      week_ends_on: '2026-08-16',
      finalize_pending: true,
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  assert.equal(res.statusCode, 201, res.body);

  const row = app.db.prepare('SELECT finalized_at FROM workouts WHERE id = ?').get(wid);
  assert.ok(row, 'workout with data should NOT be deleted');
  assert.ok(row.finalized_at != null, 'workout with data should be finalized');
  const sRow = app.db.prepare('SELECT finalized_at FROM sessions WHERE id = ?').get(sid);
  assert.ok(sRow.finalized_at != null, 'child session should also be finalized');
  // Value preserved.
  assert.equal(
    app.db.prepare('SELECT value_num FROM session_values WHERE session_id = ? AND row_index = 0').get(sid).value_num,
    7
  );
});

test('POST /api/prescriptions/import — finalize_pending omitted keeps the active-workout gate', async () => {
  const routineName = nextId('GateStillFiresRoutine');
  const templateName = nextId('GateStillFiresTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-17',
      week_ends_on: '2026-08-23',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const wid = '019ec999-aaaa-7000-8000-000000000003';
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: r.id, started_at: Date.now(), updated_at: Date.now(), client_version: 1 },
  });
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-24',
      week_ends_on: '2026-08-30',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  assert.equal(res.statusCode, 409, 'gate fires without finalize_pending');
});

test('POST /api/prescriptions/import — description on existing template updates the template description', async () => {
  const routineName = nextId('DescUpdateRoutine');
  const templateName = nextId('DescUpdateTpl');
  // Create the template via import without description.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-09-07',
      week_ends_on: '2026-09-13',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const tBefore = app.db.prepare('SELECT description FROM templates WHERE name = ?').get(templateName);
  assert.equal(tBefore.description, null);

  // Re-import with description on the same template.
  const desc = 'RPE 7. Pause 1s at the bottom. Watch knee tracking on lockout.';
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-09-14',
      week_ends_on: '2026-09-20',
      days: [{
        routine_name: routineName,
        exercises: [{ ...sampleStandardExercise(templateName), description: desc }],
      }],
    },
  });
  assert.equal(res.statusCode, 201);
  const tAfter = app.db.prepare('SELECT description FROM templates WHERE name = ?').get(templateName);
  assert.equal(tAfter.description, desc);
});

test('POST /api/prescriptions/import — missing description leaves existing template description untouched', async () => {
  const routineName = nextId('DescKeepRoutine');
  const templateName = nextId('DescKeepTpl');
  const originalDesc = 'original prose';
  // Create template with a description via import.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-10-05',
      week_ends_on: '2026-10-11',
      days: [{
        routine_name: routineName,
        exercises: [{ ...sampleStandardExercise(templateName), description: originalDesc }],
      }],
    },
  });
  // Re-import without description.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-10-12',
      week_ends_on: '2026-10-18',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const tAfter = app.db.prepare('SELECT description FROM templates WHERE name = ?').get(templateName);
  assert.equal(tAfter.description, originalDesc, 'no-description re-import preserves prior description');
});

test('PATCH /api/workouts/:id stamps prescription_id on first create from started_at date', async () => {
  const routineName = nextId('StampRoutine');
  const templateName = nextId('StampTpl');
  // Prescribe two consecutive weeks so we can verify the date-range pick.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-07-06',
      week_ends_on: '2026-07-12',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-07-13',
      week_ends_on: '2026-07-19',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const expected = app.db.prepare(
    'SELECT id FROM prescriptions WHERE routine_id = ? AND starts_on = ?'
  ).get(r.id, '2026-07-13');
  assert.ok(expected, 'precondition: wk2 prescription exists');

  // Workout started Wed 2026-07-15 (UTC) — falls in the wk2 window.
  const startedAt = Date.UTC(2026, 6, 15, 15, 0, 0); // months are 0-indexed
  const wid = '019dbaf7-bbbb-7000-8000-000000000111';
  const res = await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: {
      id: wid, routine_id: r.id, started_at: startedAt, updated_at: startedAt, client_version: 1,
    },
  });
  assert.equal(res.statusCode, 200);
  const row = app.db.prepare('SELECT prescription_id FROM workouts WHERE id = ?').get(wid);
  assert.equal(row.prescription_id, expected.id, 'workout stamped with wk2 prescription');
});

test('PATCH /api/workouts/:id re-PATCH does not change a stamped prescription_id', async () => {
  const routineName = nextId('NoRestampRoutine');
  const templateName = nextId('NoRestampTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-07-06',
      week_ends_on: '2026-07-12',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const wid = '019dbaf7-bbbb-7000-8000-000000000222';
  const startedAt = Date.UTC(2026, 6, 8, 15, 0, 0);
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: r.id, started_at: startedAt, updated_at: startedAt, client_version: 1 },
  });
  const stamped = app.db.prepare('SELECT prescription_id FROM workouts WHERE id = ?').get(wid).prescription_id;
  assert.ok(stamped, 'precondition: stamped');

  // Add a NEWER prescription that would change "active" if re-stamping happened.
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-07-06',
      week_ends_on: '2026-07-12',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });

  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: r.id, started_at: startedAt, updated_at: startedAt + 1, client_version: 2 },
  });
  const after = app.db.prepare('SELECT prescription_id FROM workouts WHERE id = ?').get(wid).prescription_id;
  assert.equal(after, stamped, 'prescription_id is immutable after first stamp');
});

test('PATCH /api/workouts/:id leaves prescription_id NULL when no prescription is active', async () => {
  // Seed an unrelated routine that has no prescription.
  const routineName = nextId('NoPrescRoutine');
  app.db.prepare(`
    INSERT INTO routines (name, created_at, sort_position) VALUES (?, ?, ?)
  `).run(routineName, Date.now(), 250);
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const wid = '019dbaf7-bbbb-7000-8000-000000000333';
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: r.id, started_at: Date.now(), updated_at: Date.now(), client_version: 1 },
  });
  const row = app.db.prepare('SELECT prescription_id FROM workouts WHERE id = ?').get(wid);
  assert.equal(row.prescription_id, null);
});

test('migration 006: prescription_targets cascades on prescription delete', () => {
  // Seed routine + prescription + target, then delete prescription and verify the target is gone.
  app.db.exec(`
    INSERT INTO routines (name, created_at, sort_position) VALUES ('TargetsCascade', ${Date.now()}, 100);
  `);
  const r = app.db.prepare(`SELECT id FROM routines WHERE name = 'TargetsCascade'`).get();
  const tpl = app.db.prepare(`SELECT id FROM templates WHERE name = 'Bicep Curls'`).get();
  const col = app.db.prepare(`SELECT id FROM template_columns WHERE template_id = ?`).get(tpl.id);
  const ins = app.db.prepare(`
    INSERT INTO prescriptions (routine_id, starts_on, ends_on, created_at)
    VALUES (?, '2026-06-15', '2026-06-21', ?)
  `).run(r.id, Date.now());
  const presId = ins.lastInsertRowid;
  app.db.prepare(`
    INSERT INTO prescription_targets
      (prescription_id, template_id, row_index, column_id, target_num)
    VALUES (?, ?, 0, ?, 8)
  `).run(presId, tpl.id, col.id);
  assert.equal(
    app.db.prepare('SELECT COUNT(*) AS n FROM prescription_targets WHERE prescription_id = ?').get(presId).n,
    1
  );
  app.db.prepare('DELETE FROM prescriptions WHERE id = ?').run(presId);
  assert.equal(
    app.db.prepare('SELECT COUNT(*) AS n FROM prescription_targets WHERE prescription_id = ?').get(presId).n,
    0
  );
});

test('POST /api/prescriptions/import — sweep records the session-duration sum on stale workouts', async () => {
  const routineName = nextId('SweepDurationRoutine');
  const templateName = nextId('SweepDurationTpl');
  await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-03',
      week_ends_on: '2026-08-09',
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  const r = app.db.prepare('SELECT id FROM routines WHERE name = ?').get(routineName);
  const tpl = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(templateName);
  const tplCol = app.db.prepare(`SELECT id FROM template_columns WHERE template_id = ? AND name = 'reps'`).get(tpl.id);

  const wid = '019ec999-aaaa-7000-8000-000000000010';
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid}`,
    payload: { id: wid, routine_id: r.id, started_at: Date.now(), updated_at: Date.now(), client_version: 1 },
  });
  // One child finalized with a recorded duration, one left as an open draft.
  const sidDone = '019ec999-bbbb-7000-8000-000000000010';
  const sidOpen = '019ec999-bbbb-7000-8000-000000000011';
  for (const sid of [sidDone, sidOpen]) {
    await app.inject({
      method: 'PATCH', url: `/api/drafts/${sid}`,
      payload: {
        id: sid, template_id: tpl.id, workout_id: wid,
        started_at: Date.now(), updated_at: Date.now(), client_version: 1,
        values: [{ row_index: 0, column_id: tplCol.id, value_num: 7 }],
      },
    });
  }
  await app.inject({
    method: 'POST', url: `/api/sessions/${sidDone}/finalize`,
    payload: { client_version: 1, duration_seconds: 80 },
  });

  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-10',
      week_ends_on: '2026-08-16',
      finalize_pending: true,
      days: [{ routine_name: routineName, exercises: [sampleStandardExercise(templateName)] }],
    },
  });
  assert.equal(res.statusCode, 201, res.body);

  const row = app.db.prepare('SELECT finalized_at, duration_seconds FROM workouts WHERE id = ?').get(wid);
  assert.ok(row.finalized_at != null, 'swept workout should be finalized');
  assert.equal(row.duration_seconds, 80, 'swept workout total should sum recorded child durations');
});

// ---- rows_per_rest (chained work rows before one rest: suitcase carry L/R = 2) ----

test('migration 013: prescription_exercises gains nullable rows_per_rest', () => {
  const cols = app.db.prepare('PRAGMA table_info(prescription_exercises)').all();
  const col = cols.find(c => c.name === 'rows_per_rest');
  assert.ok(col, 'rows_per_rest column must exist');
  assert.equal(col.notnull, 0, 'rows_per_rest must be nullable');
});

test('POST /api/prescriptions/import — rows_per_rest lands and returns on /active', async () => {
  const routineName = nextId('ChainRoutine');
  const carry = nextId('ChainCarry');
  const plank = nextId('ChainPlank');
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-24',
      week_ends_on: '2026-08-30',
      days: [
        {
          routine_name: routineName,
          exercises: [
            { ...sampleStandardExercise(carry), rest_seconds: 90, rows_per_rest: 2 },
            { ...sampleStandardExercise(plank), rest_seconds: 60 },
          ],
        },
      ],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const presId = res.json().prescriptions[0].id;
  const routineId = res.json().prescriptions[0].routine_id;
  const tCarry = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(carry);
  const tPlank = app.db.prepare('SELECT id FROM templates WHERE name = ?').get(plank);
  const rows = app.db.prepare(
    'SELECT template_id, rest_seconds, rows_per_rest FROM prescription_exercises WHERE prescription_id = ? ORDER BY template_id'
  ).all(presId);
  assert.deepEqual(rows, [
    { template_id: tCarry.id, rest_seconds: 90, rows_per_rest: 2 },
    { template_id: tPlank.id, rest_seconds: 60, rows_per_rest: null },
  ]);

  const active = await app.inject({ url: `/api/prescriptions/active?routine_id=${routineId}` });
  assert.equal(active.statusCode, 200);
  const exercises = active.json().exercises;
  assert.deepEqual(exercises, [
    { template_id: tCarry.id, rest_seconds: 90, rows_per_rest: 2 },
    { template_id: tPlank.id, rest_seconds: 60, rows_per_rest: null },
  ]);
});

test('POST /api/prescriptions/import — rows_per_rest without rest_seconds still stored', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: '2026-08-24',
      week_ends_on: '2026-08-30',
      days: [
        {
          routine_name: nextId('ChainOnlyRoutine'),
          exercises: [{ ...sampleStandardExercise(nextId('ChainOnlyTpl')), rows_per_rest: 3 }],
        },
      ],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const rows = app.db.prepare(
    'SELECT rest_seconds, rows_per_rest FROM prescription_exercises WHERE prescription_id = ?'
  ).all(res.json().prescriptions[0].id);
  assert.deepEqual(rows, [{ rest_seconds: null, rows_per_rest: 3 }]);
});

test('POST /api/prescriptions/import — invalid rows_per_rest rejected with 400', async () => {
  for (const bad of [0, 17, 1.5, 'two']) {
    const res = await app.inject({
      method: 'POST', url: '/api/prescriptions/import',
      payload: {
        week_starts_on: '2026-08-24',
        week_ends_on: '2026-08-30',
        days: [
          {
            routine_name: nextId('BadChainRoutine'),
            exercises: [{ ...sampleStandardExercise(nextId('BadChainTpl')), rows_per_rest: bad }],
          },
        ],
      },
    });
    assert.equal(res.statusCode, 400, `rows_per_rest ${JSON.stringify(bad)} should be rejected`);
  }
});
