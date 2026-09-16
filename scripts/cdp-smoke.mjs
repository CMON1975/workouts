#!/usr/bin/env node
// Real-browser smoke for the runner: drives headless Chromium over the
// DevTools protocol with a fresh profile (empty IndexedDB / localStorage),
// waits real seconds for the app's fetch chain, then evaluates expressions
// in the page and prints the results plus any console output / exceptions.
//
//   node scripts/cdp-smoke.mjs <url> [--wait=ms] <expr> [<expr> ...]
//
// An expression that returns a Promise is awaited, so a fetch chain can be
// waited on inline: 'new Promise(r => setTimeout(() => r(...), 800))'.
//
// e.g. against a dev server with an open workout on it:
//   node scripts/cdp-smoke.mjs http://127.0.0.1:8787/ \
//     'document.getElementById("runner").hidden' \
//     'document.getElementById("runner-step").textContent'
//
// Why not --dump-dom with --virtual-time-budget: virtual time fires the dump
// before the app's network chain finishes, so the runner never appears.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const waitArg = args.find(a => a.startsWith('--wait='));
const waitMs = waitArg ? Number(waitArg.slice(7)) : 4000;
const [url, ...exprs] = args.filter(a => !a.startsWith('--'));
if (!url) {
  console.error('usage: node scripts/cdp-smoke.mjs <url> [--wait=ms] <expr> ...');
  process.exit(2);
}

const port = 9333 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(join(tmpdir(), 'workouts-cdp-'));
const chrome = spawn(process.env.CHROMIUM || 'chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function json(u) { const r = await fetch(u); return r.json(); }

let exitCode = 0;
try {
  let targets = null;
  for (let i = 0; i < 50 && !targets; i += 1) {
    try { targets = await json(`http://127.0.0.1:${port}/json`); } catch { await sleep(200); }
  }
  if (!targets) throw new Error('chromium did not open its debugging port');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  };
  const send = (method, params = {}) => new Promise(r => {
    id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(waitMs);
  for (const e of exprs) {
    // awaitPromise: an expression may return a Promise (e.g. a setTimeout wait for a fetch chain)
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    const val = r.result?.result?.value ?? r.result?.exceptionDetails?.text;
    console.log(e, '=>', JSON.stringify(val));
  }
  if (logs.length) console.log('console:\n  ' + logs.join('\n  '));
  if (logs.some(l => l.startsWith('EXC:') || l.startsWith('error:'))) exitCode = 1;
  ws.close();
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  chrome.kill();
  rmSync(prof, { recursive: true, force: true });
}
process.exit(exitCode);
