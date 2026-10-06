// Stacked weekly columns as an SVG string (pure, so node tests can read the
// geometry). Mark specs from the dataviz method: columns at most 24px wide,
// a 4px rounded data-end on the top segment only (square at the baseline),
// a 2px surface gap between segments, hairline grid. Colour comes from CSS
// classes (seg-1..3 -> --color-series-N): SVG attributes can't read var().

const GAP = 2;
const RADIUS = 4;
const MAX_COL = 24;
const PAD = { left: 48, right: 4, top: 8, bottom: 22 };

const r2 = (n) => Math.round(n * 100) / 100;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Ticks from 0 to a clean top. `steps` (ascending) replaces the 1-2-2.5-5
// decades, e.g. minute multiples for a time axis.
export function niceScale(max, ticks = 4, steps = null) {
  if (!(max > 0)) return { max: 1, step: 1, ticks: [0] };
  const raw = max / ticks;
  let step;
  if (steps?.length) {
    step = steps.find((s) => s >= raw) ?? steps.at(-1) * Math.ceil(raw / steps.at(-1));
  } else {
    const mag = 10 ** Math.floor(Math.log10(raw));
    step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
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
