import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../index.js';

// Each test gets a fresh DB: the endpoint aggregates everything in it.
let app;
let tmpDir;
beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-stats-'));
  app = await buildApp({ dbPath: join(tmpDir, 'test.db'), logger: false });
});
afterEach(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const sid = (n) => `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const wid = (n) => `019f0000-0001-7000-8000-${String(n).padStart(12, '0')}`;
const LIFT = [{ name: 'reps', unit: null, value_type: 'text' }, { name: 'weight', unit: 'lb', value_type: 'text' }];

async function importWeek(starts, ends, exercises, extra = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/prescriptions/import',
    payload: {
      week_starts_on: starts, week_ends_on: ends, ...extra,
      days: [{ routine_name: 'Mon', exercises: exercises.map(([template_name, columns]) => ({ template_name, columns, default_rows: 3, rows_fixed: 1, targets: [] })) }],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
}

const tpl = (name) => app.db.prepare('SELECT id FROM templates WHERE name = ?').get(name).id;
const colId = (name, col) => app.db.prepare('SELECT id FROM template_columns WHERE template_id = ? AND name = ?').get(tpl(name), col).id;

async function draft(id, name, rows, { startedAt = Date.now(), workoutId = null } = {}) {
  const values = [];
  rows.forEach((row, row_index) => {
    for (const [col, text] of Object.entries(row)) values.push({ row_index, column_id: colId(name, col), value_text: text });
  });
  const res = await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`,
    payload: { id, template_id: tpl(name), started_at: startedAt, updated_at: startedAt, client_version: 1, values, ...(workoutId ? { workout_id: workoutId } : {}) },
  });
  assert.equal(res.statusCode, 200, res.body);
}

async function finalize(id, durationSeconds = null) {
  const res = await app.inject({
    method: 'POST', url: `/api/sessions/${id}/finalize`,
    payload: { client_version: 1, ...(durationSeconds != null ? { duration_seconds: durationSeconds } : {}) },
  });
  assert.equal(res.statusCode, 200, res.body);
}

const stats = async (qs = '') => {
  const res = await app.inject({ method: 'GET', url: `/api/stats${qs}` });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};

test('GET /api/stats on an empty DB lists nothing and states its assumptions', async () => {
  const body = await stats();
  assert.deepEqual(body.sessions, []);
  assert.deepEqual(body.templates, []);
  assert.equal(body.assumptions.handle.lb_per_db, 4.5);
  assert.equal(body.assumptions.carry_steps_per_minute, 100);
});

test('GET /api/stats derives one finished session', async () => {
  await importWeek('2026-09-28', '2026-10-04', [['DB floor press A', LIFT]]);
  await app.inject({ method: 'POST', url: '/api/body-metrics', payload: { date: '2026-09-01', metric: 'body_weight', value: '101' } });
  await draft(sid(1), 'DB floor press A', [{ reps: '5', weight: '34.5' }, { reps: '5', weight: '34.5' }]);
  await finalize(sid(1), 400);

  const { sessions, templates } = await stats();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, sid(1));
  assert.equal(s.category, 'strength');
  assert.equal(s.sets, 2);
  assert.equal(s.reps, 10);
  assert.equal(s.lifted_lb, 34.5 * 2 * 10);
  assert.equal(s.seconds, 400);
  assert.equal(s.time_source, 'stopwatch');
  assert.equal(s.bw_kg, 101);
  assert.equal(s.bw_source, 'logged');
  assert.equal(s.kcal_basis, 'met');
  assert.ok(s.kcal > 0);
  assert.deepEqual(templates.map((t) => [t.name, t.rule, t.dbs]), [['DB floor press A', 'floor_press', 2]]);
});

test('GET /api/stats leaves out drafts and finished sessions with nothing in them', async () => {
  await importWeek('2026-09-28', '2026-10-04', [['DB floor press A', LIFT]]);
  await draft(sid(2), 'DB floor press A', [{ reps: '5', weight: '34.5' }]);
  await draft(sid(3), 'DB floor press A', []);
  await finalize(sid(3));
  assert.deepEqual((await stats()).sessions, []);
});

