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
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-bm-test-'));
  dbPath = join(tmpDir, 'test.db');
  app = await buildApp({ dbPath, logger: false });
  await app.ready();
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/body-metrics creates a row and returns it', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-21', metric: 'body_weight', value: '101.2' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.ok(body.id > 0);
  assert.equal(body.date, '2026-06-21');
  assert.equal(body.metric, 'body_weight');
  assert.equal(body.value, '101.2');
  assert.ok(typeof body.created_at === 'number' && body.created_at > 0);
});

test('POST accepts a waist entry with a fractional value', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-21', metric: 'waist', value: '44 3/8' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().value, '44 3/8');
});

test('POST rejects an unknown metric', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-21', metric: 'bp_systolic', value: '118' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST rejects a malformed date', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '20260621', metric: 'body_weight', value: '101.2' },
  });
  assert.equal(res.statusCode, 400);
});

test('POST rejects an empty value', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-21', metric: 'body_weight', value: '' },
  });
  assert.equal(res.statusCode, 400);
});

test('GET /api/body-metrics lists rows newest-first by date then id', async () => {
  // Seed a few more.
  await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-19', metric: 'body_weight', value: '100.8' },
  });
  await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-20', metric: 'body_weight', value: '101.0' },
  });
  const res = await app.inject({ method: 'GET', url: '/api/body-metrics' });
  assert.equal(res.statusCode, 200);
  const rows = res.json();
  assert.ok(rows.length >= 4);
  const dates = rows.map(r => r.date);
  const sorted = dates.slice().sort().reverse();
  assert.deepEqual(dates, sorted, 'rows come back date-descending');
});

test('GET ?from filters inclusive', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/body-metrics?from=2026-06-20',
  });
  assert.equal(res.statusCode, 200);
  const dates = res.json().map(r => r.date);
  assert.ok(dates.length > 0);
  for (const d of dates) assert.ok(d >= '2026-06-20', `${d} should be >= 2026-06-20`);
});

test('GET ?to filters inclusive', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/body-metrics?to=2026-06-19',
  });
  assert.equal(res.statusCode, 200);
  const dates = res.json().map(r => r.date);
  assert.ok(dates.length > 0);
  for (const d of dates) assert.ok(d <= '2026-06-19', `${d} should be <= 2026-06-19`);
});

test('GET ?from + ?to filters to the range inclusive on both ends', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/body-metrics?from=2026-06-19&to=2026-06-20',
  });
  assert.equal(res.statusCode, 200);
  const dates = res.json().map(r => r.date);
  assert.ok(dates.length > 0);
  for (const d of dates) {
    assert.ok(d >= '2026-06-19' && d <= '2026-06-20', `${d} out of range`);
  }
});

test('GET ?metric filters to one metric', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/body-metrics?metric=waist',
  });
  assert.equal(res.statusCode, 200);
  const rows = res.json();
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.metric, 'waist');
});

test('GET ?metric rejects an unknown metric value', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/body-metrics?metric=bp_systolic',
  });
  assert.equal(res.statusCode, 400);
});

test('POST accepts a food entry with a long free-text value', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-28', metric: 'food', value: '1 medium extra cheese papa john\'s pizza' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.metric, 'food');
  assert.equal(body.value, '1 medium extra cheese papa john\'s pizza');
});

test('POST rejects a food value longer than 500 chars', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-28', metric: 'food', value: 'x'.repeat(501) },
  });
  assert.equal(res.statusCode, 400);
});

test('POST accepts a resting_hr entry', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-08-03', metric: 'resting_hr', value: '72' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.metric, 'resting_hr');
  assert.equal(body.value, '72');
});

test('GET ?metric=resting_hr filters to resting_hr rows', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/body-metrics?metric=resting_hr',
  });
  assert.equal(res.statusCode, 200);
  const rows = res.json();
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.metric, 'resting_hr');
});

test('POST accepts a blood_pressure entry in systolic/diastolic form', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-08-03', metric: 'blood_pressure', value: '120/80' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.metric, 'blood_pressure');
  assert.equal(body.value, '120/80');
});

