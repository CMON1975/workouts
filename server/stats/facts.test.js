import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionFacts } from './facts.js';
import { ruleFor } from './rules.js';

// A template with columns 1..n named as given; cells are [row][colName] text.
function session(name, columnSpecs, rows, { kind = 'standard', localDate = '2026-09-28', bodyKg = 100 } = {}) {
  const columns = columnSpecs.map((c, i) => (typeof c === 'string' ? { id: i + 1, name: c, unit: null } : { id: i + 1, ...c }));
  const template = { id: 1, name, kind, columns };
  const byName = new Map(columns.map((c) => [c.name, c.id]));
  const values = [];
  rows.forEach((row, row_index) => {
    for (const [col, v] of Object.entries(row)) {
      const isNum = typeof v === 'number';
      values.push({ row_index, column_id: byName.get(col), value_num: isNum ? v : null, value_text: isNum ? null : v });
    }
  });
  return sessionFacts({ template, columns, values, rule: ruleFor(template), localDate, bodyKg });
}

const round = (n) => Math.round(n * 100) / 100;

test('sets and reps count rows with values; per-side reps count both sides', () => {
  const press = session('DB floor press A', ['reps', 'weight'], [
    { reps: '5', weight: '34.5' }, { reps: '5', weight: '34.5' }, { reps: '4', weight: '34.5' },
  ]);
  assert.equal(press.counted, true);
  assert.equal(press.sets, 3);
  assert.equal(press.reps, 14);

  // rule says per side: a bare "8" is 8 each side
  const row = session('DB row A', ['reps', 'weight'], [{ reps: '8', weight: '24.5' }, { reps: '6', weight: '24.5' }]);
  assert.equal(row.reps, 28);
  // explicit text wins: "/side" doubles, "left/right" is already the sum
  const step = session('Step-up (DB-loaded)', ['reps', 'weight'], [{ reps: '10/side', weight: '9.5' }, { reps: '8 left 6 right', weight: '9.5' }]);
  assert.equal(step.reps, 34);
});

test('lifted load: per-dumbbell weight x dumbbells x reps', () => {
  // two-DB lift logged per DB
  const press = session('DB floor press A', ['reps', 'weight'], [{ reps: '5', weight: '34.5' }, { reps: 5, weight: 34.5 }]);
  assert.equal(press.lifted_lb, 34.5 * 2 * 5 * 2);
  // one-DB row, reps per side
  const row = session('DB row A', ['reps', 'weight'], [{ reps: '8', weight: '24.5' }]);
  assert.equal(row.lifted_lb, 24.5 * 1 * 16);
  // explicit "x 2" and "total" override the rule
  const ohp = session('DB overhead press', ['reps', 'weight'], [{ reps: '6', weight: '7.5 lbs x 2' }, { reps: '6', weight: '34 lbs total' }]);
  assert.equal(ohp.lifted_lb, 7.5 * 2 * 6 + 34 * 6);
  // the early RDL logged the pair's total
  const rdlA = session('DB Romanian deadlift A', ['reps', 'weight'], [{ reps: '8', weight: '30' }]);
  assert.equal(rdlA.lifted_lb, 30 * 8);
  // kg columns convert
  const squat = session('Kettlebell squat', ['reps', { name: 'weight', unit: 'kg' }], [{ reps: '10', weight: '20' }]);
  assert.equal(round(squat.lifted_lb), round(20 * 2.20462 * 10));
});

test('rows missing reps or weight lift nothing; holds lift nothing', () => {
  const partial = session('DB floor press A', ['reps', 'weight'], [{ reps: '5' }, { weight: '34.5' }]);
  assert.equal(partial.lifted_lb, 0);
  assert.equal(partial.sets, 2);
  const plank = session('Plank', [{ name: 'time', unit: 'sec' }, 'weight'], [{ time: '45', weight: '10' }]);
  assert.equal(plank.lifted_lb, 0);
  assert.equal(plank.work_seconds, 45);
});

test('work time, distance, speed and incline from cardio and hold rows', () => {
  const walk = session('Zone 2', [{ name: 'time', unit: 'min' }, { name: 'speed', unit: 'kph' }, 'incline', 'hr'],
    [{ time: '45', speed: '5', incline: '0', hr: '93' }]);
  assert.equal(walk.work_seconds, 2700);
  assert.equal(walk.speed_kph, 5);
  assert.equal(walk.grade_pct, 0);
  // no distance column: speed x time
  assert.equal(walk.distance_km, 3.75);
  // cardio with an unlabeled time column reads minutes, like the runner
  const intervals = session('Intervals', ['rounds', 'speed', 'incline', 'hr', 'time'], [{ rounds: '10', speed: '6.5', incline: '9', time: '43' }]);
  assert.equal(intervals.work_seconds, 2580);
  const logged = session('Walk', ['time', { name: 'distance', unit: 'km' }], [{ time: '45:00', distance: '3.74' }]);
  assert.equal(logged.distance_km, 3.74);
  const holds = session('Side plank', [{ name: 'time', unit: 'sec/side' }], [{ time: '30' }, { time: '30' }, { time: '15s left 5s right' }]);
  assert.equal(holds.work_seconds, 80);
  assert.equal(holds.distance_km, 0);
});

