import test from 'node:test';
import assert from 'node:assert/strict';
import { niceScale, stackedColumnsSvg } from './charts.js';

test('niceScale rounds the top up to a clean step', () => {
  assert.deepEqual(niceScale(3300), { max: 4000, step: 1000, ticks: [0, 1000, 2000, 3000, 4000] });
  assert.deepEqual(niceScale(87), { max: 100, step: 25, ticks: [0, 25, 50, 75, 100] });
  assert.deepEqual(niceScale(3300, 4, [900, 1800, 3600]), { max: 3600, step: 900, ticks: [0, 900, 1800, 2700, 3600] });
  assert.deepEqual(niceScale(0), { max: 1, step: 1, ticks: [0] });
});

const week = (label, parts) => ({ start: 0, label, parts, total: Object.values(parts).reduce((a, b) => a + b, 0) });
const weeks = [
  week('Sep 28', { a: 300, b: 100 }),
  week('Oct 5', { a: 0, b: 0 }),
  week('Oct 12', { a: 200, b: 0 }),
];
const svg = (over = {}) => stackedColumnsSvg({ weeks, keys: ['a', 'b'], width: 300, height: 160, format: (v) => `${v} s`, ...over });

// [x, y, width, height] of every segment, in document order
const segments = (out) => [...out.matchAll(/class="seg seg-(\d)"[^>]*data-box="([^"]+)"/g)]
  .map((m) => ({ slot: Number(m[1]), box: m[2].split(',').map(Number) }));

test('one column group and one hit target per week', () => {
  const out = svg();
  assert.equal(out.match(/<g class="col/g).length, 3);
  assert.equal(out.match(/class="hit"/g).length, 3);
  assert.match(out, /aria-label="Oct 5: 0 s"/, 'an empty week is still reachable');
  assert.doesNotMatch(out, /NaN|undefined/);
});

test('segments stack from the baseline in proportion, 2px apart', () => {
  const [bottom, top, only] = segments(svg());
  assert.deepEqual([bottom.slot, top.slot, only.slot], [1, 2, 1]);
  // a:b is 3:1 in week one; week three's 200 is two thirds of week one's a
  const unit = bottom.box[3] / 300;
  assert.ok(Math.abs(top.box[3] - (100 * unit - 2)) < 0.01, 'the upper segment gives up 2px to the gap');
  assert.ok(Math.abs(only.box[3] - 200 * unit) < 0.01);
  assert.ok(Math.abs(bottom.box[1] - (top.box[1] + top.box[3] + 2)) < 0.01, '2px surface gap between them');
  // all share one baseline
  assert.ok(Math.abs(bottom.box[1] + bottom.box[3] - (only.box[1] + only.box[3])) < 0.01);
});

test('columns stay thin and only the top segment gets the rounded end', () => {
  const out = svg({ width: 2000 });
  for (const s of segments(out)) assert.ok(s.box[2] <= 24, 'capped at 24px');
  const tops = [...out.matchAll(/<path class="seg seg-\d"/g)].length;
  const rects = [...out.matchAll(/<rect class="seg seg-\d"/g)].length;
  assert.equal(tops, 2, 'week one and week three each end in a path');
  assert.equal(rects, 1, 'week one\'s lower segment is a plain rect');
});

test('the selected week is marked and a single-series chart works', () => {
  assert.match(svg({ selected: 2 }), /<g class="col selected" data-index="2"/);
  const one = stackedColumnsSvg({ weeks: [week('Oct 5', { reps: 40 })], keys: ['reps'], width: 300, height: 160, format: String });
  assert.equal(segments(one).length, 1);
});

test('an all-zero range draws a baseline and no NaN', () => {
  const out = stackedColumnsSvg({ weeks: [week('Oct 5', { a: 0 })], keys: ['a'], width: 300, height: 160, format: String });
  assert.doesNotMatch(out, /NaN|Infinity|undefined/);
  assert.equal(segments(out).length, 0);
});
