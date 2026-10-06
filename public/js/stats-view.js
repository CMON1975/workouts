// The Stats view's DOM. Read-only and network-required: it has nothing to
// lose on a tab eviction, so it skips the drafts/outbox machinery. Every
// name from the server goes in through textContent, never markup.
import {
  METRICS, SERIES_LABELS, RANGES, inRange, weeklySeries, totals, byTemplate, coverage, formatDuration, formatCompact,
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

function exerciseBars(sessions, templates, metricName) {
  const metric = METRICS[metricName];
  const rows = byTemplate(sessions, templates, metricName);
  const card = el('section', { class: 'stats-card' });
  card.append(el('h3', { class: 'stats-card-title' }, `${metric.label} by exercise`));
  if (!rows.length) {
    card.append(el('p', { class: 'muted' }, 'Nothing in this range.'));
    return card;
  }
  const list = el('ol', { id: 'stats-exercises', class: 'bars' });
  const top = rows[0].value;
  for (const r of rows) {
    const li = el('li');
    const track = el('span', { class: 'bar-track', 'aria-hidden': 'true' });
    const fill = el('span', { class: 'bar-fill' });
    fill.style.width = `${Math.max(1, (r.value / top) * 100)}%`;
    track.append(fill);
    li.append(el('span', { class: 'bar-name' }, r.name), el('span', { class: 'bar-value' }, metric.format(r.value)), track);
    list.append(li);
  }
  card.append(list);
  return card;
}

// What a template counts as, in words, from the rule the server applied.
function countsAs(t) {
  const parts = [];
  if (t.category === 'cardio') parts.push(t.met != null ? `cardio at MET ${t.met}` : 'cardio, walking equation');
  else if (t.category === 'mobility') parts.push(`mobility at MET ${t.met}`);
  else if (t.hold) parts.push('hold, time only');
  else {
    if (t.dbs > 0) parts.push(`${t.dbs} dumbbell${t.dbs > 1 ? 's' : ''}${t.value_is === 'total' ? ', weight logged for the pair' : ''}`);
    if (t.carry) parts.push('carried');
    if (t.per_side) parts.push('reps per side');
    if (t.bw_fraction > 0) parts.push(`${Math.round(t.bw_fraction * 100)}% body weight`);
    if (!parts.length) parts.push('reps only');
  }
  if (t.rule == null) parts.push('default for its columns');
  return parts.join(', ');
}

function estimatesPanel(payload, sessions) {
  const a = payload.assumptions;
  const c = coverage(sessions);
  const bw = { logged: 0, nearest: 0, default: 0 };
  let corrected = 0;
  let unparsed = 0;
  let assumedWalks = 0;
  for (const s of sessions) {
    bw[s.bw_source] += 1;
    corrected += s.corrected;
    unparsed += s.unparsed;
    if (s.kcal_basis === 'walk_assumed') assumedWalks += 1;
  }
  const details = el('details', { id: 'stats-estimates', class: 'home-disclosure stats-details' });
  details.append(el('summary', { class: 'home-heading home-disclosure-summary' }, 'How these are estimated'));
  const p = (text) => details.append(el('p', { class: 'stats-note' }, text));
  p(`Time: ${c.stopwatch} by the stopwatch, ${c.span} from start to finish, ${c.logged} from logged work plus rest, `
    + `${c.typical} at the exercise's usual pace, ${c.rule} by the set rule (${a.rep_set_seconds} s a set plus rests). `
    + 'A measured time that is implausible for the sets logged (a forgotten timer, a late finish) is set aside.');
  p(`Body weight: the last weigh-in on or before the day for ${bw.logged}, the nearest weigh-in for ${bw.nearest}, `
    + `the ${a.default_body_kg} kg default for ${bw.default} sessions.`);
  p(`Weight moved: logged weight × dumbbells × reps. Dumbbell logs before ${a.handle.before} lose `
    + `${a.handle.lb_per_db} lb per dumbbell (${corrected} rows): the handle weighs about 0.5 lb, not 5. `
    + `Carries count their weight at ${a.carry_steps_per_minute} steps a minute over the logged time. `
    + 'Bodyweight movements add a share of body weight per rep.');
  p(`Active energy (above resting): walks and intervals use the ACSM walking equation on the logged speed and incline; `
    + `everything else uses a MET (strength ${a.met.strength}, mobility ${a.met.mobility}) over its time.`
    + (assumedWalks ? ` ${assumedWalks} without a logged speed assume ${a.default_walk_kph} kph flat.` : ''));
  if (unparsed) p(`${unparsed} logged values couldn't be read and count as nothing.`);

  const table = el('table', { class: 'detail-table' });
  const head = el('tr');
  head.append(el('th', { scope: 'col' }, 'Exercise'), el('th', { scope: 'col' }, 'Counts as'));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  const used = new Set(sessions.map((s) => s.template_id));
  for (const t of payload.templates.filter((x) => used.has(x.id))) {
    const tr = el('tr');
    tr.append(el('td', {}, t.name), el('td', {}, countsAs(t)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  details.append(table);
  return details;
}

// The chart's accessible twin: every number it draws, as rows.
function tableView(weeks, metricName) {
  const metric = METRICS[metricName];
  const details = el('details', { class: 'home-disclosure stats-details' });
  details.append(el('summary', { class: 'home-heading home-disclosure-summary' }, 'Table view'));
  const table = el('table', { id: 'stats-table', class: 'detail-table' });
  const head = el('tr');
  for (const h of ['Week', ...metric.keys.map((k) => SERIES_LABELS[k]), 'Total']) head.append(el('th', { scope: 'col' }, h));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const w of [...weeks].reverse()) {
    const tr = el('tr');
    tr.append(el('th', { scope: 'row' }, w.label));
    for (const k of metric.keys) tr.append(el('td', {}, metric.format(w.parts[k])));
    tr.append(el('td', {}, metric.format(w.total)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  details.append(table);
  return details;
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
  root.replaceChildren(
    filters, kpiTiles(totals(sessions), state.range), figure,
    exerciseBars(sessions, payload.templates, state.metric),
    estimatesPanel(payload, sessions), tableView(weeks, state.metric),
  );
  draw();
}