test('multiple food entries on the same date coexist (no clobber)', async () => {
  await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-27', metric: 'food', value: '300g lay\'s bacon potato chips' },
  });
  await app.inject({
    method: 'POST', url: '/api/body-metrics',
    payload: { date: '2026-06-27', metric: 'food', value: '2 beers' },
  });
  const res = await app.inject({
    method: 'GET', url: '/api/body-metrics?metric=food&from=2026-06-27&to=2026-06-27',
  });
  assert.equal(res.statusCode, 200);
  const rows = res.json();
  assert.equal(rows.length, 2, 'both same-day food entries persist');
  for (const r of rows) assert.equal(r.metric, 'food');
});

// ---- Edit / delete (HANDOFF 2026-09-06 row 170, 2026-09-13 row 187) ----

async function create(payload) {
  const res = await app.inject({ method: 'POST', url: '/api/body-metrics', payload });
  assert.equal(res.statusCode, 201);
  return res.json();
}

test('PATCH /api/body-metrics/:id updates the value and returns the row', async () => {
  const row = await create({ date: '2026-08-31', metric: 'body_weight', value: '182' });
  const res = await app.inject({
    method: 'PATCH', url: `/api/body-metrics/${row.id}`, payload: { value: '102.0' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ...row, value: '102.0' });
  const list = await app.inject({ method: 'GET', url: '/api/body-metrics?from=2026-08-31&to=2026-08-31' });
  assert.equal(list.json().find(r => r.id === row.id).value, '102.0');
});

test('PATCH can move a row to another date or metric', async () => {
  const row = await create({ date: '2026-09-08', metric: 'food', value: 'a bag of' });
  const res = await app.inject({
    method: 'PATCH', url: `/api/body-metrics/${row.id}`,
    payload: { date: '2026-09-09', metric: 'food', value: 'a bag of gummy nerds' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().date, '2026-09-09');
  assert.equal(res.json().value, 'a bag of gummy nerds');
});

test('PATCH rejects an unknown id, an empty body, a blank value, and an unknown metric', async () => {
  const row = await create({ date: '2026-09-01', metric: 'waist', value: '99' });
  const cases = [
    [`/api/body-metrics/999999`, { value: '1' }, 404],
    [`/api/body-metrics/${row.id}`, {}, 400],
    [`/api/body-metrics/${row.id}`, { value: '   ' }, 400],
    [`/api/body-metrics/${row.id}`, { metric: 'shoe_size' }, 400],
    [`/api/body-metrics/not-a-number`, { value: '1' }, 400],
  ];
  for (const [url, payload, status] of cases) {
    const res = await app.inject({ method: 'PATCH', url, payload });
    assert.equal(res.statusCode, status, `${url} ${JSON.stringify(payload)}`);
  }
  const unchanged = await app.inject({ method: 'GET', url: '/api/body-metrics?metric=waist&from=2026-09-01&to=2026-09-01' });
  assert.equal(unchanged.json().find(r => r.id === row.id).value, '99');
});

test('PATCH strips unknown fields (Fastify default), same as POST', async () => {
  const row = await create({ date: '2026-09-03', metric: 'waist', value: '98' });
  const res = await app.inject({
    method: 'PATCH', url: `/api/body-metrics/${row.id}`, payload: { value: '97', extra: true },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ...row, value: '97' });
});

test('DELETE /api/body-metrics/:id removes the row; a second delete is 404', async () => {
  const row = await create({ date: '2026-09-02', metric: 'resting_hr', value: '58' });
  let res = await app.inject({ method: 'DELETE', url: `/api/body-metrics/${row.id}` });
  assert.equal(res.statusCode, 204);
  const list = await app.inject({ method: 'GET', url: '/api/body-metrics?metric=resting_hr' });
  assert.equal(list.json().some(r => r.id === row.id), false);
  res = await app.inject({ method: 'DELETE', url: `/api/body-metrics/${row.id}` });
  assert.equal(res.statusCode, 404);
  res = await app.inject({ method: 'DELETE', url: '/api/body-metrics/not-a-number' });
  assert.equal(res.statusCode, 400);
});
