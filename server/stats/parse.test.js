import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellRaw, parseLoad, parseReps, parseSeconds, parseSpeedKph, parseGradePct, parseDistanceKm, parseBodyKg, parseWaistIn,
} from './parse.js';

const col = (name, unit = null) => ({ name, unit });

test('cellRaw prefers non-empty text, falls back to the number, trims', () => {
  assert.equal(cellRaw({ value_text: ' 10 lbs ', value_num: null }), '10 lbs');
  // May-June values migration 009 left only in value_num
  assert.equal(cellRaw({ value_text: null, value_num: 17.5 }), '17.5');
  assert.equal(cellRaw({ value_text: '', value_num: 8 }), '8');
  assert.equal(cellRaw({ value_text: '   ', value_num: null }), null);
  assert.equal(cellRaw({ value_text: null, value_num: null }), null);
  assert.equal(cellRaw(undefined), null);
});

test('parseLoad reads the logged weight shapes', () => {
  const cases = [
    ['29.5', null, { lb: 29.5, implements: null, total: false }],
    ['12.5 lbs', 'lbs', { lb: 12.5, implements: null, total: false }],
    ['10 lbs ', null, { lb: 10, implements: null, total: false }],
    ['7.5 lbs x 2', null, { lb: 7.5, implements: 2, total: false }],
    ['10 lb x 2', 'lb', { lb: 10, implements: 2, total: false }],
    ['25.5 x 2', null, { lb: 25.5, implements: 2, total: false }],
    ['15 lbs × 2', null, { lb: 15, implements: 2, total: false }],
    ['34 lbs total', 'lbs', { lb: 34, implements: null, total: true }],
    ['20 kg', null, { lb: 44.0924, implements: null, total: false }],
    ['20', 'kg', { lb: 44.0924, implements: null, total: false }],
    // the text's own unit beats the column's
    ['10 lb', 'kg', { lb: 10, implements: null, total: false }],
  ];
  for (const [text, unit, want] of cases) {
    const got = parseLoad(text, unit);
    assert.ok(got, text);
    assert.equal(Math.round(got.lb * 1e4) / 1e4, want.lb, text);
    assert.equal(got.implements, want.implements, text);
    assert.equal(got.total, want.total, text);
  }
});

test('parseLoad: bodyweight, empty and unreadable are null', () => {
  for (const t of [null, '', 'BW', 'bodyweight', 'orange band', '0']) assert.equal(parseLoad(t, 'lb'), null, String(t));
});

test('parseReps reads counts and sides', () => {
  assert.deepEqual(parseReps('5'), { count: 5, sides: 'bare' });
  assert.deepEqual(parseReps('7.5'), { count: 7.5, sides: 'bare' });
  assert.deepEqual(parseReps('10/side'), { count: 10, sides: 'per_side' });
  assert.deepEqual(parseReps('10 / side'), { count: 10, sides: 'per_side' });
  assert.deepEqual(parseReps('12 each side'), { count: 12, sides: 'per_side' });
  assert.deepEqual(parseReps('8 per side'), { count: 8, sides: 'per_side' });
  assert.deepEqual(parseReps('8 left 6 right'), { count: 14, sides: 'both' });
  assert.deepEqual(parseReps('8L 6R'), { count: 14, sides: 'both' });
  assert.deepEqual(parseReps('5+3'), { count: 8, sides: 'bare' });
  for (const t of [null, '', 'x', '0']) assert.equal(parseReps(t), null, String(t));
});

test('parseSeconds reads clock, suffixed and per-side times', () => {
  const sec = col('time', 'sec');
  const min = col('time', 'min');
  const bare = col('time', null);
  assert.equal(parseSeconds('45:00', min), 2700);
  assert.equal(parseSeconds('20:00', sec), 1200);
  assert.equal(parseSeconds('1:02:03', bare), 3723);
  assert.equal(parseSeconds('60s', min), 60);
  assert.equal(parseSeconds('60 sec', bare), 60);
  assert.equal(parseSeconds('2 min', sec), 120);
  assert.equal(parseSeconds('1m30s', bare), 90);
  assert.equal(parseSeconds('15s both sides', bare), 30);
  assert.equal(parseSeconds('15s left 5s right', bare), 20);
  assert.equal(parseSeconds('30/side', sec), 60);
});

