import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankPrescribedRows } from './completeness.js';

const template = { id: 7, columns: [{ id: 70, name: 'reps' }, { id: 71, name: 'weight' }] };
const prescribed = {
  targets: [0, 1, 2].flatMap(r => [
    { template_id: 7, row_index: r, column_name: 'reps', target_num: 8 },
    { template_id: 7, row_index: r, column_name: 'weight', target_num: 20 },
  ]).concat([{ template_id: 8, row_index: 5, column_name: 'time', target_num: 45 }]),
};
const v = (row, col, num, text = null) => ({ row_index: row, column_id: col, value_num: num, value_text: text });

test('rows the prescription covers that hold no value are blank', () => {
  const draft = { values: [v(0, 70, 8), v(0, 71, 20), v(1, 70, 8)] };
  assert.deepEqual(blankPrescribedRows({ draft, template, prescribed }), [2]);
});

test('a row with any non-empty value counts as entered; empty strings and nulls do not', () => {
  const draft = { values: [v(0, 70, null, ''), v(1, 71, null, 'x'), v(2, 70, 0)] };
  assert.deepEqual(blankPrescribedRows({ draft, template, prescribed }), [0]);
});

test('rows beyond the prescription and other templates are ignored', () => {
  const draft = { values: [v(0, 70, 8), v(1, 70, 8), v(2, 70, 8), v(3, 70, null)] };
  assert.deepEqual(blankPrescribedRows({ draft, template, prescribed }), []);
});

test('no prescription, or none for this template, means nothing is blank', () => {
  const draft = { values: [] };
  assert.deepEqual(blankPrescribedRows({ draft, template, prescribed: null }), []);
  assert.deepEqual(blankPrescribedRows({ draft, template, prescribed: { targets: [] } }), []);
  assert.deepEqual(blankPrescribedRows({ draft, template: { id: 99 }, prescribed }), []);
});
