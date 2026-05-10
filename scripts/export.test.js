import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.match(md, /\*\*Totals:\*\* 0 workouts · 0 standalone sessions · 0 finalized sets/);
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
  assert.match(md, /\*\*Totals:\*\* 0 workouts · 1 standalone sessions · 4 finalized sets/);
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

test('workout with two child sessions renders heading + nested sub-sessions in started_at order', () => {
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

  assert.match(md, /## 2026-05-08 18:42 — Arms \(workout\)/);
  assert.match(md, /_Routine: Arms · 2 exercises_/);
  assert.match(md, /### Bicep Curls/);
  assert.match(md, /### Tricep Pushdowns/);
  // Child session table column header has unit when present, omits parens when null.
  assert.match(md, /\| Set \| reps \(pounds\) \|/);
  assert.match(md, /\| Set \| reps \|/);
  assert.match(md, /\*\*Totals:\*\* 1 workouts · 0 standalone sessions · 2 finalized sets/);

  // Order check: Bicep heading must come BEFORE Tricep heading.
  const bicepIdx = md.indexOf('### Bicep Curls');
  const tricepIdx = md.indexOf('### Tricep Pushdowns');
  assert.ok(bicepIdx > 0 && tricepIdx > bicepIdx, 'children render in started_at order');
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
  const oldIdx = md.indexOf('Arms (workout)');
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

test('CLI runs against a real DB and writes workouts.md with expected counts', async () => {
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

    const mdPath = join(outDir, 'workouts.md');
    assert.ok(existsSync(mdPath), 'workouts.md must exist after export');
    const md = readFileSync(mdPath, 'utf8');
    assert.match(md, /\*\*Totals:\*\* 1 workouts · 1 standalone sessions · 3 finalized sets/);
    assert.match(md, /## 2026-05-09 12:30 — Arms \(workout\)/);
    assert.match(md, /## 2026-05-08 18:42 — Bicep Curls \(standalone\)/);
    // Standalone (newer order check): Arms (workout, 05-09) before Bicep (standalone, 05-08).
    const armsIdx = md.indexOf('Arms (workout)');
    const bicepIdx = md.indexOf('Bicep Curls (standalone)');
    assert.ok(armsIdx > 0 && bicepIdx > armsIdx, 'newer first');
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