test('parseSeconds scales a bare number by the column unit, else the fallback', () => {
  assert.equal(parseSeconds('45', col('time', 'sec')), 45);
  assert.equal(parseSeconds('45', col('time', 'seconds per side')), 45);
  assert.equal(parseSeconds('43', col('time', 'min')), 2580);
  // the runner writes tenths of a minute on minute columns
  assert.equal(parseSeconds('4.5', col('time', 'minutes')), 270);
  assert.equal(parseSeconds('30', col('time', null)), 30);
  assert.equal(parseSeconds('30', col('time', null), 60), 1800);
  for (const t of [null, '', 'n/a', '0']) assert.equal(parseSeconds(t, col('time', 'sec')), null, String(t));
});

test('parseSpeedKph reads speeds, ranges and paces', () => {
  const kph = col('speed', 'kph');
  assert.equal(parseSpeedKph('5', kph), 5);
  assert.equal(parseSpeedKph('6.5 kph', col('speed')), 6.5);
  assert.equal(parseSpeedKph('5 km/h', col('speed')), 5);
  assert.equal(parseSpeedKph('4.5 - 3.5', kph), 4);
  assert.equal(Math.round(parseSpeedKph('3', col('speed', 'mph')) * 100) / 100, 4.83);
  assert.equal(Math.round(parseSpeedKph('3 mph', kph) * 100) / 100, 4.83);
  // min/km paces, straight and curly quotes (Long Walk's pace column)
  assert.equal(Math.round(parseSpeedKph('12\'20"/km', col('pace', 'kph')) * 100) / 100, 4.86);
  assert.equal(Math.round(parseSpeedKph('11’45”', col('pace', 'kph')) * 100) / 100, 5.11);
  assert.equal(parseSpeedKph('12', col('pace', 'kph')), 5);
  assert.equal(parseSpeedKph('5', col('pace', 'kph')), 5);
  for (const t of [null, '', 'easy']) assert.equal(parseSpeedKph(t, kph), null, String(t));
});

test('parseGradePct and parseDistanceKm', () => {
  assert.equal(parseGradePct('9'), 9);
  assert.equal(parseGradePct('8 %'), 8);
  assert.equal(parseGradePct('0'), 0);
  assert.equal(parseGradePct('7-9'), 8);
  assert.equal(parseGradePct(''), null);
  assert.equal(parseDistanceKm('3.74', col('distance', 'km')), 3.74);
  assert.equal(parseDistanceKm('3.74', col('distance')), 3.74);
  assert.equal(parseDistanceKm('1200 m', col('distance')), 1.2);
  assert.equal(Math.round(parseDistanceKm('2', col('distance', 'mi')) * 1000) / 1000, 3.219);
  assert.equal(parseDistanceKm('x', col('distance')), null);
});

test('parseBodyKg accepts plausible kg and converts pounds', () => {
  assert.equal(parseBodyKg('101.4'), 101.4);
  assert.equal(Math.round(parseBodyKg('220 lb') * 10) / 10, 99.8);
  assert.equal(parseBodyKg('12'), null);
  assert.equal(parseBodyKg('400'), null);
  assert.equal(parseBodyKg('n/a'), null);
});

test('parseWaistIn reads inches and converts centimetres', () => {
  assert.equal(parseWaistIn('43.25'), 43.25);
  assert.equal(parseWaistIn('43.25"'), 43.25);
  assert.equal(parseWaistIn('44 in'), 44);
  assert.equal(Math.round(parseWaistIn('110 cm') * 100) / 100, 43.31);
  assert.equal(parseWaistIn('12'), null);
  assert.equal(parseWaistIn('n/a'), null);
});
