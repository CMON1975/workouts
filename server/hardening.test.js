import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcrypt';
import { buildApp } from './index.js';

let app;
let tmpDir;
let dbPath;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workouts-harden-test-'));
  dbPath = join(tmpDir, 'test.db');
  const hash = await bcrypt.hash('hunter2', 4);
  app = await buildApp({
    dbPath,
    passwordHash: hash,
    sessionSecret: 'a'.repeat(64),
    isProd: false,
    logger: false,
  });
  await app.ready();
});

after(async () => {
  await app?.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

test('/api/login rate limit: 11th attempt from the same IP is 429', async () => {
  const headers = { 'x-forwarded-for': '10.0.0.1' };
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/login', headers,
      payload: { password: 'wrong' },
    });
    assert.equal(res.statusCode, 401, `attempt ${i + 1} should be 401, got ${res.statusCode}`);
  }
  const blocked = await app.inject({
    method: 'POST', url: '/api/login', headers,
    payload: { password: 'wrong' },
  });
  assert.equal(blocked.statusCode, 429, 'the 11th attempt must be rate-limited');
});

test('trustProxy: a request from a different X-Forwarded-For gets a fresh bucket', async () => {
  // The previous test exhausted the bucket for 10.0.0.1. A different XFF
  // must not inherit that exhaustion — that's what trustProxy+per-IP keying
  // buys us. If this returned 429, rate-limit would be keyed globally, not
  // per-client, which is what we're guarding against.
  const res = await app.inject({
    method: 'POST', url: '/api/login',
    headers: { 'x-forwarded-for': '10.0.0.2' },
    payload: { password: 'wrong' },
  });
  assert.equal(res.statusCode, 401, 'different IP must not see the previous IP cap');
});
