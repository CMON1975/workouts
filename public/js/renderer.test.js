import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastRecordHint, describeAge, describeLogEntry, logDeletePrompt, targetHintText, targetValueText,
} from './renderer.js';

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
  // Checkbox templates pass done / not done as the value.
  assert.equal(
    lastRecordHint('not done', at(2026, 8, 21), at(2026, 8, 28)),
    'last: not done · 7 days ago',
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

// ---- describeAge (the "Last session:" header) ----

test('describeAge uses singular units', () => {
  assert.equal(describeAge(at(2026, 8, 21), at(2026, 8, 28)), '1 week ago');
  assert.equal(describeAge(at(2026, 7, 29), at(2026, 8, 28)), '1 month ago');
  assert.equal(describeAge(at(2025, 8, 28), at(2026, 8, 28)), '1 year ago');
});

test('describeAge keeps plural units plural', () => {
  assert.equal(describeAge(at(2026, 8, 14), at(2026, 8, 28)), '2 weeks ago');
  assert.equal(describeAge(at(2026, 6, 28), at(2026, 8, 28)), '2 months ago');
  assert.equal(describeAge(at(2024, 8, 20), at(2026, 8, 28)), '2 years ago');
  assert.equal(describeAge(at(2026, 8, 25), at(2026, 8, 28)), '3 days ago');
});

test('describeAge counts calendar days like the per-cell hints', () => {
  // Same-form consistency: the header and the cell ages derive from the same
  // finalized_at and must never disagree across a midnight or an early check.
  assert.equal(describeAge(at(2026, 8, 27, 19), at(2026, 8, 28, 9)), 'yesterday');
  assert.equal(describeAge(at(2026, 8, 21, 11), at(2026, 8, 28, 9)), '1 week ago');
  assert.equal(describeAge(at(2026, 8, 28, 7), at(2026, 8, 28, 21)), 'today');
});

// ---- describeLogEntry (the Log history rows) ----

test('describeLogEntry maps metric keys to the labels the quick-log menu shows', () => {
  assert.equal(describeLogEntry({ metric: 'body_weight', value: '102.0', date: '2026-09-16' }).label, 'weight');
  assert.equal(describeLogEntry({ metric: 'resting_hr', value: '58', date: '2026-09-16' }).label, 'resting HR');
  assert.equal(describeLogEntry({ metric: 'blood_pressure', value: '120/80', date: '2026-09-16' }).label, 'blood pressure');
  assert.equal(describeLogEntry({ metric: 'food', value: 'a bag of chips', date: '2026-09-16' }).label, 'food');
  // Unknown keys (a future enum addition before the client catches up) fall back to the raw key.
  assert.equal(describeLogEntry({ metric: 'sleep', value: '7', date: '2026-09-16' }).label, 'sleep');
});

test('describeLogEntry formats the YYYY-MM-DD date as a local calendar day, not UTC midnight', () => {
  // new Date('2026-09-16') is UTC midnight, which is still Sep 15 west of
  // Greenwich; the row's date must come out as the day that was typed.
  const { date } = describeLogEntry({ metric: 'waist', value: '90', date: '2026-09-16' });
  assert.match(date, /Sep 16/);
  assert.match(date, /Wed/);
});

test('describeLogEntry passes the value through untouched', () => {
  assert.equal(describeLogEntry({ metric: 'food', value: '300g potato chips', date: '2026-09-16' }).value, '300g potato chips');
});

test('logDeletePrompt names the entry the swipe is about to remove', () => {
  assert.equal(
    logDeletePrompt({ metric: 'body_weight', value: '182', date: '2026-08-31' }),
    'Delete the weight entry "182" on Mon, Aug 31? This cannot be undone.',
  );
});

// target_kind (HANDOFF 2026-09-22): a cap or ceiling is an upper bound, not a
// goal, so the hint says so instead of reading like a number to hit.
test('targetHintText words exact targets as before and bounds as ≤ with their kind', () => {
  assert.equal(targetHintText(8, {}), 'target: 8');
  assert.equal(targetHintText(8, { target_kind: 'exact', cue: 'RPE 7' }), 'target: 8 (RPE 7)');
  assert.equal(targetHintText(12, { target_kind: 'cap' }), 'cap: ≤ 12');
  assert.equal(targetHintText(12, { target_kind: 'cap', cue: 'CAP' }), 'cap: ≤ 12 (CAP)');
  assert.equal(targetHintText(140, { target_kind: 'ceiling' }), 'ceiling: ≤ 140');
});

test('targetValueText prefixes ≤ on bounds for the routine preview', () => {
  assert.equal(targetValueText('8', undefined), '8');
  assert.equal(targetValueText('8', 'exact'), '8');
  assert.equal(targetValueText('12', 'cap'), '≤ 12');
  assert.equal(targetValueText('140', 'ceiling'), '≤ 140');
});
