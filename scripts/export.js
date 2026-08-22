#!/usr/bin/env node
// Reads finalized workouts + standalone sessions from the workouts SQLite DB
// and writes a Markdown snapshot to <out>/workouts-YYYY-MM-DD.md (UTC date).
// Same-day re-runs overwrite that day's file; different days produce new files.
// Designed for an LLM in another project to scan and analyze.
//
// Usage: npm run export -- --out <dir> [--with-json] [--since <Nd>]

import { writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function ymdUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function fmtMSS(seconds) {
  const m = Math.floor(seconds / 60);
  return `${m}:${pad2(seconds % 60)}`;
}

function colHeader(col) {
  return col.unit ? `${col.name} (${col.unit})` : col.name;
}

function cellValue(values, rowIndex, col) {
  const v = values.find(x => x.row_index === rowIndex && x.column_id === col.id);
  if (!v) return '';
  if (col.value_type === 'text') return v.value_text ?? '';
  return v.value_num != null ? String(v.value_num) : '';
}

function renderTable(session) {
  if (!session.values.length) return '_(no values recorded)_';
  const cols = [...session.columns].sort((a, b) => a.position - b.position);
  const maxRow = session.values.reduce((m, v) => Math.max(m, v.row_index), -1);
  const rows = maxRow + 1;
  const headers = ['Set', ...cols.map(colHeader)];
  const lines = [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
  ];
  for (let r = 0; r < rows; r++) {
    const cells = [String(r + 1), ...cols.map(c => cellValue(session.values, r, c))];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderCheckbox(session) {
  const col = session.columns.find(c => c.name === 'completed');
  const v = col && session.values.find(x => x.row_index === 0 && x.column_id === col.id);
  const status = v?.value_num === 1 ? '✓ Done' : '✗ Not done';
  const parts = [];
  if (session.template_description) parts.push(`> ${session.template_description}`);
  parts.push(`**Status:** ${status}`);
  return parts.join('\n\n');
}

function nameWithArchived(session) {
  return session.template_archived
    ? `${session.template_name} (archived)`
    : session.template_name;
}

function renderSession(s, { workoutRoutineName }) {
  const contextParts = [];
  if (workoutRoutineName) contextParts.push(`${workoutRoutineName} workout`);
  else contextParts.push('standalone');
  if (s.template_kind === 'checkbox') contextParts.push('checkbox');
  const tag = contextParts.join(', ');

  const parts = [`## ${fmtDate(s.finalized_at)} — ${nameWithArchived(s)} (${tag})`];
  if (s.duration_seconds != null) parts.push(`**Duration:** ${fmtMSS(s.duration_seconds)}`);
  if (s.notes) parts.push(`**Notes:** ${s.notes}`);
  parts.push(s.template_kind === 'checkbox' ? renderCheckbox(s) : renderTable(s));
  return parts.join('\n\n');
}

function countSets(s) {
  if (!s.values.length) return 0;
  return s.values.reduce((m, v) => Math.max(m, v.row_index), -1) + 1;
}

export function renderMarkdown({ workouts, standalone, exportedAt, dbPath, sinceLabel }) {
  // Flatten: every finalized session becomes a top-level entry. Workouts contribute
  // their child sessions tagged with the workout's routine name.
  const items = [];
  for (const w of workouts) {
    for (const s of (w.sessions ?? [])) {
      items.push({ session: s, workoutRoutineName: w.routine_name });
    }
  }
  for (const s of standalone) {
    items.push({ session: s, workoutRoutineName: null });
  }
  items.sort((a, b) => (b.session.finalized_at ?? 0) - (a.session.finalized_at ?? 0));

  const totalSets = items.reduce((a, it) => a + countSets(it.session), 0);

  const header = [
    '# Workout history',
    '',
    `_Exported ${fmtDate(exportedAt)} UTC from ${dbPath}_  `,
    '_All times below are in UTC._',
    ...(sinceLabel ? ['', `_Window: ${sinceLabel}_`] : []),
    '',
    `**Totals:** ${items.length} sessions · ${totalSets} finalized sets`,
    '',
    '---',
    '',
  ];

  const blocks = items.map(it => renderSession(it.session, { workoutRoutineName: it.workoutRoutineName }));
  return header.join('\n') + blocks.join('\n\n---\n\n') + (blocks.length ? '\n' : '');
}

// --- DB read ---------------------------------------------------------------

export function parseSince(s) {
  const m = /^(\d+)d$/.exec(s);
  if (!m) throw new Error(`invalid --since value: ${s} (expected e.g. "7d")`);
  return Number(m[1]);
}

export function loadExportData(dbPath, { since = null } = {}) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const colsByTpl = new Map();
    const allCols = db.prepare(`
      SELECT id, template_id, name, unit, position, value_type
        FROM template_columns
       ORDER BY template_id, position
    `).all();
    for (const c of allCols) {
      if (!colsByTpl.has(c.template_id)) colsByTpl.set(c.template_id, []);
      colsByTpl.get(c.template_id).push({
        id: c.id, name: c.name, unit: c.unit,
        position: c.position, value_type: c.value_type,
      });
    }

    const valsBySession = new Map();
    const allVals = db.prepare(`
      SELECT session_id, row_index, column_id, value_num, value_text
        FROM session_values
       ORDER BY session_id, row_index, column_id
    `).all();
    for (const v of allVals) {
      if (!valsBySession.has(v.session_id)) valsBySession.set(v.session_id, []);
      valsBySession.get(v.session_id).push({
        row_index: v.row_index, column_id: v.column_id,
        value_num: v.value_num, value_text: v.value_text,
      });
    }

    const sessionSql = `
      SELECT s.id, s.template_id, s.workout_id,
             s.started_at, s.finalized_at, s.notes, s.duration_seconds,
             t.name AS template_name, t.kind AS template_kind,
             t.description AS template_description,
             t.archived_at AS template_archived_at
        FROM sessions s
        JOIN templates t ON t.id = s.template_id
       WHERE s.finalized_at IS NOT NULL
         ${since != null ? 'AND s.finalized_at >= @since' : ''}
       ORDER BY s.finalized_at DESC, s.started_at DESC
    `;
    const sessionRows = since != null
      ? db.prepare(sessionSql).all({ since })
      : db.prepare(sessionSql).all();

    const shapeSession = (r) => ({
      id: r.id,
      template_name: r.template_name,
      template_kind: r.template_kind,
      template_description: r.template_description,
      template_archived: r.template_archived_at != null,
      started_at: r.started_at,
      finalized_at: r.finalized_at,
      notes: r.notes,
      duration_seconds: r.duration_seconds,
      columns: colsByTpl.get(r.template_id) ?? [],
      values: valsBySession.get(r.id) ?? [],
    });

    const workoutRows = db.prepare(`
      SELECT w.id, w.routine_id, w.started_at, w.finalized_at, w.duration_seconds,
             r.name AS routine_name
        FROM workouts w
        JOIN routines r ON r.id = w.routine_id
       WHERE w.finalized_at IS NOT NULL
       ORDER BY w.finalized_at DESC
    `).all();

    const sessionsByWorkout = new Map();
    const standalone = [];
    for (const sr of sessionRows) {
      const shaped = shapeSession(sr);
      if (sr.workout_id) {
        if (!sessionsByWorkout.has(sr.workout_id)) sessionsByWorkout.set(sr.workout_id, []);
        sessionsByWorkout.get(sr.workout_id).push(shaped);
      } else {
        standalone.push(shaped);
      }
    }

    const workouts = workoutRows.map(w => ({
      id: w.id,
      routine_name: w.routine_name,
      started_at: w.started_at,
      finalized_at: w.finalized_at,
      duration_seconds: w.duration_seconds,
      sessions: sessionsByWorkout.get(w.id) ?? [],
    }));

    return { workouts, standalone };
  } finally {
    db.close();
  }
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = { out: null, withJson: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { args.out = argv[++i]; continue; }
    if (a === '--with-json') { args.withJson = true; continue; }
    if (a === '--since') { args.since = argv[++i]; continue; }
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); }
  catch { return false; }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help || !args.out) {
    console.error('usage: npm run export -- --out <dir> [--with-json] [--since <Nd>]');
    process.exit(args.help ? 0 : 2);
  }
  const outDir = resolve(args.out);
  if (!isDir(outDir)) {
    console.error(`out directory does not exist: ${outDir}`);
    process.exit(1);
  }
  const dbPath = resolve(process.env.DB_PATH || './data/workouts.db');

  let sinceCutoff = null;
  let sinceLabel = null;
  if (args.since) {
    let days;
    try { days = parseSince(args.since); }
    catch (err) { console.error(err.message); process.exit(2); }
    sinceCutoff = Date.now() - days * 86_400_000;
    sinceLabel = `last ${days} day${days === 1 ? '' : 's'}`;
  }

  const { workouts, standalone } = loadExportData(dbPath, { since: sinceCutoff });
  const exportedAt = Date.now();
  const md = renderMarkdown({ workouts, standalone, exportedAt, dbPath, sinceLabel });

  const datestamp = ymdUTC(exportedAt);
  const mdPath = join(outDir, `workouts-${datestamp}.md`);
  writeFileSync(mdPath, md, 'utf8');

  let jsonPath = null;
  if (args.withJson) {
    jsonPath = join(outDir, `workouts-${datestamp}.json`);
    writeFileSync(jsonPath, JSON.stringify({ workouts, standalone, exportedAt, dbPath }, null, 2), 'utf8');
  }

  const sessionCount = workouts.reduce((a, w) => a + (w.sessions ?? []).length, 0)
                     + standalone.length;
  const setCount = workouts.reduce((a, w) => a + (w.sessions ?? []).reduce((b, s) => b + countSets(s), 0), 0)
                 + standalone.reduce((a, s) => a + countSets(s), 0);
  console.log(`→ exported ${sessionCount} sessions (${setCount} sets) to ${mdPath}${jsonPath ? ' and ' + jsonPath : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
