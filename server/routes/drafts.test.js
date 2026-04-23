import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcrypt';
import { buildApp } from '../index.js';

const PASSWORD = 'hunter2';
let app;
let cookie;
let tmpDir;
let dbPath;
let bicepTemplateId;
let bicepColumnId;

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { password: PASSWORD },
  });
  assert.equal(res.statusCode, 204);
  cookie = res.headers['set-cookie'];
  assert.ok(cookie, 'expected login to return a session cookie');
}

function uuidv7Fixture(n = 0) {
  // Valid static UUIDv7 for tests (version/variant bits correct).
  // 019dbaf6-6425-79fc-874e-df11ade614XX
  return `019dbaf6-6425-79fc-874e-df11ade614${String(n).padStart(2, '0')}`;
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-test-'));
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

  const t = app.db.prepare(`SELECT id FROM templates WHERE name='Bicep Curls'`).get();
  bicepTemplateId = t.id;
  const c = app.db.prepare(`SELECT id FROM template_columns WHERE template_id=?`).get(bicepTemplateId);
  bicepColumnId = c.id;

  await login();
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function draftBody(id, clientVersion, values) {
  return {
    id,
    template_id: bicepTemplateId,
    started_at: Date.now(),
    updated_at: Date.now(),
    client_version: clientVersion,
    notes: null,
    values,
  };
}

test('PATCH /api/drafts/:id requires auth', async () => {
  const id = uuidv7Fixture(1);
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/drafts/${id}`,
    payload: draftBody(id, 1, []),
  });
  assert.equal(res.statusCode, 401);
});

test('PATCH inserts a new draft with values', async () => {
  const id = uuidv7Fixture(2);
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/drafts/${id}`,
    headers: { cookie },
    payload: draftBody(id, 1, [
      { row_index: 0, column_id: bicepColumnId, value_num: 10 },
      { row_index: 1, column_id: bicepColumnId, value_num: 12 },
    ]),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.server_version, 1);

  const row = app.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  assert.equal(row.client_version, 1);
  assert.equal(row.finalized_at, null);
  const values = app.db.prepare('SELECT * FROM session_values WHERE session_id=? ORDER BY row_index').all(id);
  assert.equal(values.length, 2);
  assert.equal(values[0].value_num, 10);
  assert.equal(values[1].value_num, 12);
});

test('PATCH is idempotent on same id and replaces values', async () => {
  const id = uuidv7Fixture(3);
  const first = await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(id, 1, [{ row_index: 0, column_id: bicepColumnId, value_num: 5 }]),
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(id, 2, [
      { row_index: 0, column_id: bicepColumnId, value_num: 15 },
      { row_index: 1, column_id: bicepColumnId, value_num: 20 },
    ]),
  });
  assert.equal(second.statusCode, 200);

  const values = app.db.prepare('SELECT * FROM session_values WHERE session_id=? ORDER BY row_index').all(id);
  assert.equal(values.length, 2, 'values are replaced, not appended');
  assert.equal(values[0].value_num, 15);
});

test('PATCH with lower client_version returns 409 stale (LWW)', async () => {
  const id = uuidv7Fixture(4);
  const a = await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(id, 5, [{ row_index: 0, column_id: bicepColumnId, value_num: 10 }]),
  });
  assert.equal(a.statusCode, 200);

  const b = await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(id, 3, [{ row_index: 0, column_id: bicepColumnId, value_num: 99 }]),
  });
  assert.equal(b.statusCode, 409);
  assert.equal(b.json().server_version, 5);

  const row = app.db.prepare('SELECT client_version FROM sessions WHERE id=?').get(id);
  assert.equal(row.client_version, 5, 'server version is preserved');
  const v = app.db.prepare('SELECT value_num FROM session_values WHERE session_id=?').get(id);
  assert.equal(v.value_num, 10, 'stale write did not clobber values');
});

test('POST finalize sets finalized_at and is idempotent', async () => {
  const id = uuidv7Fixture(5);
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(id, 1, [{ row_index: 0, column_id: bicepColumnId, value_num: 7 }]),
  });

  const first = await app.inject({
    method: 'POST', url: `/api/sessions/${id}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });
  assert.equal(first.statusCode, 200);
  const finalizedAt = first.json().finalized_at;
  assert.ok(finalizedAt > 0);

  const second = await app.inject({
    method: 'POST', url: `/api/sessions/${id}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().finalized_at, finalizedAt, 'idempotent: same finalized_at');
});

