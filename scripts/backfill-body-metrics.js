#!/usr/bin/env node
// One-time backfill: import /home/c/personal_projects/health/bodymetrics.csv into
// the workouts app's body_metrics table via POST /api/body-metrics.
//
// Idempotent: fetches existing rows up-front, skips any CSV row whose
// (date, metric, value) triple is already present.
//
// BP metrics (bp_systolic, bp_diastolic) are skipped because the API enum is
// currently weight + waist only. Reported in the summary; not an error.
//
// Exit codes:
//   0 success (some rows may have been skipped; check the summary)
//   1 file read / parse error
//   2 HTTP non-2xx during fetch or post
//   3 network error
//   4 bad args

import { readFileSync } from 'node:fs';

const DEFAULT_URL = process.env.BACKFILL_URL || 'http://localhost:8787';
const DEFAULT_CSV = '/home/c/personal_projects/health/bodymetrics.csv';
const SUPPORTED_METRICS = new Set(['body_weight', 'waist']);

function printHelp() {
  console.log(`
Usage: node scripts/backfill-body-metrics.js [options]

Reads a long-form CSV (date,metric,value with date as YYYYMMDD) and POSTs
each supported row to {URL}/api/body-metrics. Idempotent.

Options:
  --file, -f PATH    CSV path (default: ${DEFAULT_CSV})
  --url, -u URL      Base URL (default: $BACKFILL_URL or ${DEFAULT_URL})
  --dry-run          Parse + plan; do not POST
  --help, -h         This help

Environment:
  BACKFILL_URL       Base URL override (e.g. https://workouts.cmon1975.com)
`);
}

function parseArgs(argv) {
  const opts = { file: DEFAULT_CSV, url: DEFAULT_URL, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--file' || a === '-f') opts.file = argv[++i];
    else if (a === '--url' || a === '-u') opts.url = argv[++i];
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(4); }
  }
  return opts;
}

function normalizeDate(yyyymmdd) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const header = lines.shift();
  if (!/^date,metric,value$/i.test(header.trim())) {
    throw new Error(`Unexpected header: ${header}`);
  }
  const rows = [];
  for (const line of lines) {
    const [date, metric, ...rest] = line.split(',');
    const value = rest.join(',').trim();
    rows.push({ rawDate: date.trim(), metric: metric.trim(), value });
  }
  return rows;
}

async function fetchExisting(baseUrl) {
  const res = await fetch(`${baseUrl}/api/body-metrics`);
  if (!res.ok) throw new Error(`fetch existing HTTP ${res.status}`);
  return res.json();
}

async function postOne(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/body-metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`POST HTTP ${res.status}: ${txt}`);
  return JSON.parse(txt);
}

async function main() {
  const opts = parseArgs(process.argv);
  let csv;
  try { csv = readFileSync(opts.file, 'utf8'); }
  catch (err) { console.error(`Read failed: ${err.message}`); process.exit(1); }

  let rows;
  try { rows = parseCsv(csv); }
  catch (err) { console.error(`Parse failed: ${err.message}`); process.exit(1); }

  const planned = [];
  const skippedUnsupported = [];
  const skippedBadDate = [];

  for (const r of rows) {
    const date = normalizeDate(r.rawDate);
    if (!date) { skippedBadDate.push(r); continue; }
    if (!SUPPORTED_METRICS.has(r.metric)) { skippedUnsupported.push(r); continue; }
    if (!r.value) { skippedBadDate.push(r); continue; }
    planned.push({ date, metric: r.metric, value: r.value });
  }

  console.log(`CSV rows: ${rows.length}`);
  console.log(`  Planned: ${planned.length}`);
  console.log(`  Skipped (unsupported metric): ${skippedUnsupported.length}` +
    (skippedUnsupported.length ? ` (${[...new Set(skippedUnsupported.map(r => r.metric))].join(', ')})` : ''));
  if (skippedBadDate.length) console.log(`  Skipped (bad date / empty value): ${skippedBadDate.length}`);

  if (opts.dryRun) {
    console.log('Dry run; not posting.');
    return;
  }

  let existing;
  try { existing = await fetchExisting(opts.url); }
  catch (err) { console.error(`Fetch existing failed: ${err.message}`); process.exit(3); }

  const seen = new Set(existing.map(r => `${r.date}|${r.metric}|${r.value}`));
  let posted = 0, skipped = 0, failed = 0;
  for (const row of planned) {
    const key = `${row.date}|${row.metric}|${row.value}`;
    if (seen.has(key)) { skipped++; continue; }
    try {
      await postOne(opts.url, row);
      seen.add(key);
      posted++;
    } catch (err) {
      console.error(`Failed: ${JSON.stringify(row)} — ${err.message}`);
      failed++;
    }
  }
  console.log(`Posted: ${posted}, already present: ${skipped}, failed: ${failed}`);
  if (failed) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
