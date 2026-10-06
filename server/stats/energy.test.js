import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyKgOn, walkMet, activeKcal, sessionKcal } from './energy.js';
import { ruleFor } from './rules.js';

const r1 = (n) => Math.round(n * 10) / 10;

test('bodyKgOn: last weigh-in on or before the day, else the nearest, else the default', () => {
  const series = [
    { date: '2026-09-28', kg: 100.0 },
    { date: '2026-09-21', kg: 101.3 },
    { date: '2026-10-01', kg: 101.4 },
  ];
  assert.deepEqual(bodyKgOn(series, '2026-09-30'), { kg: 100.0, source: 'logged' });
  assert.deepEqual(bodyKgOn(series, '2026-09-28'), { kg: 100.0, source: 'logged' });
  assert.deepEqual(bodyKgOn(series, '2026-10-05'), { kg: 101.4, source: 'logged' });
  // before the first weigh-in: the first one is the nearest
  assert.deepEqual(bodyKgOn(series, '2026-05-04'), { kg: 101.3, source: 'nearest' });
  assert.deepEqual(bodyKgOn([], '2026-05-04'), { kg: 100, source: 'default' });
});

test('walkMet: the ACSM walking equation', () => {
  assert.equal(r1(walkMet(5, 0) * 1000) / 1000, r1(3.381 * 1000) / 1000);
  assert.equal(Math.round(walkMet(6.5, 9) * 100) / 100, 9.11);
});

test('activeKcal: net of resting, never negative', () => {
  // 5 kph flat for 45 min at 101 kg
  assert.equal(Math.round(activeKcal(walkMet(5, 0), 101, 2700)), 180);
  assert.equal(activeKcal(0.8, 100, 3600), 0);
});

test('sessionKcal: walking equation for cardio, METs for the rest', () => {
  const zone2 = ruleFor({ name: 'Zone 2', columns: [] });
  const walk = sessionKcal({ rule: zone2, facts: { speed_kph: 5, grade_pct: 0, work_seconds: 2700 }, seconds: 3000, kg: 101 });
  assert.equal(Math.round(walk.kcal), 180);
  assert.equal(walk.basis, 'walk');
  // no logged speed: 5 kph flat, flagged
  const blind = sessionKcal({ rule: zone2, facts: { speed_kph: null, grade_pct: null, work_seconds: 0 }, seconds: 2700, kg: 101 });
  assert.equal(Math.round(blind.kcal), 180);
  assert.equal(blind.basis, 'walk_assumed');
  // strength: 3.5 MET over wall time
  const press = sessionKcal({ rule: ruleFor({ name: 'DB floor press A', columns: [] }), facts: {}, seconds: 2613, kg: 101 });
  assert.equal(Math.round(press.kcal), 183);
  assert.equal(press.basis, 'met');
  const stretch = sessionKcal({ rule: ruleFor({ name: 'Cat-camel', columns: [] }), facts: {}, seconds: 600, kg: 100 });
  assert.equal(r1(stretch.kcal), r1(1.3 * 100 * 600 / 3600));
});
