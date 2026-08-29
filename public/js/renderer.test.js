import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastRecordHint } from './renderer.js';

// Timestamps built via the local-time Date constructor so the expected
// calendar-day gaps hold in any TZ the tests run in.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('lastRecordHint appends the age in days to the last record', () => {
  assert.equal(
    lastRecordHint(12, at(2026, 8, 21), at(2026, 8, 28)),
    'last: 12 · 7 days ago',
  );
  assert.equal(
    lastRecordHint('8/side', at(2026, 8, 14), at(2026, 8, 28)),
    'last: 8/side · 14 days ago',
  );
});

test('lastRecordHint counts calendar days, not 24h buckets', () => {
  // Evening session then next-morning check: under a day elapsed, but it
  // was yesterday — a workout app cares about the day grid, not hours.
  assert.equal(
    lastRecordHint(12, at(2026, 8, 27, 19), at(2026, 8, 28, 9)),
    'last: 12 · 1 day ago',
  );
  // 7×24h minus a few hours is still "7 days ago" for a weekly exercise.
  assert.equal(
    lastRecordHint(12, at(2026, 8, 21, 11), at(2026, 8, 28, 9)),
    'last: 12 · 7 days ago',
  );
});

test('lastRecordHint says today for a same-day record', () => {
  assert.equal(
    lastRecordHint(12, at(2026, 8, 28, 7), at(2026, 8, 28, 21)),
    'last: 12 · today',
  );
});

test('lastRecordHint degrades to the bare value without a finalize time', () => {
  assert.equal(lastRecordHint(12, null, at(2026, 8, 28)), 'last: 12');
  assert.equal(lastRecordHint(12, undefined, at(2026, 8, 28)), 'last: 12');
});
