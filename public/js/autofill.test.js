import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWeightColumn, planWeightAutofill } from './autofill.js';

const REPS = { id: 13, name: 'reps', value_type: 'text' };
const WEIGHT = { id: 14, name: 'weight', value_type: 'text' };

function tpl(overrides = {}) {
  return { id: 9, kind: 'standard', columns: [REPS, WEIGHT], ...overrides };
}

function target(row_index, extra = {}) {
  return {
    template_id: 9, row_index, column_id: WEIGHT.id,
    target_num: 25, target_text: null, ...extra,
  };
}

test('isWeightColumn matches by name, case-insensitive', () => {
  assert.equal(isWeightColumn(WEIGHT), true);
  assert.equal(isWeightColumn({ name: 'Weight ' }), true);
  assert.equal(isWeightColumn(REPS), false);
  assert.equal(isWeightColumn({}), false);
  assert.equal(isWeightColumn(null), false);
});

test('fills each weight cell from its prescription target', () => {
  const prescribed = { targets: [target(0), target(1), target(2)] };
  const plan = planWeightAutofill({ template: tpl(), prescribed, rows: 3, userValues: new Map() });
  assert.deepEqual(plan, [
    { row_index: 0, column_id: WEIGHT.id, value: '25' },
    { row_index: 1, column_id: WEIGHT.id, value: '25' },
    { row_index: 2, column_id: WEIGHT.id, value: '25' },
  ]);
});

test('never plans non-weight columns', () => {
  const prescribed = {
    targets: [target(0), { template_id: 9, row_index: 0, column_id: REPS.id, target_num: 8, target_text: null }],
  };
  const plan = planWeightAutofill({ template: tpl(), prescribed, rows: 1, userValues: new Map() });
  assert.deepEqual(plan.map(c => c.column_id), [WEIGHT.id]);
});

test('rows beyond the prescription carry the last value forward', () => {
  const prescribed = { targets: [target(0), target(1), target(2)] };
  const plan = planWeightAutofill({ template: tpl(), prescribed, rows: 4, userValues: new Map() });
  assert.deepEqual(plan[3], { row_index: 3, column_id: WEIGHT.id, value: '25' });
});

test('falls back to the previous row typed value when no target exists', () => {
  const userValues = new Map([[`0:${WEIGHT.id}`, '20']]);
  const plan = planWeightAutofill({ template: tpl(), prescribed: null, rows: 3, userValues });
  assert.deepEqual(plan, [
    { row_index: 1, column_id: WEIGHT.id, value: '20' },
    { row_index: 2, column_id: WEIGHT.id, value: '20' },
  ]);
});

test('user-owned cells are excluded and anchor the carry', () => {
  const userValues = new Map([[`1:${WEIGHT.id}`, '30']]);
  const plan = planWeightAutofill({ template: tpl(), prescribed: null, rows: 3, userValues });
  assert.deepEqual(plan, [
    { row_index: 0, column_id: WEIGHT.id, value: '' },
    { row_index: 2, column_id: WEIGHT.id, value: '30' },
  ]);
});

test('a target beats the carry-forward for its own row, then feeds the carry', () => {
  const prescribed = { targets: [target(1, { target_num: 27.5 })] };
  const userValues = new Map([[`0:${WEIGHT.id}`, '20']]);
  const plan = planWeightAutofill({ template: tpl(), prescribed, rows: 3, userValues });
  assert.deepEqual(plan, [
    { row_index: 1, column_id: WEIGHT.id, value: '27.5' },
    { row_index: 2, column_id: WEIGHT.id, value: '27.5' },
  ]);
});

test('a cleared user cell does not reset the carry', () => {
  const userValues = new Map([[`0:${WEIGHT.id}`, '20'], [`1:${WEIGHT.id}`, '']]);
  const plan = planWeightAutofill({ template: tpl(), prescribed: null, rows: 3, userValues });
  assert.deepEqual(plan, [
    { row_index: 2, column_id: WEIGHT.id, value: '20' },
  ]);
});

test('auto cells with nothing to show still appear with an empty value', () => {
  const plan = planWeightAutofill({ template: tpl(), prescribed: null, rows: 2, userValues: new Map() });
  assert.deepEqual(plan, [
    { row_index: 0, column_id: WEIGHT.id, value: '' },
    { row_index: 1, column_id: WEIGHT.id, value: '' },
  ]);
});

test('text columns prefer target_text, fall back to target_num', () => {
  const prescribed = {
    targets: [
      target(0, { target_num: null, target_text: '12.5 per DB' }),
      target(1, { target_num: 25, target_text: null }),
    ],
  };
  const plan = planWeightAutofill({ template: tpl(), prescribed, rows: 2, userValues: new Map() });
  assert.deepEqual(plan.map(c => c.value), ['12.5 per DB', '25']);
});

test('number columns prefer target_num', () => {
  const numWeight = { ...WEIGHT, value_type: 'number' };
  const prescribed = { targets: [target(0, { target_num: 25, target_text: '30' })] };
  const plan = planWeightAutofill({
    template: tpl({ columns: [REPS, numWeight] }), prescribed, rows: 1, userValues: new Map(),
  });
  assert.deepEqual(plan, [{ row_index: 0, column_id: WEIGHT.id, value: '25' }]);
});

test('a target with no value is treated as absent', () => {
  const prescribed = { targets: [target(0, { target_num: null, target_text: null })] };
  const userValues = new Map();
  const plan = planWeightAutofill({ template: tpl(), prescribed, rows: 1, userValues });
  assert.deepEqual(plan, [{ row_index: 0, column_id: WEIGHT.id, value: '' }]);
});

test('targets for other templates are ignored', () => {
  const prescribed = { targets: [target(0, { template_id: 22 })] };
  const plan = planWeightAutofill({ template: tpl(), prescribed, rows: 1, userValues: new Map() });
  assert.deepEqual(plan, [{ row_index: 0, column_id: WEIGHT.id, value: '' }]);
});

test('checkbox templates and templates without a weight column produce no plan', () => {
  const checkbox = tpl({ kind: 'checkbox', columns: [{ id: 33, name: 'completed', value_type: 'text' }] });
  assert.deepEqual(planWeightAutofill({ template: checkbox, prescribed: null, rows: 1, userValues: new Map() }), []);
  const repsOnly = tpl({ columns: [REPS] });
  assert.deepEqual(planWeightAutofill({ template: repsOnly, prescribed: null, rows: 3, userValues: new Map() }), []);
});