test('counted: any value, a ticked checkbox; unreadable role cells are tallied', () => {
  assert.equal(session('DB floor press A', ['reps', 'weight'], []).counted, false);
  const ticked = session('Yoga', ['completed'], [{ completed: 1 }], { kind: 'checkbox' });
  assert.equal(ticked.counted, true);
  assert.equal(ticked.sets, 1);
  assert.equal(session('Yoga', ['completed'], [{ completed: 0 }], { kind: 'checkbox' }).counted, false);
  const messy = session('DB floor press A', ['reps', 'weight', 'notes'], [{ reps: 'lots', weight: 'heavy', notes: 'felt good' }]);
  assert.equal(messy.counted, true);
  assert.equal(messy.unparsed, 2);
});

test('handle correction: logs before 2026-07-20 lose 4.5 lb per dumbbell', () => {
  const before = { localDate: '2026-07-19' };
  const press = session('DB floor press A', ['reps', 'weight'], [{ reps: '6', weight: '25.5' }, { reps: '6', weight: '25.5' }], before);
  assert.equal(press.lifted_lb, (25.5 - 4.5) * 2 * 6 * 2);
  assert.equal(press.corrected, 2);
  // from the cutoff on, as logged
  const after = session('DB floor press A', ['reps', 'weight'], [{ reps: '6', weight: '25.5' }], { localDate: '2026-07-20' });
  assert.equal(after.lifted_lb, 25.5 * 2 * 6);
  assert.equal(after.corrected, 0);
  // explicit "x 2" is per dumbbell
  const ohp = session('DB overhead press', ['reps', 'weight'], [{ reps: '6', weight: '7.5 lbs x 2' }], before);
  assert.equal(ohp.lifted_lb, (7.5 - 4.5) * 2 * 6);
  // a total sheds one handle per dumbbell in the pair
  const rdlA = session('DB Romanian deadlift A', ['reps', 'weight'], [{ reps: '8', weight: '30' }], before);
  assert.equal(rdlA.lifted_lb, (30 - 9) * 8);
  const total = session('DB overhead press', ['reps', 'weight'], [{ reps: '6', weight: '34 lbs total' }], before);
  assert.equal(total.lifted_lb, (34 - 9) * 6);
  // never below zero
  assert.equal(session('DB floor press A', ['reps', 'weight'], [{ reps: '6', weight: '3' }], before).lifted_lb, 0);
  // movements without a dumbbell handle are untouched
  const kb = session('Kettlebell swing', ['reps', 'weight'], [{ reps: '10', weight: '20' }], before);
  assert.equal(kb.lifted_lb, 200);
  assert.equal(kb.corrected, 0);
});

test('bodyweight share: fraction x body weight x reps, apart from lifted load', () => {
  const kgToLb = 2.20462;
  const split = session('DB Split squat', ['reps', 'weight'], [{ reps: '12', weight: '9.5' }], { bodyKg: 100 });
  assert.equal(round(split.bw_lb), round(0.88 * 100 * kgToLb * 24));
  assert.equal(split.lifted_lb, 9.5 * 2 * 24);
  const rows = session('Pull-up progression (inverted row)', ['reps'], [{ reps: '6' }, { reps: '3' }], { bodyKg: 101 });
  assert.equal(round(rows.bw_lb), round(0.5 * 101 * kgToLb * 9));
  assert.equal(rows.lifted_lb, 0);
  const push = session('BW Pushup (Incline)', ['reps'], [{ reps: '10' }], { bodyKg: 100 });
  assert.equal(round(push.bw_lb), round(0.55 * 100 * kgToLb * 10));
  assert.equal(session('DB front-rack squat A', ['reps', 'weight'], [{ reps: '5', weight: '29.5' }]).bw_lb, 0);
});

test('carries: weight x dumbbells x 100 steps/min over the logged time', () => {
  const farmer = session('Farmer carry (loaded DBs)', [{ name: 'time', unit: 'sec' }, 'weight'],
    [{ time: '60', weight: '19.5' }, { time: '60', weight: '19.5' }, { time: '45', weight: '19.5' }]);
  assert.equal(round(farmer.carried_lb), round(19.5 * 2 * (100 / 60) * 165));
  assert.equal(farmer.lifted_lb, 0);
  assert.equal(farmer.work_seconds, 165);
  // suitcase rows are already one side each: no doubling
  const suitcase = session('Suitcase carry (single DB)', [{ name: 'time', unit: 'sec/side' }, 'weight'],
    [{ time: '60', weight: '19.5' }, { time: '60', weight: '19.5' }]);
  assert.equal(round(suitcase.carried_lb), round(19.5 * (100 / 60) * 120));
  // the handle correction applies to carried dumbbells too
  const early = session('Farmer carry (loaded DBs)', [{ name: 'time', unit: 'sec' }, 'weight'],
    [{ time: '30', weight: '15' }], { localDate: '2026-06-01' });
  assert.equal(round(early.carried_lb), round(10.5 * 2 * (100 / 60) * 30));
  assert.equal(early.corrected, 1);
  // no time, no carry
  assert.equal(session('Farmer carry (loaded DBs)', ['time', 'weight'], [{ weight: '19.5' }]).carried_lb, 0);
});
