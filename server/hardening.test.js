import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './index.js';

let app;
let tmpDir;
let dbPath;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-harden-test-'));
  dbPath = join(tmpDir, 'test.db');
  app = await buildApp({ dbPath, isProd: false, logger: false });
  await app.ready();
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('routes are reachable without any session cookie (tailnet is the auth boundary)', async () => {
  // No /api/login exists; routes do not gate on a session cookie.
  // Reachability is enforced one layer up — Apache binds the vhost to the
  // tailscale IP only.
  const res = await app.inject({ method: 'GET', url: '/api/templates' });
  assert.equal(res.statusCode, 200);
});

test('global rate limit still trips on a normal route', async () => {
  // 300/min global cap. Hammer one route from a single XFF until 429.
  const headers = { 'x-forwarded-for': '10.0.0.50' };
  let saw429 = false;
  for (let i = 0; i < 305; i++) {
    const res = await app.inject({ method: 'GET', url: '/api/templates', headers });
    if (res.statusCode === 429) { saw429 = true; break; }
    assert.equal(res.statusCode, 200, `attempt ${i + 1} unexpected status ${res.statusCode}`);
  }
  assert.ok(saw429, 'expected at least one 429 within 305 requests');
});

test('trustProxy: a different X-Forwarded-For gets a fresh bucket', async () => {
  // After the previous test exhausted 10.0.0.50, a different XFF must not
  // inherit that exhaustion — that's what trustProxy + per-IP keying buys us.
  const res = await app.inject({
    method: 'GET', url: '/api/templates',
    headers: { 'x-forwarded-for': '10.0.0.51' },
  });
  assert.equal(res.statusCode, 200, 'different IP must not see the previous IP cap');
});
