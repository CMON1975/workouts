import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate } from './dates.js';

test('localDate reads the calendar day in the client timezone', () => {
  // 2026-07-19 23:30 PDT is already the 20th in UTC
  const ms = Date.UTC(2026, 6, 20, 6, 30);
  assert.equal(localDate(ms, 420), '2026-07-19');
  assert.equal(localDate(ms, 0), '2026-07-20');
  // east of UTC (offset is negative there)
  assert.equal(localDate(Date.UTC(2026, 6, 19, 20, 0), -300), '2026-07-20');
});
