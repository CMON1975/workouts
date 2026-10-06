// The Stats view's DOM. Read-only and network-required: it has nothing to
// lose on a tab eviction, so it skips the drafts/outbox machinery. Every
// name from the server goes in through textContent, never markup.
import {
  METRICS, SERIES_LABELS, RANGES, inRange, weeklySeries, totals, formatDuration, formatCompact,
} from './stats.js';
import { stackedColumnsSvg } from './charts.js';
import { iconSvg } from './icons.js';

const RANGE_LABELS = { '4w': '4 wk', '12w': '12 wk', all: 'All' };
const RANGE_PHRASE = { '4w': 'last 4 weeks', '12w': 'last 12 weeks', all: 'all time' };
// Time ticks land on whole quarter hours and hours.
const TIME_STEPS = [300, 600, 900, 1800, 3600, 5400, 7200, 10800, 14400, 18000, 36000];
const CHART_HEIGHT = 180;

function el(tag, attrs = {}, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// A refetch keeps the previous render, dimmed, instead of flashing a
// skeleton; only a first load says "Loading".
export function renderStatsLoading(root) {
  if (root.childElementCount && !root.querySelector('#stats-retry')) {
    root.classList.add('stale');
    root.setAttribute('aria-busy', 'true');
    return;
  }
  root.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
}

export function renderStatsError(root, onRetry) {
  root.classList.remove('stale');
  root.removeAttribute('aria-busy');
  const retry = el('button', { id: 'stats-retry', type: 'button', class: 'secondary' }, 'Retry');
  retry.addEventListener('click', onRetry);
  root.replaceChildren(el('p', { class: 'err' }, 'Couldn’t load stats. Check the connection and try again.'), retry);
}

function chips(name, options, current, onPick) {
  const group = el('div', { class: 'chips', role: 'group', 'aria-label': name });
  for (const [value, label] of options) {
    const b = el('button', { type: 'button', class: 'secondary chip', [`data-${name.toLowerCase()}`]: value, 'aria-pressed': String(value === current) }, label);
    b.addEventListener('click', () => onPick(value));
    group.append(b);
  }
  return group;
}

function kpi(key, icon, label, value, sub) {
  const tile = el('div', { class: 'kpi', 'data-kpi': key });
  const head = el('span', { class: 'kpi-label' });
  head.innerHTML = iconSvg(icon);
  head.append(label);
  tile.append(head, el('span', { class: 'kpi-value' }, value), el('span', { class: 'kpi-sub' }, sub));
  return tile;
}

function kpiTiles(t, range) {
  const measured = t.seconds ? Math.round((t.measured_seconds / t.seconds) * 100) : 0;
  const grid = el('div', { class: 'kpis' });
  grid.append(
    kpi('time', 'timer', 'Time', formatDuration(t.seconds), `${measured}% measured`),
    kpi('energy', 'flame', 'Active energy', `${formatCompact(t.kcal)} kcal`, 'estimated'),
    kpi('weight', 'dumbbell', 'Weight moved', `${formatCompact(t.moved_lb)} lb`,
      `${formatCompact(t.lifted_lb)} lifted · ${formatCompact(t.bw_lb)} bodyweight (est.) · ${formatCompact(t.carried_lb)} carried (est.)`),
    kpi('reps', 'repeat-2', 'Reps', formatCompact(t.reps), `${t.sessions} sessions`),
    kpi('distance', 'footprints', 'Distance', `${formatCompact(t.distance_km)} km`, 'walks and intervals'),
    kpi('days', 'calendar-check', 'Active days', String(t.active_days), RANGE_PHRASE[range]),
  );
  return grid;
}

function readoutText(week, metric) {
  if (!week) return '';
  const head = `Week of ${week.label} · ${metric.format(week.total)}`;
  if (metric.keys.length < 2) return head;
  return `${head} (${metric.keys.map((k) => `${SERIES_LABELS[k]} ${metric.format(week.parts[k])}`).join(', ')})`;
}

function chartFigure(weeks, metricName, selected, onSelect, focusWeek) {
  const metric = METRICS[metricName];
  const figure = el('figure', { id: 'stats-chart', class: 'stats-card' });
  figure.append(el('figcaption', { class: 'stats-card-title' }, `${metric.label} per week`));
  const legendList = el('ul', { class: 'legend' });
  if (metric.keys.length > 1) {
    metric.keys.forEach((k, i) => {
      const li = el('li');
      li.append(el('span', { class: `swatch seg-${i + 1}`, 'aria-hidden': 'true' }), SERIES_LABELS[k]);
      legendList.append(li);
    });
  }
  const plot = el('div', { class: 'stats-plot' });
  const readout = el('p', { id: 'stats-readout', class: 'stats-readout', 'aria-live': 'polite' }, readoutText(weeks[selected], metric));
  figure.append(legendList, plot, readout);

  // Called once the figure is in the document, so the plot has a width.
  const draw = () => {
    const width = Math.max(240, Math.round(plot.clientWidth || 340));
    plot.innerHTML = stackedColumnsSvg({
      weeks, keys: metric.keys, width, height: CHART_HEIGHT, selected,
      format: metric.format, steps: metricName === 'time' ? TIME_STEPS : null,
      title: `${metric.label} per week`,
    });
    // A keyboard selection re-renders; put focus back on the same week.
    if (focusWeek != null) plot.querySelector(`g.col[data-index="${focusWeek}"] .hit`)?.focus();
  };
  const indexOf = (target) => Number(target.closest?.('g.col')?.dataset.index ?? NaN);
  plot.addEventListener('click', (e) => {
    const i = indexOf(e.target);
    if (Number.isInteger(i)) onSelect(i, false);
  });
  plot.addEventListener('keydown', (e) => {
    const i = indexOf(e.target);
    if (!Number.isInteger(i)) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i, true); }
  });
  // Focus previews a week in the readout without moving the selection.
  plot.addEventListener('focusin', (e) => {
    const i = indexOf(e.target);
    if (Number.isInteger(i)) readout.textContent = readoutText(weeks[i], metric);
  });
  return { figure, draw };
}

// state: { range, metric, selected }; onState(patch) re-renders.
export function renderStatsView(root, { payload, state, now = Date.now(), onState, focusWeek = null }) {
  root.classList.remove('stale');
  root.removeAttribute('aria-busy');
  if (!payload.sessions.length) {
    root.replaceChildren(el('p', { id: 'stats-empty', class: 'muted' }, 'No finished workouts yet.'));
    return;
  }
  const sessions = inRange(payload.sessions, state.range, now);
  const weeks = weeklySeries(payload.sessions, { range: state.range, metric: state.metric, now });
  const selected = state.selected ?? weeks.length - 1;

  const filters = el('div', { class: 'stats-filters' });
  filters.append(
    chips('Range', Object.keys(RANGES).map((r) => [r, RANGE_LABELS[r]]), state.range, (range) => onState({ range, selected: null })),
    chips('Metric', Object.entries(METRICS).map(([m, d]) => [m, d.label]), state.metric, (metric) => onState({ metric, selected: null })),
  );
  const { figure, draw } = chartFigure(weeks, state.metric, selected, (i, keyboard) => onState({ selected: i }, { focusWeek: keyboard ? i : null }), focusWeek);
  root.replaceChildren(filters, kpiTiles(totals(sessions), state.range), figure);
  draw();
}
