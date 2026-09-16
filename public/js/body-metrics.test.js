import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveBodyMetric, editingHint, previousReading, jumpWarning, needsJumpCheck } from './body-metrics.js';

function fakeApi() {
  const calls = [];
  return {
    calls,
    createBodyMetric: async (body) => { calls.push(['POST', body]); return { id: 9, ...body }; },
    updateBodyMetric: async (id, body) => { calls.push(['PATCH', id, body]); return { id, ...body }; },
  };
}

test('saveBodyMetric POSTs a new row when nothing is being edited', async () => {
  const api = fakeApi();
  const row = await saveBodyMetric(api, { editingId: null, date: '2026-09-16', metric: 'body_weight', value: '101.4' });
  assert.deepEqual(api.calls, [['POST', { date: '2026-09-16', metric: 'body_weight', value: '101.4' }]]);
  assert.equal(row.id, 9);
});

test('saveBodyMetric PATCHes the row being edited instead of creating a second one', async () => {
  const api = fakeApi();
  const row = await saveBodyMetric(api, { editingId: 170, date: '2026-08-31', metric: 'body_weight', value: '102.0' });
  assert.deepEqual(api.calls, [['PATCH', 170, { date: '2026-08-31', metric: 'body_weight', value: '102.0' }]]);
  assert.equal(row.id, 170);
});

test('editingHint names the row loaded into the form', () => {
  assert.equal(
    editingHint({ metric: 'body_weight', value: '182', date: '2026-08-31' }),
    'Editing weight "182" from Mon, Aug 31',
  );
});

// ---- >10% jump guard ----

const rows = [
  { id: 4, metric: 'body_weight', value: '101.0', date: '2026-09-15' },
  { id: 3, metric: 'body_weight', value: '182',   date: '2026-08-31' },
  { id: 2, metric: 'body_weight', value: '102.4', date: '2026-08-30' },
  { id: 1, metric: 'body_weight', value: '103.0', date: '2026-08-24' },
];

test('previousReading picks the latest row on or before the entry date', () => {
  assert.equal(previousReading(rows, { date: '2026-09-16' }).id, 4);
  assert.equal(previousReading(rows, { date: '2026-08-31' }).id, 3); // same day counts
  assert.equal(previousReading(rows, { date: '2026-08-25' }).id, 1);
});

test('previousReading skips the row being edited so a fix compares to its neighbour', () => {
  assert.equal(previousReading(rows, { date: '2026-08-31', excludeId: 3 }).id, 2);
});

test('previousReading falls back to the earliest later row, and null with nothing to compare', () => {
  assert.equal(previousReading(rows, { date: '2026-08-01' }).id, 1);
  assert.equal(previousReading([], { date: '2026-08-01' }), null);
});

test('jumpWarning fires only past 10% either way and names the last reading', () => {
  const prev = { metric: 'body_weight', value: '102.0', date: '2026-08-31' };
  assert.equal(jumpWarning('body_weight', '182', prev),
    'weight 182 is 78% above the last reading (102.0 on Mon, Aug 31). Log it anyway?');
  assert.equal(jumpWarning('body_weight', '90', prev),
    'weight 90 is 12% below the last reading (102.0 on Mon, Aug 31). Log it anyway?');
  assert.equal(jumpWarning('body_weight', '112.2', prev), null); // exactly 10%: no prompt
  assert.equal(jumpWarning('body_weight', '101.4', prev), null);
});

test('jumpWarning stays quiet for free-text metrics, unparseable values, and no history', () => {
  assert.equal(jumpWarning('food', 'a bag of chips', { metric: 'food', value: 'toast', date: '2026-09-15' }), null);
  assert.equal(jumpWarning('blood_pressure', '160/100', { metric: 'blood_pressure', value: '120/80', date: '2026-09-15' }), null);
  assert.equal(jumpWarning('body_weight', 'abc', { metric: 'body_weight', value: '102.0', date: '2026-09-15' }), null);
  assert.equal(jumpWarning('body_weight', '102', { metric: 'body_weight', value: 'n/a', date: '2026-09-15' }), null);
  assert.equal(jumpWarning('body_weight', '102', null), null);
});

test('needsJumpCheck is true only for the numeric metrics (skips the history fetch otherwise)', () => {
  assert.equal(needsJumpCheck('body_weight'), true);
  assert.equal(needsJumpCheck('waist'), true);
  assert.equal(needsJumpCheck('resting_hr'), true);
  assert.equal(needsJumpCheck('food'), false);
  assert.equal(needsJumpCheck('blood_pressure'), false);
});
