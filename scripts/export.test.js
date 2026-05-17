import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { renderMarkdown, loadExportData } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const exportScript = resolve(__dirname, 'export.js');

// All times below are produced by the renderer in UTC.
// 2026-05-08 18:42:00 UTC = 1778525320000 ms
// 2026-05-09 12:30:00 UTC = 1778589000000 ms
// 2026-05-10 14:32:00 UTC = 1778682720000 ms

const T_2026_05_08_1842 = Date.UTC(2026, 4, 8, 18, 42, 0);
const T_2026_05_09_1230 = Date.UTC(2026, 4, 9, 12, 30, 0);
const T_2026_05_10_1432 = Date.UTC(2026, 4, 10, 14, 32, 0);

const baseExport = {
  workouts: [],
  standalone: [],
  exportedAt: T_2026_05_10_1432,
  dbPath: 'data/workouts.db',
};

function bicepColumn() {
  return { id: 1, name: 'reps', unit: 'pounds', position: 0, value_type: 'number' };
}

function tricepColumn() {
  return { id: 2, name: 'reps', unit: null, position: 0, value_type: 'number' };
}

test('empty input renders header with zero totals', () => {
  const md = renderMarkdown(baseExport);
  assert.match(md, /^# Workout history$/m);
  assert.match(md, /Exported 2026-05-10 14:32 UTC from data\/workouts\.db/);
  assert.match(md, /All times below are in UTC/);
  assert.match(md, /\*\*Totals:\*\* 0 sessions · 0 finalized sets/);
});

test('single standalone standard session renders a table with column header and rows', () => {
  const md = renderMarkdown({
    ...baseExport,
    standalone: [{
      id: 's1',
      template_name: 'Bicep Curls',
      template_kind: 'standard',
      template_description: null,
      template_archived: false,
      started_at: T_2026_05_08_1842 - 60_000,
      finalized_at: T_2026_05_08_1842,
      notes: null,
      columns: [bicepColumn()],
      values: [
        { row_index: 0, column_id: 1, value_num: 25, value_text: null },
        { row_index: 1, column_id: 1, value_num: 25, value_text: null },
        { row_index: 2, column_id: 1, value_num: 30, value_text: null },
        { row_index: 3, column_id: 1, value_num: 30, value_text: null },
      ],
    }],
  });

  assert.match(md, /## 2026-05-08 18:42 — Bicep Curls \(standalone\)/);
  assert.match(md, /\| Set \| reps \(pounds\) \|/);
  assert.match(md, /\| 1 \| 25 \|/);
  assert.match(md, /\| 4 \| 30 \|/);
  assert.match(md, /\*\*Totals:\*\* 1 sessions · 4 finalized sets/);
});

test('checkbox session renders description and status', () => {
  const md = renderMarkdown({
    ...baseExport,
    standalone: [{
      id: 's2',
      template_name: 'Morning stretches',
      template_kind: 'checkbox',
      template_description: '5 minutes of dynamic stretching, focus on hips and shoulders.',
      template_archived: false,
      started_at: T_2026_05_09_1230 - 60_000,
      finalized_at: T_2026_05_09_1230,
      notes: null,
      columns: [{ id: 9, name: 'completed', unit: null, position: 0, value_type: 'number' }],
      values: [{ row_index: 0, column_id: 9, value_num: 1, value_text: null }],
    }],
  });

  assert.match(md, /## 2026-05-09 12:30 — Morning stretches \(standalone, checkbox\)/);
  assert.match(md, /> 5 minutes of dynamic stretching, focus on hips and shoulders\./);
  assert.match(md, /\*\*Status:\*\* ✓ Done/);
});

test('checkbox session not done renders ✗ Not done', () => {
  const md = renderMarkdown({
    ...baseExport,
    standalone: [{
      id: 's3',
      template_name: 'Morning stretches',
      template_kind: 'checkbox',
      template_description: 'desc',
      template_archived: false,
      started_at: T_2026_05_09_1230 - 60_000,
      finalized_at: T_2026_05_09_1230,
      notes: null,
      columns: [{ id: 9, name: 'completed', unit: null, position: 0, value_type: 'number' }],
      values: [{ row_index: 0, column_id: 9, value_num: 0, value_text: null }],
    }],
  });
  assert.match(md, /\*\*Status:\*\* ✗ Not done/);
});

test('workout children render as flat top-level entries tagged with routine name', () => {
  const md = renderMarkdown({
    ...baseExport,
    workouts: [{
      id: 'w1',
      routine_name: 'Arms',
      started_at: T_2026_05_08_1842 - 60_000,
      finalized_at: T_2026_05_08_1842,
      sessions: [
        {
          id: 'wc1',
          template_name: 'Bicep Curls',
          template_kind: 'standard',
          template_description: null,
          template_archived: false,
          started_at: T_2026_05_08_1842 - 60_000,
          finalized_at: T_2026_05_08_1842 - 30_000,
          notes: null,
          columns: [bicepColumn()],
          values: [{ row_index: 0, column_id: 1, value_num: 25, value_text: null }],
        },
        {
          id: 'wc2',
          template_name: 'Tricep Pushdowns',
          template_kind: 'standard',
          template_description: null,
          template_archived: false,
          started_at: T_2026_05_08_1842 - 30_000,
          finalized_at: T_2026_05_08_1842,
          notes: null,
          columns: [tricepColumn()],
          values: [{ row_index: 0, column_id: 2, value_num: 12, value_text: null }],
        },
      ],
    }],
  });

  // Each child session is its own top-level entry, tagged with routine.
  // (fmtDate truncates to minutes: Tricep at 18:42:00 → "18:42", Bicep at 18:41:30 → "18:41".)
  assert.match(md, /## 2026-05-08 18:42 — Tricep Pushdowns \(Arms workout\)/);
  assert.match(md, /## 2026-05-08 18:41 — Bicep Curls \(Arms workout\)/);
  // No workout-level heading anymore.
  assert.doesNotMatch(md, /— Arms \(workout\)/);
  // No nested ### subheadings.
  assert.doesNotMatch(md, /^### Bicep Curls/m);
  assert.match(md, /\| Set \| reps \(pounds\) \|/);
  assert.match(md, /\| Set \| reps \|/);
  assert.match(md, /\*\*Totals:\*\* 2 sessions · 2 finalized sets/);

  // Order: Tricep (finalized later) appears before Bicep.
  const tricepIdx = md.indexOf('Tricep Pushdowns (Arms workout)');
  const bicepIdx = md.indexOf('Bicep Curls (Arms workout)');
  assert.ok(tricepIdx > 0 && bicepIdx > tricepIdx, 'sessions sort by finalized_at desc');
});

test('mixed workouts and standalones interleave by finalized_at desc', () => {
  const md = renderMarkdown({
    ...baseExport,
    workouts: [{
      id: 'wOLD',
      routine_name: 'Arms',
      started_at: T_2026_05_08_1842 - 60_000,
      finalized_at: T_2026_05_08_1842,
      sessions: [{
        id: 'c', template_name: 'Bicep Curls', template_kind: 'standard',
        template_description: null, template_archived: false,
        started_at: T_2026_05_08_1842 - 60_000, finalized_at: T_2026_05_08_1842,
        notes: null, columns: [bicepColumn()],
        values: [{ row_index: 0, column_id: 1, value_num: 20, value_text: null }],
      }],
    }],
    standalone: [{
      id: 'sNEW',
      template_name: 'Pull-ups',
      template_kind: 'standard',
      template_description: null,
      template_archived: false,
      started_at: T_2026_05_09_1230 - 60_000,
      finalized_at: T_2026_05_09_1230,
      notes: null,
      columns: [{ id: 7, name: 'reps', unit: null, position: 0, value_type: 'number' }],
      values: [{ row_index: 0, column_id: 7, value_num: 5, value_text: null }],
    }],
  });

  const newIdx = md.indexOf('Pull-ups (standalone)');
  const oldIdx = md.indexOf('Bicep Curls (Arms workout)');
  assert.ok(newIdx > 0 && oldIdx > newIdx, 'newer entry appears first');
});

test('empty session (no values) renders "(no values recorded)"', () => {
  const md = renderMarkdown({
    ...baseExport,
    standalone: [{
      id: 'se',
      template_name: 'Run',
      template_kind: 'standard',
      template_description: null,
      template_archived: false,
      started_at: T_2026_05_08_1842 - 60_000,
      finalized_at: T_2026_05_08_1842,
      notes: null,
      columns: [{ id: 5, name: 'minutes', unit: null, position: 0, value_type: 'number' }],
      values: [],
    }],
  });
  assert.match(md, /_\(no values recorded\)_/);
});

test('archived template name suffixed with "(archived)"', () => {
  const md = renderMarkdown({
    ...baseExport,
    standalone: [{
      id: 'sa',
      template_name: 'Old Exercise',
      template_kind: 'standard',
      template_description: null,
      template_archived: true,
      started_at: T_2026_05_08_1842 - 60_000,
      finalized_at: T_2026_05_08_1842,
      notes: null,
      columns: [{ id: 6, name: 'reps', unit: null, position: 0, value_type: 'number' }],
      values: [{ row_index: 0, column_id: 6, value_num: 10, value_text: null }],
    }],
  });
  assert.match(md, /## 2026-05-08 18:42 — Old Exercise \(archived\) \(standalone\)/);
});

test('notes field included verbatim under heading', () => {
  const md = renderMarkdown({
    ...baseExport,
    standalone: [{
      id: 'sn',
      template_name: 'Bicep Curls',
      template_kind: 'standard',
      template_description: null,
      template_archived: false,
      started_at: T_2026_05_08_1842 - 60_000,
      finalized_at: T_2026_05_08_1842,
      notes: 'felt strong on set 3, dropped weight on set 4 due to elbow tweak',
      columns: [bicepColumn()],
      values: [{ row_index: 0, column_id: 1, value_num: 25, value_text: null }],
    }],
  });
  assert.match(md, /\*\*Notes:\*\* felt strong on set 3, dropped weight on set 4 due to elbow tweak/);
});

test('text column renders raw value, omits unit', () => {
  const md = renderMarkdown({
    ...baseExport,
    standalone: [{
      id: 'st',
      template_name: 'Plank',
      template_kind: 'standard',
      template_description: null,
      template_archived: false,
      started_at: T_2026_05_08_1842 - 60_000,
      finalized_at: T_2026_05_08_1842,
      notes: null,
      columns: [{ id: 8, name: 'duration', unit: null, position: 0, value_type: 'text' }],
      values: [{ row_index: 0, column_id: 8, value_num: null, value_text: '1:30' }],
    }],
  });
  assert.match(md, /\| Set \| duration \|/);
  assert.match(md, /\| 1 \| 1:30 \|/);
});

test('CLI runs against a real DB and writes a dated workouts-YYYY-MM-DD.md with expected counts', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'workouts-export-'));
  const dbPath = join(tmp, 'test.db');
  const outDir = join(tmp, 'out');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir);
  try {
    // Set up schema via the same migration runner the app uses, then seed.
    const { openDb } = await import('../server/db.js');
    const db = openDb(dbPath);
    const tplId = db.prepare(`SELECT id FROM templates WHERE name='Bicep Curls'`).get().id;
    const colId = db.prepare(`SELECT id FROM template_columns WHERE template_id=?`).get(tplId).id;

    // Standalone finalized session.
    const sid = '019dbaf9-0000-7000-8000-000000000001';
    const tStandalone = Date.UTC(2026, 4, 8, 18, 42, 0);
    db.prepare(`
      INSERT INTO sessions (id, template_id, started_at, updated_at, finalized_at, client_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sid, tplId, tStandalone - 60000, tStandalone, tStandalone, 1);
    db.prepare(`
      INSERT INTO session_values (session_id, row_index, column_id, value_num, value_text)
      VALUES (?, 0, ?, 25, NULL), (?, 1, ?, 30, NULL)
    `).run(sid, colId, sid, colId);

    // Routine + finalized workout with one child session.
    const routineId = db.prepare(`INSERT INTO routines (name, created_at) VALUES ('Arms', ?)`)
      .run(tStandalone - 86400000).lastInsertRowid;
    db.prepare(`INSERT INTO routine_templates (routine_id, template_id, position) VALUES (?, ?, 0)`)
      .run(routineId, tplId);
    const wid = '019dbaf9-0001-7000-8000-000000000001';
    const tWorkout = Date.UTC(2026, 4, 9, 12, 30, 0);
    db.prepare(`
      INSERT INTO workouts (id, routine_id, started_at, updated_at, finalized_at, client_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(wid, routineId, tWorkout - 1800000, tWorkout, tWorkout, 1);
    const childSid = '019dbaf9-0002-7000-8000-000000000001';
    db.prepare(`
      INSERT INTO sessions (id, template_id, workout_id, started_at, updated_at, finalized_at, client_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(childSid, tplId, wid, tWorkout - 1800000, tWorkout, tWorkout, 1);
    db.prepare(`
      INSERT INTO session_values (session_id, row_index, column_id, value_num, value_text)
      VALUES (?, 0, ?, 100, NULL)
    `).run(childSid, colId);
    db.close();

    // Run the script.
    execFileSync(process.execPath, [exportScript, '--out', outDir], {
      env: { ...process.env, DB_PATH: dbPath },
      stdio: 'pipe',
    });

    const mdFiles = readdirSync(outDir).filter(f => /^workouts-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    assert.equal(mdFiles.length, 1, 'exactly one dated workouts-YYYY-MM-DD.md must exist');
    const md = readFileSync(join(outDir, mdFiles[0]), 'utf8');
    assert.match(md, /\*\*Totals:\*\* 2 sessions · 3 finalized sets/);
    // Workout's child Bicep Curls (finalized at tWorkout, 2026-05-09 12:30) is newer.
    assert.match(md, /## 2026-05-09 12:30 — Bicep Curls \(Arms workout\)/);
    assert.match(md, /## 2026-05-08 18:42 — Bicep Curls \(standalone\)/);
    const workoutChildIdx = md.indexOf('Bicep Curls (Arms workout)');
    const standaloneIdx = md.indexOf('Bicep Curls (standalone)');
    assert.ok(workoutChildIdx > 0 && standaloneIdx > workoutChildIdx, 'newer first');
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI exits non-zero when --out directory does not exist', () => {
  const missing = join(tmpdir(), 'workouts-export-nope-' + Date.now());
  try {
    execFileSync(process.execPath, [exportScript, '--out', missing], { stdio: 'pipe' });
    assert.fail('expected non-zero exit');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /out directory does not exist/);
  }
});

test('renderMarkdown includes window label when sinceLabel provided', () => {
  const md = renderMarkdown({ ...baseExport, sinceLabel: 'last 7 days' });
  assert.match(md, /_Window: last 7 days_/);
});

test('renderMarkdown omits window label when sinceLabel absent', () => {
  const md = renderMarkdown(baseExport);
  assert.doesNotMatch(md, /Window:/);
});

test('CLI --since 7d filters out sessions older than 7 days', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'workouts-export-since-'));
  const dbPath = join(tmp, 'test.db');
  const outDir = join(tmp, 'out');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir);
  try {
    const { openDb } = await import('../server/db.js');
    const db = openDb(dbPath);
    const tplId = db.prepare(`SELECT id FROM templates WHERE name='Bicep Curls'`).get().id;
    const colId = db.prepare(`SELECT id FROM template_columns WHERE template_id=?`).get(tplId).id;

    const now = Date.now();
    const recent = now - 1 * 86_400_000;   // 1 day ago — inside window
    const old    = now - 10 * 86_400_000;  // 10 days ago — outside window

    const recentId = '019dbaf9-0010-7000-8000-000000000001';
    const oldId    = '019dbaf9-0011-7000-8000-000000000001';
    const ins = db.prepare(`
      INSERT INTO sessions (id, template_id, started_at, updated_at, finalized_at, client_version)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    ins.run(recentId, tplId, recent - 60000, recent, recent);
    ins.run(oldId,    tplId, old - 60000,    old,    old);
    const insVal = db.prepare(`
      INSERT INTO session_values (session_id, row_index, column_id, value_num, value_text)
      VALUES (?, 0, ?, 42, NULL)
    `);
    insVal.run(recentId, colId);
    insVal.run(oldId, colId);
    db.close();

    execFileSync(process.execPath, [exportScript, '--out', outDir, '--since', '7d'], {
      env: { ...process.env, DB_PATH: dbPath },
      stdio: 'pipe',
    });

    const mdFiles = readdirSync(outDir).filter(f => /^workouts-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    assert.equal(mdFiles.length, 1);
    const md = readFileSync(join(outDir, mdFiles[0]), 'utf8');
    assert.match(md, /_Window: last 7 days_/);
    assert.match(md, /\*\*Totals:\*\* 1 sessions · 1 finalized sets/);
    // Recent session was finalized within 7d, old one was not. Spot-check by id
    // via the only count we can pin: exactly one heading.
    const headings = md.match(/^## /gm) ?? [];
    assert.equal(headings.length, 1, 'only the in-window session renders');
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI --since rejects invalid duration', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'workouts-export-bad-since-'));
  try {
    execFileSync(process.execPath, [exportScript, '--out', tmp, '--since', '7x'], { stdio: 'pipe' });
    assert.fail('expected non-zero exit');
  } catch (err) {
    assert.notEqual(err.status, 0);
    assert.match(err.stderr.toString(), /invalid --since/);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
});

test('multi-column standard session renders all columns in position order', () => {
  const md = renderMarkdown({
    ...baseExport,
    standalone: [{
      id: 'sm',
      template_name: 'Squat',
      template_kind: 'standard',
      template_description: null,
      template_archived: false,
      started_at: T_2026_05_08_1842 - 60_000,
      finalized_at: T_2026_05_08_1842,
      notes: null,
      columns: [
        { id: 11, name: 'weight', unit: 'lb', position: 0, value_type: 'number' },
        { id: 12, name: 'reps', unit: null, position: 1, value_type: 'number' },
      ],
      values: [
        { row_index: 0, column_id: 11, value_num: 135, value_text: null },
        { row_index: 0, column_id: 12, value_num: 8, value_text: null },
        { row_index: 1, column_id: 11, value_num: 145, value_text: null },
        { row_index: 1, column_id: 12, value_num: 8, value_text: null },
      ],
    }],
  });
  assert.match(md, /\| Set \| weight \(lb\) \| reps \|/);
  assert.match(md, /\| 1 \| 135 \| 8 \|/);
  assert.match(md, /\| 2 \| 145 \| 8 \|/);
});
