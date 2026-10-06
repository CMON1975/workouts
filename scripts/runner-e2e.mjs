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

async function openBrowser(url) {
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