test('PATCH to finalized session is a no-op', async () => {
  const id = uuidv7Fixture(6);
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(id, 1, [{ row_index: 0, column_id: bicepColumnId, value_num: 8 }]),
  });
  await app.inject({
    method: 'POST', url: `/api/sessions/${id}/finalize`, headers: { cookie },
    payload: { client_version: 1 },
  });

  const res = await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(id, 2, [{ row_index: 0, column_id: bicepColumnId, value_num: 999 }]),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().finalized, true);

  const v = app.db.prepare('SELECT value_num FROM session_values WHERE session_id=?').get(id);
  assert.equal(v.value_num, 8, 'finalized values are not mutable via draft PATCH');
});

test('GET /api/sessions/:id returns the stored values', async () => {
  const id = uuidv7Fixture(7);
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(id, 1, [
      { row_index: 0, column_id: bicepColumnId, value_num: 11 },
      { row_index: 1, column_id: bicepColumnId, value_num: 13 },
    ]),
  });

  const res = await app.inject({
    method: 'GET', url: `/api/sessions/${id}`, headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, id);
  assert.equal(body.values.length, 2);
  assert.equal(body.values[0].value_num, 11);
});

test('GET /api/templates returns seeded Bicep Curls', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/templates', headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const list = res.json();
  const bicep = list.find(t => t.name === 'Bicep Curls');
  assert.ok(bicep, 'seed template present');
  assert.equal(bicep.default_rows, 4);
  assert.equal(bicep.rows_fixed, 1);
  assert.equal(bicep.columns.length, 1);
  assert.equal(bicep.columns[0].name, 'reps');
  assert.equal(bicep.columns[0].unit, 'pounds');
});

test('login with wrong password returns 401', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/login',
    payload: { password: 'nope' },
  });
  assert.equal(res.statusCode, 401);
});

test('body id mismatch is rejected', async () => {
  const id = uuidv7Fixture(8);
  const other = uuidv7Fixture(9);
  const res = await app.inject({
    method: 'PATCH', url: `/api/drafts/${id}`, headers: { cookie },
    payload: draftBody(other, 1, []),
  });
  assert.equal(res.statusCode, 400);
});

test('GET /api/sessions requires auth', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/sessions returns newest-first with values', async () => {
  // Drain whatever earlier tests created; rely on insertion order + timestamps.
  const res = await app.inject({
    method: 'GET', url: '/api/sessions', headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const list = res.json();
  assert.ok(list.length >= 2, 'expected multiple sessions from earlier tests');
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1].finalized_at ?? list[i - 1].started_at;
    const b = list[i].finalized_at ?? list[i].started_at;
    assert.ok(a >= b, `order broken at index ${i}: ${a} < ${b}`);
  }
  for (const s of list) {
    assert.ok(Array.isArray(s.values), 'each session has values array');
  }
});

test('GET /api/sessions?finalized=true filters drafts out', async () => {
  // Create a draft that must not appear.
  const draftId = uuidv7Fixture(20);
  await app.inject({
    method: 'PATCH', url: `/api/drafts/${draftId}`, headers: { cookie },
    payload: draftBody(draftId, 1, [{ row_index: 0, column_id: bicepColumnId, value_num: 3 }]),
  });

  const res = await app.inject({
    method: 'GET', url: '/api/sessions?finalized=true', headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const ids = res.json().map(s => s.id);
  assert.ok(!ids.includes(draftId), 'draft session is excluded when finalized=true');
  for (const s of res.json()) {
    assert.ok(s.finalized_at != null, 'every row is finalized');
  }
});

test('GET /api/sessions?finalized=false returns only drafts', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/sessions?finalized=false', headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  for (const s of res.json()) {
    assert.equal(s.finalized_at, null, 'every row is a draft');
  }
});

test('GET /api/sessions?template_id=X filters by template', async () => {
  const res = await app.inject({
    method: 'GET', url: `/api/sessions?template_id=${bicepTemplateId}`, headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  const list = res.json();
  assert.ok(list.length > 0);
  for (const s of list) assert.equal(s.template_id, bicepTemplateId);
});

test('GET /api/sessions?limit=1 caps the result', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/sessions?limit=1', headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().length, 1);
});

test('GET /api/sessions?limit=0 is rejected', async () => {
  const res = await app.inject({
    method: 'GET', url: '/api/sessions?limit=0', headers: { cookie },
  });
  assert.equal(res.statusCode, 400);
});

test('malformed uuid is rejected by schema', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/drafts/not-a-uuid', headers: { cookie },
    payload: {
      id: 'not-a-uuid',
      template_id: bicepTemplateId,
      started_at: Date.now(),
      updated_at: Date.now(),
      client_version: 1,
      values: [],
    },
  });
  assert.equal(res.statusCode, 400);
});
