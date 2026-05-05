#!/usr/bin/env node
// Wipes the local dev DB and reseeds it with enough variety to exercise
// every code path in the app: standard sets-style + rows-style templates,
// archived templates, checkbox templates with descriptions, ad-hoc
// finalized sessions (so ghosts have data), routines (active + archived),
// and one finalized workout in history.
//
// Refuses to run if NODE_ENV=production or DB_PATH escapes ./data.

import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDb } from '../server/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to seed: NODE_ENV=production');
  process.exit(1);
}

const dbPath = resolve(projectRoot, process.env.DB_PATH || './data/workouts.db');
if (!dbPath.startsWith(resolve(projectRoot, 'data'))) {
  console.error(`refusing to seed DB outside ./data (was: ${dbPath})`);
  process.exit(1);
}

for (const ext of ['', '-wal', '-shm']) {
  const p = dbPath + ext;
  if (existsSync(p)) rmSync(p);
}
console.log(`→ wiped ${dbPath}`);

const db = openDb(dbPath);
console.log('→ migrations applied');

// UUIDv7: 48-bit unix-ms ts | ver(4)=0x7 | rand(12) | var(2)=0b10 | rand(62).
function uuidv7(atMs = Date.now()) {
  const r = randomBytes(10);
  const ts = BigInt(atMs) & ((1n << 48n) - 1n);
  let n = 0n;
  for (let i = 0; i < 10; i++) n = (n << 8n) | BigInt(r[i]);
  const rand74 = n & ((1n << 74n) - 1n);
  const randA = (rand74 >> 62n) & 0xfffn;
  const randB = rand74 & ((1n << 62n) - 1n);
  const hi = (ts << 16n) | (0x7n << 12n) | randA;
  const lo = (0x2n << 62n) | randB;
  const hex = hi.toString(16).padStart(16, '0') + lo.toString(16).padStart(16, '0');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

const DAY = 86400000;
const now = Date.now();

function createTemplate({ name, kind = 'standard', description = null, defaultRows = 1, rowsFixed = 0, columns, archived = false }) {
  const created = now - 30 * DAY;
  const archivedAt = archived ? now - 5 * DAY : null;
  const info = db.prepare(
    'INSERT INTO templates (name, kind, description, created_at, archived_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, kind, description, created, archivedAt);
  const id = info.lastInsertRowid;
  const colIns = db.prepare(
    'INSERT INTO template_columns (template_id, name, unit, position, value_type) VALUES (?, ?, ?, ?, ?)'
  );
  columns.forEach((c, i) => colIns.run(id, c.name, c.unit ?? null, i, c.value_type ?? 'number'));
  db.prepare(
    'INSERT INTO template_defaults (template_id, default_rows, rows_fixed) VALUES (?, ?, ?)'
  ).run(id, defaultRows, rowsFixed);
  return loadTemplate(id);
}

function loadTemplate(id) {
  const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  t.columns = db.prepare(
    'SELECT id, name, position, value_type FROM template_columns WHERE template_id = ? ORDER BY position'
  ).all(id);
  return t;
}

function finalizeSession({ templateId, daysAgo, values, workoutId = null, startedAtOffsetMs = 0 }) {
  const sid = uuidv7(now - daysAgo * DAY + startedAtOffsetMs);
  const startedAt = now - daysAgo * DAY + startedAtOffsetMs;
  const finalizedAt = startedAt + 60_000;
  db.prepare(`
    INSERT INTO sessions (id, template_id, started_at, updated_at, finalized_at, client_version, workout_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sid, templateId, startedAt, finalizedAt, finalizedAt, 1, workoutId);
  const valIns = db.prepare(
    'INSERT INTO session_values (session_id, row_index, column_id, value_num, value_text) VALUES (?, ?, ?, ?, ?)'
  );
  for (const v of values) valIns.run(sid, v.row_index, v.column_id, v.value_num ?? null, v.value_text ?? null);
  return sid;
}

function createRoutine({ name, templateIds, archived = false }) {
  const archivedAt = archived ? now - 7 * DAY : null;
  const info = db.prepare(
    'INSERT INTO routines (name, created_at, archived_at) VALUES (?, ?, ?)'
  ).run(name, now - 20 * DAY, archivedAt);
  const id = info.lastInsertRowid;
  const ins = db.prepare(
    'INSERT INTO routine_templates (routine_id, template_id, position) VALUES (?, ?, ?)'
  );
  templateIds.forEach((tid, i) => ins.run(id, tid, i));
  return id;
}

function finalizeWorkout({ routineId, daysAgo, sessions }) {
  const wid = uuidv7(now - daysAgo * DAY);
  const startedAt = now - daysAgo * DAY;
  const finalizedAt = startedAt + 30 * 60_000;
  db.prepare(`
    INSERT INTO workouts (id, routine_id, started_at, updated_at, finalized_at, client_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(wid, routineId, startedAt, finalizedAt, finalizedAt, 1);
  sessions.forEach((s, i) => finalizeSession({
    templateId: s.templateId,
    daysAgo,
    values: s.values,
    workoutId: wid,
    startedAtOffsetMs: i * 5 * 60_000,
  }));
  return wid;
}

// Migration 001 already inserted "Bicep Curls"; grab it.
const bicepCurls = loadTemplate(
  db.prepare("SELECT id FROM templates WHERE name='Bicep Curls'").get().id
);

// --- Templates ---------------------------------------------------------

const squats = createTemplate({
  name: 'Squats',
  defaultRows: 4,
  rowsFixed: 1,
  columns: [{ name: 'reps' }, { name: 'weight', unit: 'kg' }],
});

const walk = createTemplate({
  name: 'Walk on treadmill',
  defaultRows: 1,
  rowsFixed: 0,
  columns: [
    { name: 'Time',    unit: 'min', value_type: 'text' },
    { name: 'Incline', unit: '%' },
    { name: 'KPH' },
  ],
});

const oldFavourite = createTemplate({
  name: 'Old favourite (archived)',
  defaultRows: 3,
  rowsFixed: 1,
  columns: [{ name: 'reps' }],
  archived: true,
});

const stretchCheckbox = createTemplate({
  name: 'Morning stretch',
  kind: 'checkbox',
  description: '10 min full-body stretch — neck rolls, hamstrings, hip flexors, shoulders.',
  defaultRows: 1,
  rowsFixed: 1,
  columns: [{ name: 'completed' }],
});

const foamRoll = createTemplate({
  name: 'Foam roll',
  kind: 'checkbox',
  description: 'Quads, IT band, upper back. ~5 min total.',
  defaultRows: 1,
  rowsFixed: 1,
  columns: [{ name: 'completed' }],
});

console.log(`→ created ${5} extra templates (Bicep Curls already seeded)`);

// --- Ad-hoc finalized sessions (give templates ghost data) -------------

finalizeSession({
  templateId: bicepCurls.id, daysAgo: 4,
  values: [0, 1, 2, 3].map(i => ({
    row_index: i, column_id: bicepCurls.columns[0].id, value_num: 12 - i,
  })),
});

finalizeSession({
  templateId: squats.id, daysAgo: 3,
  values: [
    { row_index: 0, column_id: squats.columns[0].id, value_num: 8 },
    { row_index: 0, column_id: squats.columns[1].id, value_num: 60 },
    { row_index: 1, column_id: squats.columns[0].id, value_num: 8 },
    { row_index: 1, column_id: squats.columns[1].id, value_num: 70 },
    { row_index: 2, column_id: squats.columns[0].id, value_num: 6 },
    { row_index: 2, column_id: squats.columns[1].id, value_num: 80 },
    { row_index: 3, column_id: squats.columns[0].id, value_num: 5 },
    { row_index: 3, column_id: squats.columns[1].id, value_num: 80 },
  ],
});

finalizeSession({
  templateId: walk.id, daysAgo: 2,
  values: [
    { row_index: 0, column_id: walk.columns[0].id, value_text: '20:00' },
    { row_index: 0, column_id: walk.columns[1].id, value_num: 6 },
    { row_index: 0, column_id: walk.columns[2].id, value_num: 5.5 },
  ],
});

finalizeSession({
  templateId: stretchCheckbox.id, daysAgo: 2,
  values: [{ row_index: 0, column_id: stretchCheckbox.columns[0].id, value_num: 1 }],
});

finalizeSession({
  templateId: foamRoll.id, daysAgo: 6,
  values: [{ row_index: 0, column_id: foamRoll.columns[0].id, value_num: 0 }],
});

console.log('→ inserted 5 finalized standalone sessions (one per template)');

// --- Routines ----------------------------------------------------------

const armsDay = createRoutine({
  name: 'Arms day',
  templateIds: [bicepCurls.id, squats.id],
});

const mobility = createRoutine({
  name: 'Mobility',
  templateIds: [stretchCheckbox.id, foamRoll.id],
});

const fullBody = createRoutine({
  name: 'Full body',
  templateIds: [bicepCurls.id, squats.id, walk.id, stretchCheckbox.id],
});

const oldRoutine = createRoutine({
  name: 'Retired routine',
  templateIds: [bicepCurls.id],
  archived: true,
});

console.log(`→ created ${4} routines (1 archived)`);

// --- One finalized workout in history ---------------------------------

finalizeWorkout({
  routineId: armsDay,
  daysAgo: 1,
  sessions: [
    { templateId: bicepCurls.id, values: [0, 1, 2, 3].map(i => ({
        row_index: i, column_id: bicepCurls.columns[0].id, value_num: 11 - i,
      })) },
    { templateId: squats.id, values: [
        { row_index: 0, column_id: squats.columns[0].id, value_num: 10 },
        { row_index: 0, column_id: squats.columns[1].id, value_num: 60 },
        { row_index: 1, column_id: squats.columns[0].id, value_num: 8 },
        { row_index: 1, column_id: squats.columns[1].id, value_num: 70 },
        { row_index: 2, column_id: squats.columns[0].id, value_num: 6 },
        { row_index: 2, column_id: squats.columns[1].id, value_num: 80 },
        { row_index: 3, column_id: squats.columns[0].id, value_num: 5 },
        { row_index: 3, column_id: squats.columns[1].id, value_num: 80 },
    ] },
  ],
});

console.log('→ finalized 1 workout (Arms day, yesterday)');

console.log('\nseed complete. Run `npm run dev` (or `npm run dev:mobile`) to use it.');
db.close();
