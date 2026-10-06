#!/usr/bin/env node
// Runner end-to-end: each scenario gets a fresh DB, an in-process server on
// a random port, an imported prescription, and a fresh headless Chromium
// profile; it then presses the stopwatch button with real waits and asserts
// what the bar and the form show. Not part of `npm test` (needs chromium,
// takes real seconds): run `npm run e2e`, or with a name filter,
// `npm run e2e -- dips`.
//
// Rests and holds are a few seconds so the whole run stays short.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/index.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'workouts-e2e-'));
  const app = await buildApp({ dbPath: join(dir, 'e2e.db'), logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    async api(method, path, body) {
      const r = await fetch(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
      return text ? JSON.parse(text) : null;
    },
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// init: a script run before the page's own (e.g. to slow a fetch down).
async function openBrowser(url, { init = null } = {}) {
  const port = 9333 + Math.floor(Math.random() * 500);
  const prof = mkdtempSync(join(tmpdir(), 'workouts-e2e-cdp-'));
  const chrome = spawn(process.env.CHROMIUM || 'chromium', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise(r => chrome.once('exit', r));

  let targets = null;
  for (let i = 0; i < 50 && !targets; i += 1) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); }
  }
  if (!targets) throw new Error('chromium did not open its debugging port');
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) => new Promise(r => {
    id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  if (init) await send('Page.addScriptToEvaluateOnNewDocument', { source: init });
  await send('Page.navigate', { url });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(`page: ${r.result.exceptionDetails.text} in ${expression}`);
    return r.result?.result?.value;
  };
  return {
    evaluate,
    errors,
    async close() {
      ws.close();
      chrome.kill();
      await exited; // chromium writes to its profile until it exits
      rmSync(prof, { recursive: true, force: true });
    },
  };
}

// ---- page helpers --------------------------------------------------------

async function waitFor(page, expression, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Stopwatch bar as { label, time, state }: label is the button's
// aria-label, state is 'resting' | 'working' | 'idle'.
const bar = (page) => page.evaluate(`(() => {
  const t = document.getElementById('stopwatch-time');
  const state = t.classList.contains('resting') ? 'resting'
    : t.classList.contains('working') ? 'working' : 'idle';
  return { label: document.getElementById('stopwatch-btn').getAttribute('aria-label'), time: t.textContent, state };
})()`);

const press = (page) => page.evaluate(`document.getElementById('stopwatch-btn').click()`);

// Placeholders of the runner's inputs, in DOM order: "0:reps (reps)".
const inputs = (page) => page.evaluate(`[...document.querySelectorAll('#runner-root input')]
  .map(i => i.dataset.rowIndex + ':' + i.placeholder)`);

const inputValue = (page, row, name) => page.evaluate(`(() => {
  const i = [...document.querySelectorAll('#runner-root input[data-row-index="${row}"]')]
    .find(x => x.placeholder.startsWith(${JSON.stringify(name)}));
  return i ? i.value : null;
})()`);

async function startRoutine(server) {
  const page = await openBrowser(server.base + '/');
  await waitFor(page, `!!document.querySelector('#routine-list button')`, 'the routine list');
  await page.evaluate(`document.querySelector('#routine-list button').click()`);
  await waitFor(page, `!document.getElementById('stopwatch-bar').hidden
    && document.querySelectorAll('#runner-root input').length > 0`, 'the runner');
  return page;
}

function importWeek(server, exercise) {
  return server.api('POST', '/api/prescriptions/import', {
    week_starts_on: '2026-09-28',
    week_ends_on: '2026-10-04',
    source: 'e2e',
    max_new_routines: 1,
    max_new_templates: 1,
    days: [{ routine_name: 'E2E', exercises: [exercise] }],
  });
}

// Dip progression's shape: a time column, three reps-only rows.
const DIPS = {
  template_name: 'Dip progression (scaled)',
  kind: 'standard',
  columns: [
    { name: 'time', unit: 'sec', value_type: 'number' },
    { name: 'reps', unit: 'reps', value_type: 'number' },
  ],
  default_rows: 3,
  rows_fixed: 0,
  rest_seconds: 3,
  targets: [0, 1, 2].map(r => ({ row_index: r, column: 'reps', target_num: 5 })),
};

// Two finished sessions for the stats view: split squats a minute ago
// (3 x 10/side @ 9.5 per DB, 600 s on the stopwatch) and a 45-minute Zone 2
// walk at 5 kph a week ago (2,700 s), over a 100 kg weigh-in.
async function seedStats(server) {
  await server.api('POST', '/api/prescriptions/import', {
    week_starts_on: '2026-09-28', week_ends_on: '2026-10-04', source: 'e2e', max_new_routines: 1, max_new_templates: 2,
    days: [{ routine_name: 'E2E', exercises: [
      { template_name: 'DB Split squat', kind: 'standard', default_rows: 3, rows_fixed: 0, rest_seconds: 90, targets: [],
        columns: [{ name: 'reps', unit: null, value_type: 'text' }, { name: 'weight', unit: 'lb', value_type: 'text' }] },
      { template_name: 'Zone 2', kind: 'standard', default_rows: 1, rows_fixed: 1, targets: [],
        columns: [{ name: 'time', unit: 'min', value_type: 'text' }, { name: 'speed', unit: 'kph', value_type: 'text' }] },
    ] }],
  });
  const tpls = await server.api('GET', '/api/templates');
  const col = (tpl, name) => tpl.columns.find(c => c.name === name).id;
  const squat = tpls.find(t => t.name === 'DB Split squat');
  const walk = tpls.find(t => t.name === 'Zone 2');
  const now = Date.now();
  const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  await server.api('POST', '/api/body-metrics', { date: day(now - 10 * 86_400_000), metric: 'body_weight', value: '100' });
  const finish = async (id, tpl, startedAt, values, durationSeconds) => {
    await server.api('PATCH', `/api/drafts/${id}`, { id, template_id: tpl.id, started_at: startedAt, updated_at: startedAt, client_version: 1, values });
    await server.api('POST', `/api/sessions/${id}/finalize`, { client_version: 1, duration_seconds: durationSeconds });
  };
  await finish('019f1111-0000-7000-8000-000000000001', squat, now - 60_000,
    [0, 1, 2].flatMap(r => [{ row_index: r, column_id: col(squat, 'reps'), value_text: '10' }, { row_index: r, column_id: col(squat, 'weight'), value_text: '9.5' }]), 600);
  await finish('019f1111-0000-7000-8000-000000000002', walk, now - 7 * 86_400_000,
    [{ row_index: 0, column_id: col(walk, 'time'), value_text: '45' }, { row_index: 0, column_id: col(walk, 'speed'), value_text: '5' }], 2700);
}

async function openStatsView(page) {
  await waitFor(page, `!document.getElementById('open-stats').hidden`, 'the stats button');
  await page.evaluate(`document.getElementById('open-stats').click()`);
  await waitFor(page, `!!document.querySelector('#stats-root .kpi')`, 'the stats tiles');
}

const kpis = (page) => page.evaluate(`Object.fromEntries([...document.querySelectorAll('#stats-root .kpi')]
  .map(k => [k.dataset.kpi, k.querySelector('.kpi-value').textContent]))`);
const legend = (page) => page.evaluate(`[...document.querySelectorAll('#stats-chart .legend li')].map(li => li.textContent)`);
const columns = (page) => page.evaluate(`document.querySelectorAll('#stats-chart svg g.col').length`);
const chip = (page, attr, value) => page.evaluate(`document.querySelector('#stats-root [data-${attr}="${value}"]').click()`);

// ---- scenarios -----------------------------------------------------------

const scenarios = {
  // HANDOFF 2026-09-27 (12f25e2): "Start set" mid-rest must start the next
  // reps-only set, not mark it done and restart the rest.
  async 'dips: Start set mid-rest starts the set; Done starts the rest'(server) {
    await importWeek(server, DIPS);
    const page = await startRoutine(server);
    try {
      assert.deepEqual(await bar(page), { label: 'Rest', time: '0:03', state: 'idle' }, 'armed: press = set done');
      await press(page); // set 1 done
      assert.equal((await bar(page)).state, 'resting');
      await sleep(1200);
      await press(page); // Start set, mid-rest
      assert.deepEqual(await bar(page), { label: 'Done', time: '0:00', state: 'working' }, 'set 2 in progress');
      await sleep(1200);
      await press(page); // set 2 done
      assert.deepEqual(await bar(page), { label: 'Start set', time: '0:03', state: 'resting' }, 'rest after set 2');
      await sleep(3500);
      assert.equal((await bar(page)).state, 'idle', 'the rest runs out by itself');
      return page.errors;
    } finally { await page.close(); }
  },

  // A timed hold counts down its target and writes the time into the cell.
  async 'plank: a timed hold records its time into the time cell'(server) {
    await importWeek(server, {
      template_name: 'Plank',
      kind: 'standard',
      columns: [{ name: 'time', unit: 'seconds', value_type: 'number' }],
      default_rows: 2,
      rows_fixed: 0,
      rest_seconds: 2,
      targets: [0, 1].map(r => ({ row_index: r, column: 'time', target_num: 2 })),
    });
    const page = await startRoutine(server);
    try {
      assert.deepEqual(await bar(page), { label: 'Start set', time: '0:02', state: 'idle' });
      await press(page);
      assert.equal((await bar(page)).state, 'working');
      await sleep(2600);
      assert.equal((await bar(page)).state, 'resting', 'hold ran into its rest');
      assert.equal(await inputValue(page, 0, 'time'), '2', 'hold time recorded');
      assert.equal(await inputValue(page, 1, 'time'), '', 'next set untouched');
      return page.errors;
    } finally { await page.close(); }
  },

  // HANDOFF 2026-09-27 (b1e5b02, 24503ba): a retired time column is off the
  // form, and the template runs as a plain rep lift (press = rest).
  async 'retired time column: off the form, plain rest'(server) {
    await importWeek(server, DIPS);
    const [tpl] = (await server.api('GET', '/api/templates')).filter(t => t.name === DIPS.template_name);
    const reps = tpl.columns.find(c => c.name === 'reps');
    await server.api('PATCH', `/api/templates/${tpl.id}`, { columns: [{ id: reps.id, name: 'reps', unit: 'reps' }] });
    const page = await startRoutine(server);
    try {
      assert.deepEqual(await inputs(page), ['0:reps (reps)', '1:reps (reps)', '2:reps (reps)']);
      assert.deepEqual(await bar(page), { label: 'Rest', time: '0:03', state: 'idle' });
      await press(page);
      assert.deepEqual(await bar(page), { label: 'Rest', time: '0:03', state: 'resting' });
      await sleep(3500);
      assert.equal((await bar(page)).state, 'idle');
      await press(page);
      assert.equal((await bar(page)).state, 'resting', 'the next set gets its rest too');
      return page.errors;
    } finally { await page.close(); }
  },

  // The stats view opens from its header button next to History; a fresh
  // DB says so, and a failed fetch offers a retry that recovers.
  async 'stats: header button opens it; empty, error and retry'(server) {
    const page = await openBrowser(server.base + '/');
    try {
      await waitFor(page, `!document.getElementById('open-stats').hidden`, 'the stats button');
      assert.equal(await page.evaluate(`document.getElementById('open-stats').previousElementSibling?.id ?? document.getElementById('open-stats').nextElementSibling?.id`), 'open-history');
      assert.equal(await page.evaluate(`document.getElementById('open-stats').getAttribute('aria-label')`), 'Stats');
      await page.evaluate(`document.getElementById('open-stats').click()`);
      await waitFor(page, `!document.getElementById('stats').hidden && !!document.getElementById('stats-empty')`, 'the empty state');
      assert.equal(await page.evaluate(`document.getElementById('stats-empty').textContent`), 'No finished workouts yet.');

      await page.evaluate(`window.__fetch = window.fetch; window.fetch = (u, o) => String(u).startsWith('/api/stats') ? Promise.reject(new TypeError('offline')) : window.__fetch(u, o)`);
      await page.evaluate(`document.getElementById('stats-back').click()`);
      await waitFor(page, `document.getElementById('stats').hidden`, 'back out of stats');
      await page.evaluate(`document.getElementById('open-stats').click()`);
      await waitFor(page, `!!document.getElementById('stats-retry')`, 'the error state');
      assert.match(await page.evaluate(`document.getElementById('stats-root').textContent`), /Couldn.t load stats/);
      await page.evaluate(`window.fetch = window.__fetch; document.getElementById('stats-retry').click()`);
      await waitFor(page, `!!document.getElementById('stats-empty')`, 'recovery after retry');
      return page.errors;
    } finally { await page.close(); }
  },

  // Boot finishes loading Home after the header buttons appear; a view
  // opened in that window must not be thrown back to Home.
  async 'stats and history opened during boot stay open'(server) {
    const slowRoutines = `const f = window.fetch; window.fetch = (u, o) => String(u).startsWith('/api/routines')
      ? new Promise(r => setTimeout(r, 1500)).then(() => f(u, o)) : f(u, o);`;
    for (const [button, view] of [['open-stats', 'stats'], ['open-history', 'history-menu']]) {
      const page = await openBrowser(server.base + '/', { init: slowRoutines });
      try {
        await waitFor(page, `!document.getElementById('${button}').hidden`, button);
        await page.evaluate(`document.getElementById('${button}').click()`);
        await sleep(2500);
        assert.equal(await page.evaluate(`document.getElementById('${view}').hidden`), false, `${view} still open`);
        assert.deepEqual(page.errors, []);
      } finally { await page.close(); }
    }
    return [];
  },

  // Totals and the weekly chart from two seeded sessions; chips re-slice
  // everything and tapping a week fills the readout.
  async 'stats: totals, chips, weekly chart and readout'(server) {
    await seedStats(server);
    const page = await openBrowser(server.base + '/');
    try {
      await openStatsView(page);
      // all time by default; 600 s + 2,700 s measured
      assert.deepEqual(await kpis(page), {
        time: '55 m', energy: '220 kcal', weight: '12.8K lb', reps: '60', distance: '3.8 km', days: '2',
      });
      assert.equal(await page.evaluate(`document.querySelector('[data-kpi="time"] .kpi-sub').textContent`), '100% measured');
      assert.match(await page.evaluate(`document.querySelector('[data-kpi="weight"] .kpi-sub').textContent`), /1,140 lifted · 11\.6K bodyweight \(est\.\) · 0 carried \(est\.\)/);

      // The chart sits right under the chips, so switching metric is seen
      assert.deepEqual(await page.evaluate(`[...document.getElementById('stats-root').children].slice(0, 3).map(c => c.id || c.className)`),
        ['stats-filters', 'stats-chart', 'kpis']);
      assert.equal(await columns(page), 2, 'two weeks, all time');
      assert.deepEqual(await legend(page), ['Strength', 'Cardio', 'Mobility']);
      assert.match(await page.evaluate(`document.getElementById('stats-readout').textContent`), /10 m/, 'the current week is selected');
      await page.evaluate(`document.querySelector('#stats-chart g.col[data-index="0"] .hit').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      assert.match(await page.evaluate(`document.getElementById('stats-readout').textContent`), /45 m/, 'tapping last week selects it');

      await chip(page, 'metric', 'weight');
      assert.deepEqual(await legend(page), ['Lifted', 'Bodyweight (est.)', 'Carried (est.)']);
      assert.equal(await page.evaluate(`document.querySelector('[data-metric="weight"]').getAttribute('aria-pressed')`), 'true');
      await chip(page, 'metric', 'reps');
      assert.deepEqual(await legend(page), [], 'one series, no legend box');
      await chip(page, 'range', '4w');
      assert.equal(await columns(page), 4);
      return page.errors;
    } finally { await page.close(); }
  },

  // Per-exercise bars follow the metric; the estimates panel and the table
  // view say how every number was reached.
  async 'stats: per-exercise bars, estimates and table view'(server) {
    await seedStats(server);
    const page = await openBrowser(server.base + '/');
    const bars = () => page.evaluate(`[...document.querySelectorAll('#stats-exercises li')]
      .map(li => [li.querySelector('.bar-name').textContent, li.querySelector('.bar-value').textContent])`);
    try {
      await openStatsView(page);
      assert.deepEqual(await bars(), [['Zone 2', '45 m'], ['DB Split squat', '10 m']]);
      await chip(page, 'metric', 'weight');
      assert.deepEqual(await bars(), [['DB Split squat', '12.8K lb']], 'a walk moves no weight');

      const estimates = await page.evaluate(`document.getElementById('stats-estimates').textContent`);
      assert.match(estimates, /How these are estimated/);
      assert.match(estimates, /2 by the stopwatch/);
      assert.match(estimates, /DB Split squat.*2 dumbbells.*per side.*88% body weight/s);
      assert.match(estimates, /Zone 2.*walking equation/s);
      assert.match(estimates, /100 steps a minute/);

      const table = await page.evaluate(`[...document.querySelectorAll('#stats-table tr')].map(tr => [...tr.children].map(c => c.textContent))`);
      assert.deepEqual(table[0], ['Week', 'Lifted', 'Bodyweight (est.)', 'Carried (est.)', 'Total']);
      assert.equal(table.length, 3, 'header + two weeks');
      return page.errors;
    } finally { await page.close(); }
  },
  // Body weight (daily + 7-day average) and waist as line charts under the
  // tiles; a tap picks the nearest reading.
  async 'stats: body weight and waist charts'(server) {
    await seedStats(server); // includes 100 kg ten days ago
    const day = (daysAgo) => { const d = new Date(Date.now() - daysAgo * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    for (const [ago, kg] of [[9, '101.0'], [8, '99.5'], [3, '100.2'], [0, '99.8']]) {
      await server.api('POST', '/api/body-metrics', { date: day(ago), metric: 'body_weight', value: kg });
    }
    for (const [ago, inches] of [[14, '44'], [7, '43.5']]) {
      await server.api('POST', '/api/body-metrics', { date: day(ago), metric: 'waist', value: inches });
    }
    const page = await openBrowser(server.base + '/');
    const card = (id) => page.evaluate(`(() => {
      const c = document.getElementById('${id}');
      return c && {
        legend: [...c.querySelectorAll('.legend li')].map(li => li.textContent),
        lines: [...c.querySelectorAll('svg path')].map(p => p.getAttribute('class')),
        dots: c.querySelectorAll('svg circle.dot').length,
        sub: c.querySelector('.stats-card-sub').textContent,
        readout: c.querySelector('.stats-readout').textContent,
      };
    })()`);
    try {
      await openStatsView(page);
      assert.deepEqual(await page.evaluate(`[...document.getElementById('stats-root').children].map(c => c.id || c.className).slice(2, 5)`),
        ['kpis', 'stats-weight', 'stats-waist'], 'body charts follow the tiles');

      const weight = await card('stats-weight');
      assert.deepEqual(weight.legend, ['Daily', '7-day average']);
      assert.deepEqual(weight.lines, ['line-raw', 'line-main']);
      // 7-day average today: 100.2 (3 days ago) and 99.8 (today); the
      // first weigh-in in range (ten days ago) averaged 100 too
      assert.match(weight.sub, /^100\.0 kg 7-day average · 0\.0 kg since /);
      assert.match(weight.readout, /99\.8 kg · 7-day average 100\.0 kg$/);
      // a tap at the left edge picks the first weigh-in (100 kg, ten days ago)
      await page.evaluate(`(() => {
        const hit = document.querySelector('#stats-weight .hit-area');
        const r = hit.getBoundingClientRect();
        hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 1, clientY: r.top + 5 }));
      })()`);
      assert.match((await card('stats-weight')).readout, /· 100\.0 kg · 7-day average 100\.0 kg$/);

      const waist = await card('stats-waist');
      assert.deepEqual(waist.legend, [], 'one series, no legend');
      assert.equal(waist.dots, 2);
      assert.match(waist.sub, /^43\.5 in · −0\.5 in since /);

      const body = await page.evaluate(`[...document.querySelectorAll('#stats-body-table tr')].map(tr => [...tr.children].map(c => c.textContent))`);
      assert.deepEqual(body[0], ['Date', 'Weight (kg)', '7-day average', 'Waist (in)']);
      assert.equal(body.length, 1 + 7, 'header + every day with a reading');

      await chip(page, 'range', '4w');
      assert.ok(await card('stats-weight'), 'the range chips scope the body charts too');
      return page.errors;
    } finally { await page.close(); }
  },
};

// ---- runner --------------------------------------------------------------

const filter = process.argv.slice(2).join(' ').toLowerCase();
let failed = 0;
for (const [name, run] of Object.entries(scenarios)) {
  if (filter && !name.toLowerCase().includes(filter)) continue;
  const server = await startServer();
  try {
    const errors = await run(server);
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(err.message).split('\n').join('\n     ')}`);
  } finally {
    await server.close();
  }
}
process.exit(failed ? 1 : 0);
