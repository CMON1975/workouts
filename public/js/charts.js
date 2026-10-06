// Stacked weekly columns as an SVG string (pure, so node tests can read the
// geometry). Mark specs from the dataviz method: columns at most 24px wide,
// a 4px rounded data-end on the top segment only (square at the baseline),
// a 2px surface gap between segments, hairline grid. Colour comes from CSS
// classes (seg-1..3 -> --color-series-N): SVG attributes can't read var().

import { weekLabel } from './stats.js';

const GAP = 2;
const RADIUS = 4;
const MAX_COL = 24;
const PAD = { left: 48, right: 4, top: 8, bottom: 22 };

const r2 = (n) => Math.round(n * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 1-2-2.5-5 decades: the smallest clean step at least `raw`.
const niceStep = (raw) => {
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
};

// Ticks from 0 to a clean top. `steps` (ascending) replaces the 1-2-2.5-5
// decades, e.g. minute multiples for a time axis.
export function niceScale(max, ticks = 4, steps = null) {
  if (!(max > 0)) return { max: 1, step: 1, ticks: [0] };
  const raw = max / ticks;
  let step;
  if (steps?.length) {
    step = steps.find((s) => s >= raw) ?? steps.at(-1) * Math.ceil(raw / steps.at(-1));
  } else {
    step = niceStep(raw);
  }
  const top = Math.ceil(max / step) * step;
  const out = [];
  for (let i = 0; i * step <= top + 1e-9; i++) out.push(r2(i * step));
  return { max: top, step, ticks: out };
}

// A rect with its top corners rounded and its bottom square.
function roundedTop(x, y, w, h) {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${r2(x)} ${r2(y + h)}V${r2(y + r)}Q${r2(x)} ${r2(y)} ${r2(x + r)} ${r2(y)}H${r2(x + w - r)}Q${r2(x + w)} ${r2(y)} ${r2(x + w)} ${r2(y + r)}V${r2(y + h)}Z`;
}

export function stackedColumnsSvg({ weeks, keys, width, height, selected = null, format, steps = null, title = '' }) {
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const base = PAD.top + plotH;
  const scale = niceScale(Math.max(0, ...weeks.map((w) => w.total)), 4, steps);
  const unit = plotH / scale.max;
  const band = plotW / Math.max(weeks.length, 1);
  const colW = Math.min(MAX_COL, Math.max(2, band * 0.6));

  const parts = [`<svg class="chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(title)}">`];
  for (const t of scale.ticks) {
    const y = r2(base - t * unit);
    parts.push(`<line class="grid" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text class="tick" x="${PAD.left - 6}" y="${y}" dy="0.32em" text-anchor="end">${esc(format(t))}</text>`);
  }

  // Label every k-th week, counting back from the latest so it's always labelled.
  const every = Math.ceil(weeks.length / Math.max(1, Math.floor(plotW / 52)));
  weeks.forEach((w, i) => {
    const x = PAD.left + i * band + (band - colW) / 2;
    const g = [`<g class="col${selected === i ? ' selected' : ''}" data-index="${i}">`];
    if (selected === i) g.push(`<rect class="sel-band" x="${r2(PAD.left + i * band)}" y="${PAD.top}" width="${r2(band)}" height="${r2(plotH)}"/>`);
    const visible = keys.map((k, j) => ({ slot: j + 1, h: (w.parts[k] || 0) * unit })).filter((s) => s.h > 0);
    let cum = 0;
    visible.forEach((s, j) => {
      const y = base - cum - s.h;
      cum += s.h;
      const h = j === 0 ? s.h : s.h - GAP;
      if (h < 0.5) return;
      const box = `data-box="${r2(x)},${r2(y)},${r2(colW)},${r2(h)}"`;
      if (j === visible.length - 1) g.push(`<path class="seg seg-${s.slot}" ${box} d="${roundedTop(x, y, colW, h)}"/>`);
      else g.push(`<rect class="seg seg-${s.slot}" ${box} x="${r2(x)}" y="${r2(y)}" width="${r2(colW)}" height="${r2(h)}"/>`);
    });
    if ((weeks.length - 1 - i) % every === 0) {
      g.push(`<text class="xlabel" x="${r2(x + colW / 2)}" y="${height - 6}" text-anchor="middle">${esc(w.label)}</text>`);
    }
    g.push(`<rect class="hit" x="${r2(PAD.left + i * band)}" y="${PAD.top}" width="${r2(band)}" height="${r2(plotH + PAD.bottom)}" tabindex="0" role="button" aria-label="${esc(`${w.label}: ${format(w.total)}`)}"/>`);
    g.push('</g>');
    parts.push(g.join(''));
  });
  parts.push(`<line class="axis" x1="${PAD.left}" x2="${width - PAD.right}" y1="${r2(base)}" y2="${r2(base)}"/>`);
  parts.push('</svg>');
  return parts.join('');
}

// A y-domain that hugs the data (a line's job is change, not magnitude, so
// zero needn't be on the axis), widened to clean steps.
export function niceDomain(min, max, ticks = 4) {
  const span = max - min || Math.abs(max) * 0.02 || 1;
  const step = niceStep(span / ticks);
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  if (hi - lo < step / 2) { lo -= step; hi += step; }
  const out = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return { lo: Math.round(lo * 1e6) / 1e6, hi: Math.round(hi * 1e6) / 1e6, step, ticks: out };
}

const LINE_PAD = { left: 40, right: 44, top: 12, bottom: 22 };
const HALF_DAY = 43_200_000;

// lines: [{ cls, points: [{ x: ms, y }], dots?, endLabel? }] drawn in order,
// so the emphasised line goes last. selected: an x to mark with a crosshair.
// The root carries its x-scale (data-*) so the view can hit-test a tap.
export function lineChartSvg({ lines, x0, x1, width, height, format, selected = null, title = '' }) {
  const plotW = width - LINE_PAD.left - LINE_PAD.right;
  const plotH = height - LINE_PAD.top - LINE_PAD.bottom;
  const base = LINE_PAD.top + plotH;
  // A single day still needs a span to place it in.
  const [d0, d1] = x1 > x0 ? [x0, x1] : [x0 - HALF_DAY, x1 + HALF_DAY];
  const ys = lines.flatMap((l) => l.points.map((p) => p.y));
  const dom = ys.length ? niceDomain(Math.min(...ys), Math.max(...ys)) : { lo: 0, hi: 1, ticks: [0, 1] };
  const sx = (x) => LINE_PAD.left + ((x - d0) / (d1 - d0)) * plotW;
  const sy = (y) => base - ((y - dom.lo) / (dom.hi - dom.lo)) * plotH;

  const parts = [`<svg class="chart line-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(title)}" `
    + `data-x0="${d0}" data-x1="${d1}" data-left="${LINE_PAD.left}" data-plot-width="${r2(plotW)}">`];
  for (const t of dom.ticks) {
    const y = r2(sy(t));
    parts.push(`<line class="grid" x1="${LINE_PAD.left}" x2="${width - LINE_PAD.right}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text class="tick" x="${LINE_PAD.left - 6}" y="${y}" dy="0.32em" text-anchor="end">${esc(format(t))}</text>`);
  }
  const labels = Math.max(2, Math.floor(plotW / 80));
  for (let k = 0; k < labels; k++) {
    const t = d0 + (k * (d1 - d0)) / (labels - 1);
    const anchor = k === 0 ? 'start' : k === labels - 1 ? 'end' : 'middle';
    parts.push(`<text class="xlabel" x="${r2(sx(t))}" y="${height - 6}" text-anchor="${anchor}">${esc(weekLabel(t))}</text>`);
  }
  if (selected != null) {
    const x = r2(sx(selected));
    parts.push(`<line class="crosshair" x1="${x}" x2="${x}" y1="${LINE_PAD.top}" y2="${r2(base)}"/>`);
  }
  for (const l of lines) {
    if (!l.points.length) continue;
    const d = l.points.map((p, i) => `${i ? 'L' : 'M'}${r2(sx(p.x))} ${r2(sy(p.y))}`).join('');
    parts.push(`<path class="${l.cls}" d="${d}"/>`);
    for (const p of l.points) {
      const sel = selected != null && p.x === selected;
      if (l.dots || sel) parts.push(`<circle class="dot ${l.cls}${sel ? ' sel' : ''}" cx="${r2(sx(p.x))}" cy="${r2(sy(p.y))}" r="4"/>`);
    }
    if (l.endLabel) {
      const last = l.points.at(-1);
      parts.push(`<text class="end-label" x="${r2(sx(last.x) + 8)}" y="${r2(sy(last.y))}" dy="0.32em">${esc(format(last.y))}</text>`);
    }
  }
  parts.push(`<line class="axis" x1="${LINE_PAD.left}" x2="${width - LINE_PAD.right}" y1="${r2(base)}" y2="${r2(base)}"/>`);
  parts.push(`<rect class="hit-area" x="${LINE_PAD.left}" y="${LINE_PAD.top}" width="${r2(plotW)}" height="${r2(plotH + LINE_PAD.bottom)}" tabindex="0" aria-label="${esc(title)}"/>`);
  parts.push('</svg>');
  return parts.join('');
}