test('GET /api/stats corrects pre-handle logs by the client\'s calendar day', async () => {
  await importWeek('2026-07-13', '2026-07-19', [['DB floor press A', LIFT]]);
  // 2026-07-19 23:30 in Pacific daylight time is the 20th in UTC
  await draft(sid(4), 'DB floor press A', [{ reps: '6', weight: '25.5' }], { startedAt: Date.UTC(2026, 6, 20, 6, 30) });
  await finalize(sid(4));
  const pacific = (await stats('?tz_offset=420')).sessions[0];
  assert.equal(pacific.corrected, 1);
  assert.equal(pacific.lifted_lb, (25.5 - 4.5) * 2 * 6);
  const utc = (await stats('?tz_offset=0')).sessions[0];
  assert.equal(utc.corrected, 0);
});

test('GET /api/stats does not time swept sessions by the sweep\'s stamp', async () => {
  await importWeek('2026-09-21', '2026-09-27', [['DB floor press A', LIFT], ['DB overhead press', LIFT]]);
  const routineId = app.db.prepare("SELECT id FROM routines WHERE name = 'Mon'").get().id;
  const started = Date.now() - 20 * 60_000;
  await app.inject({
    method: 'PATCH', url: `/api/workouts/${wid(1)}`,
    payload: { id: wid(1), routine_id: routineId, started_at: started, updated_at: started, client_version: 1 },
  });
  await draft(sid(5), 'DB floor press A', [{ reps: '5', weight: '34.5' }], { startedAt: started, workoutId: wid(1) });
  await draft(sid(6), 'DB overhead press', [{ reps: '6', weight: '19.5' }], { startedAt: started + 600_000, workoutId: wid(1) });
  await importWeek('2026-09-28', '2026-10-04', [['DB floor press A', LIFT], ['DB overhead press', LIFT]], { finalize_pending: true });

  const { sessions } = await stats();
  assert.equal(sessions.length, 2);
  for (const s of sessions) assert.notEqual(s.time_source, 'span', s.id);
});

test('GET /api/stats returns body weight and waist series, last entry per day', async () => {
  const log = (date, metric, value) => app.inject({ method: 'POST', url: '/api/body-metrics', payload: { date, metric, value } });
  // a typo corrected the same day: the later entry wins
  await log('2026-09-01', 'body_weight', '182');
  await log('2026-09-01', 'body_weight', '102.0');
  await log('2026-09-03', 'body_weight', '100.4 kg');
  await log('2026-09-02', 'body_weight', 'forgot');
  await log('2026-09-01', 'waist', '43.5');
  await log('2026-09-08', 'waist', '110 cm');
  await log('2026-09-02', 'food', 'clean');
  await importWeek('2026-08-31', '2026-09-06', [['DB floor press A', LIFT]]);
  await draft(sid(7), 'DB floor press A', [{ reps: '5', weight: '34.5' }], { startedAt: new Date(2026, 8, 2, 12).getTime() });
  await finalize(sid(7));

  const { body, sessions } = await stats(`?tz_offset=${new Date(2026, 8, 2).getTimezoneOffset()}`);
  assert.deepEqual(body.weight, [{ date: '2026-09-01', kg: 102 }, { date: '2026-09-03', kg: 100.4 }]);
  assert.deepEqual(body.waist.map((w) => [w.date, Math.round(w.in * 100) / 100]), [['2026-09-01', 43.5], ['2026-09-08', 43.31]]);
  // energy uses the corrected reading too
  assert.equal(sessions[0].bw_kg, 102);
});

test('GET /api/stats rejects a bad tz_offset', async () => {
  for (const qs of ['?tz_offset=abc', '?tz_offset=9999']) {
    const res = await app.inject({ method: 'GET', url: `/api/stats${qs}` });
    assert.equal(res.statusCode, 400, qs);
  }
});
