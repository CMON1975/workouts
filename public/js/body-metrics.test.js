import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveBodyMetric, editingHint } from './body-metrics.js';

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
