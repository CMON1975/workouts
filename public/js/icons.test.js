import test from 'node:test';
import assert from 'node:assert/strict';
import { iconSvg, ICON_NAMES } from './icons.js';

test('iconSvg renders an inline lucide svg with app conventions', () => {
  const svg = iconSvg('check');
  assert.ok(svg.startsWith('<svg '), 'starts an svg element');
  assert.ok(svg.endsWith('</svg>'), 'closes the svg element');
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /fill="none"/);
  assert.match(svg, /stroke="currentColor"/, 'inherits button text color');
  assert.match(svg, /stroke-width="2"/);
  assert.match(svg, /aria-hidden="true"/, 'decorative — label lives on the button');
  assert.match(svg, /class="icon"/, 'sized by CSS, not width/height attrs');
  assert.match(svg, /M20 6 9 17l-5-5/, 'carries the lucide check path');
});

test('every registered icon renders non-empty markup', () => {
  assert.ok(ICON_NAMES.length >= 16, 'registry covers the app inventory');
  for (const name of ICON_NAMES) {
    const svg = iconSvg(name);
    assert.ok(/<(path|circle|rect|line|polyline)[ /]/.test(svg), `${name} has drawing content`);
  }
});

test('circle-x is registered for the end-early action', () => {
  const svg = iconSvg('circle-x');
  assert.match(svg, /<circle cx="12" cy="12" r="10"\/>/);
  assert.match(svg, /m15 9-6 6/, 'x stroke inside the circle');
});

test('unknown icon name throws instead of rendering an empty button', () => {
  assert.throws(() => iconSvg('does-not-exist'), /unknown icon/i);
});

test('skip-forward is registered for the interval skip', () => {
  const svg = iconSvg('skip-forward');
  assert.match(svg, /M21 4v16/, 'end bar');
  assert.match(svg, /9.997-5.998/, 'play triangle');
});
