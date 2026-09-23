import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localISODate } from './local-date.js';

// Built with the local-time Date constructor, so the expectation holds in
// whatever TZ the tests run in: the phone's calendar day, never UTC's.
test('localISODate is the local calendar date of a timestamp, zero-padded', () => {
  assert.equal(localISODate(new Date(2026, 8, 20, 23, 59).getTime()), '2026-09-20');
  assert.equal(localISODate(new Date(2026, 0, 5, 0, 1).getTime()), '2026-01-05');
});
