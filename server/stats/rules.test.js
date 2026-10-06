import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleFor } from './rules.js';

const tpl = (name, columns = ['reps', 'weight'], kind = 'standard') => ({
  name, kind, columns: columns.map((c) => (typeof c === 'string' ? { name: c, unit: null } : c)),
});

test('every logged exercise name maps to its rule', () => {
  const expected = {
    'DB front-rack squat A': 'front_rack',
    'DB floor press A': 'floor_press',
    'DB floor press C': 'floor_press',
    'DB Romanian deadlift A': 'rdl_a',
    'DB Romanian deadlift B': 'rdl',
    'DB Romanian deadlift C': 'rdl',
    'DB row A': 'db_row',
    'DB Row B': 'db_row',
    'DB overhead press': 'ohp',
    'DB Split squat': 'split_squat',
    'DB Goblet Squat A': 'goblet',
    'DB goblet squat C': 'goblet',
    'Step-up (DB-loaded)': 'step_up',
    'Farmer carry (loaded DBs)': 'farmer',
    'Suitcase carry (single DB)': 'suitcase',
    'Pull-up progression (inverted row)': 'inverted_row',
    'Dip progression (scaled)': 'dip',
    'BW Pushup (Incline)': 'incline_pushup',
    'BW Push-up': 'pushup',
    '1 set Push-up': 'pushup',
    'Dead bug': 'dead_bug',
    Plank: 'hold',
    'Side plank': 'hold',
    'Static Hang': 'hold',
    Intervals: 'walk',
    'Zone 2': 'walk',
    'Long Walk': 'walk',
    Walk: 'walk',
    '20 min treadmill walk': 'walk',
    'Step platform': 'step_platform',
    Yoga: 'yoga',
    Mobility: 'mobility',
    'Foam Roll': 'mobility',
    'Cat-camel': 'mobility',
    'Hip flexor stretch (half-kneeling)': 'mobility',
    '90/90 hip switch': 'mobility',
    'Thoracic extension (roller)': 'mobility',
    'Bird dog': 'mobility',
  };
  for (const [name, id] of Object.entries(expected)) assert.equal(ruleFor(tpl(name)).matched, id, name);
});

test('specific rules win over the general ones they overlap', () => {
  assert.equal(ruleFor(tpl('Suitcase carry')).dbs, 1);
  assert.equal(ruleFor(tpl('Farmer carry')).dbs, 2);
  assert.equal(ruleFor(tpl('DB Romanian deadlift A')).value_is, 'total');
  assert.equal(ruleFor(tpl('DB Romanian deadlift B')).value_is, 'per_db');
  assert.equal(ruleFor(tpl('BW Pushup (Incline)')).bw_fraction, 0.55);
  assert.equal(ruleFor(tpl('BW Push-up')).bw_fraction, 0.64);
  // "Step platform" is cardio, not a step-up
  assert.equal(ruleFor(tpl('Step platform', ['completed'], 'checkbox')).category, 'cardio');
});

test('load, side and bodyweight settings per movement', () => {
  const r = (n) => ruleFor(tpl(n));
  assert.deepEqual(
    ['DB Split squat', 'Step-up (DB-loaded)', 'DB row A', 'Dead bug', 'DB floor press A'].map((n) => r(n).per_side),
    [true, true, true, true, false],
  );
  assert.equal(r('DB Split squat').bw_fraction, 0.88);
  assert.equal(r('Step-up (DB-loaded)').bw_fraction, 0.94);
  assert.equal(r('Pull-up progression (inverted row)').bw_fraction, 0.5);
  assert.equal(r('Dip progression (scaled)').bw_fraction, 0.95);
  assert.equal(r('DB front-rack squat A').bw_fraction, 0);
  assert.equal(r('Farmer carry (loaded DBs)').carry, true);
  assert.equal(r('DB overhead press').carry, false);
  assert.equal(r('DB overhead press').handle, true);
  assert.equal(r('Pull-up progression (inverted row)').handle, false);
  assert.equal(r('Plank').hold, true);
});

test('categories and METs', () => {
  assert.equal(ruleFor(tpl('DB overhead press')).category, 'strength');
  assert.equal(ruleFor(tpl('DB overhead press')).met, 3.5);
  assert.equal(ruleFor(tpl('Zone 2', ['time', 'speed'])).category, 'cardio');
  assert.equal(ruleFor(tpl('Zone 2', ['time', 'speed'])).met, null);
  assert.equal(ruleFor(tpl('Step platform', ['completed'], 'checkbox')).met, 4);
  assert.equal(ruleFor(tpl('Yoga', ['completed'], 'checkbox')).met, 2.5);
  assert.equal(ruleFor(tpl('Cat-camel', ['time'])).met, 2.3);
});

test('unknown templates fall back on their columns', () => {
  const cardio = ruleFor(tpl('Rower', ['time', 'distance']));
  assert.equal(cardio.matched, null);
  assert.equal(cardio.category, 'cardio');
  const lift = ruleFor(tpl('Kettlebell swing', ['reps', 'weight']));
  assert.equal(lift.category, 'strength');
  assert.equal(lift.dbs, 1);
  assert.equal(lift.value_is, 'per_db');
  assert.equal(ruleFor(tpl('Mystery hold', ['time'])).category, 'mobility');
  assert.equal(ruleFor(tpl('Morning routine', ['completed'], 'checkbox')).category, 'mobility');
  assert.equal(ruleFor(tpl('Bicep Curls', [{ name: 'reps', unit: 'pounds' }])).category, 'strength');
});
