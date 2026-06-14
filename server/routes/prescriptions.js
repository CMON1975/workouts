import { replaceRoutineTemplates } from './routines.js';

const VALUE_TYPES = ['number', 'text', 'duration'];
const KINDS = ['standard', 'checkbox'];
const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$';

const columnDefSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 50 },
    unit: { type: ['string', 'null'], maxLength: 20 },
    value_type: { type: 'string', enum: VALUE_TYPES, default: 'number' },
  },
};

const targetSchema = {
  type: 'object',
  required: ['row_index', 'column'],
  properties: {
    row_index: { type: 'integer', minimum: 0, maximum: 100 },
    column: { type: 'string', minLength: 1, maxLength: 50 },
    target_num: { type: ['number', 'null'] },
    target_text: { type: ['string', 'null'], maxLength: 200 },
    cue: { type: ['string', 'null'], maxLength: 500 },
  },
};

const exerciseSchema = {
  type: 'object',
  required: ['template_name', 'targets'],
  properties: {
    template_name: { type: 'string', minLength: 1, maxLength: 100 },
    kind: { type: 'string', enum: KINDS, default: 'standard' },
    description: { type: ['string', 'null'], maxLength: 1000 },
    columns: { type: 'array', maxItems: 16, items: columnDefSchema },
    default_rows: { type: 'integer', minimum: 1, maximum: 100 },
    rows_fixed: { type: 'integer', minimum: 0, maximum: 1 },
    targets: { type: 'array', minItems: 0, maxItems: 200, items: targetSchema },
  },
};

const daySchema = {
  type: 'object',
  required: ['routine_name', 'exercises'],
  properties: {
    routine_name: { type: 'string', minLength: 1, maxLength: 100 },
    sort_position: { type: 'integer', minimum: 0, maximum: 63 },
    notes: { type: ['string', 'null'], maxLength: 1000 },
    exercises: { type: 'array', minItems: 1, maxItems: 32, items: exerciseSchema },
  },
};

const importBodySchema = {
  type: 'object',
  required: ['week_starts_on', 'week_ends_on', 'days'],
  properties: {
    week_starts_on: { type: 'string', pattern: ISO_DATE },
    week_ends_on: { type: 'string', pattern: ISO_DATE },
    source: { type: ['string', 'null'], maxLength: 200 },
    create_if_missing: { type: 'boolean', default: true },
    max_new_routines: { type: 'integer', minimum: 0, maximum: 32, default: 2 },
    max_new_templates: { type: 'integer', minimum: 0, maximum: 32, default: 5 },
    // When true: any unfinalized workouts on touched routines are swept before
    // the active-workout gate fires. Empty drafts (no child sessions) are
    // deleted; drafts with data are finalized at `now`. Use for the Sunday
    // weekly import that resets the main page. Default false preserves the
    // mid-week safety behavior — refuse to touch a routine that has an
    // in-flight workout.
    finalize_pending: { type: 'boolean', default: false },
    days: { type: 'array', minItems: 1, maxItems: 14, items: daySchema },
  },
  additionalProperties: false,
};

function todayUtcISO() {
  return new Date().toISOString().slice(0, 10);
}

function loadPrescription(db, id) {
  const p = db.prepare(`
    SELECT p.id, p.routine_id, r.name AS routine_name,
           p.starts_on, p.ends_on, p.source, p.notes, p.created_at
      FROM prescriptions p
      JOIN routines r ON r.id = p.routine_id
     WHERE p.id = ?
  `).get(id);
  if (!p) return null;
  p.targets = db.prepare(`
    SELECT pt.template_id, t.name AS template_name, t.kind AS template_kind,
           pt.row_index, pt.column_id, tc.name AS column_name,
           pt.target_num, pt.target_text, pt.cue
      FROM prescription_targets pt
      JOIN templates t ON t.id = pt.template_id
      JOIN template_columns tc ON tc.id = pt.column_id
     WHERE pt.prescription_id = ?
     ORDER BY pt.template_id, pt.row_index, tc.position
  `).all(id);
  return p;
}

function findOrCreateRoutine(db, name, now, counters) {
  const existing = db.prepare('SELECT id FROM routines WHERE name = ?').get(name);
  if (existing) return { id: existing.id, created: false };
  counters.newRoutines += 1;
  if (counters.newRoutines > counters.maxNewRoutines) {
    const err = new Error('MAX_NEW_ROUTINES');
    err.detail = name;
    throw err;
  }
  const info = db.prepare(`
    INSERT INTO routines (name, created_at, sort_position)
    VALUES (?, ?, (SELECT COALESCE(MAX(sort_position) + 1, 0) FROM routines))
  `).run(name, now);
  return { id: info.lastInsertRowid, created: true };
}

function findOrCreateTemplate(db, exercise, now, opts, counters) {
  const { template_name, kind = 'standard' } = exercise;
  const existing = db.prepare('SELECT id, kind, description FROM templates WHERE name = ?').get(template_name);
  if (existing) {
    // Optionally refresh the description on an existing template. Only when
    // the import payload explicitly supplies one — undefined leaves it alone.
    if (exercise.description !== undefined) {
      const next = exercise.description == null
        ? null
        : (String(exercise.description).trim() || null);
      if (next !== existing.description) {
        db.prepare('UPDATE templates SET description = ? WHERE id = ?').run(next, existing.id);
      }
    }
    return { id: existing.id, kind: existing.kind, created: false };
  }
  if (!opts.createIfMissing) {
    const err = new Error('TEMPLATE_NOT_FOUND');
    err.detail = template_name;
    throw err;
  }
  counters.newTemplates += 1;
  if (counters.newTemplates > counters.maxNewTemplates) {
    const err = new Error('MAX_NEW_TEMPLATES');
    err.detail = template_name;
    throw err;
  }

  let columns, defaultRows, rowsFixed, description;
  if (kind === 'checkbox') {
    description = exercise.description ? String(exercise.description).trim() : null;
    if (!description) {
      const err = new Error('CHECKBOX_NEEDS_DESCRIPTION');
      err.detail = template_name;
      throw err;
    }
    columns = [{ name: 'completed', unit: null, value_type: 'number' }];
    defaultRows = 1;
    rowsFixed = 1;
  } else {
    if (!Array.isArray(exercise.columns) || exercise.columns.length === 0) {
      const err = new Error('STANDARD_NEEDS_COLUMNS');
      err.detail = template_name;
      throw err;
    }
    columns = exercise.columns;
    defaultRows = exercise.default_rows ?? 1;
    rowsFixed = exercise.rows_fixed ?? 0;
    description = exercise.description ? String(exercise.description).trim() : null;
  }

  const info = db.prepare(
    'INSERT INTO templates (name, kind, description, created_at) VALUES (?, ?, ?, ?)'
  ).run(template_name, kind, description, now);
  const id = info.lastInsertRowid;

  const colIns = db.prepare(`
    INSERT INTO template_columns (template_id, name, unit, position, value_type)
    VALUES (?, ?, ?, ?, ?)
  `);
  columns.forEach((c, i) => {
    colIns.run(
      id,
      c.name.trim(),
      c.unit ? String(c.unit).trim() : null,
      i,
      c.value_type || 'number',
    );
  });
  db.prepare(`
    INSERT INTO template_defaults (template_id, default_rows, rows_fixed)
    VALUES (?, ?, ?)
  `).run(id, defaultRows, rowsFixed);

  return { id, kind, created: true };
}

function loadTemplateColumnMap(db, templateId) {
  const rows = db.prepare(
    'SELECT id, name FROM template_columns WHERE template_id = ?'
  ).all(templateId);
  const map = new Map();
  for (const r of rows) map.set(r.name.toLowerCase(), r.id);
  return map;
}

// Pre-import sweep for finalize_pending. Empty drafts (no child sessions) get
// deleted outright; drafts with at least one child session are finalized at
// `now`, including their child sessions. Run inside the import txn so any
// failure rolls back together with the rest of the work.
function sweepUnfinalizedWorkouts(db, routineId, now) {
  const drafts = db.prepare(
    'SELECT id FROM workouts WHERE routine_id = ? AND finalized_at IS NULL'
  ).all(routineId);
  for (const w of drafts) {
    const childCount = db.prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE workout_id = ?'
    ).get(w.id).n;
    if (childCount === 0) {
      db.prepare('DELETE FROM workouts WHERE id = ?').run(w.id);
      continue;
    }
    db.prepare(
      'UPDATE sessions SET finalized_at = ?, updated_at = ? WHERE workout_id = ? AND finalized_at IS NULL'
    ).run(now, now, w.id);
    db.prepare(
      'UPDATE workouts SET finalized_at = ?, updated_at = ? WHERE id = ?'
    ).run(now, now, w.id);
  }
}

function insertTargets(db, prescriptionId, templateId, targets, colMap, templateName) {
  const ins = db.prepare(`
    INSERT INTO prescription_targets
      (prescription_id, template_id, row_index, column_id, target_num, target_text, cue)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of targets) {
    const colName = String(t.column).trim().toLowerCase();
    const columnId = colMap.get(colName);
    if (columnId == null) {
      const err = new Error('TEMPLATE_SHAPE_MISMATCH');
      err.detail = { template: templateName, column: t.column };
      throw err;
    }
    ins.run(
      prescriptionId,
      templateId,
      t.row_index,
      columnId,
      t.target_num ?? null,
      t.target_text ?? null,
      t.cue ?? null,
    );
  }
}

export default async function prescriptionsRoutes(app) {
  app.post('/api/prescriptions/import', {
    bodyLimit: 65536,
    schema: { body: importBodySchema },
  }, async (req, reply) => {
    const db = app.db;
    const body = req.body;
    const now = Date.now();
    const counters = {
      newRoutines: 0,
      newTemplates: 0,
      maxNewRoutines: body.max_new_routines ?? 2,
      maxNewTemplates: body.max_new_templates ?? 5,
    };
    const opts = { createIfMissing: body.create_if_missing !== false };

    let result;
    try {
      result = db.transaction(() => {
        const createdPrescriptions = [];

        for (const day of body.days) {
          const { id: routineId } = findOrCreateRoutine(db, day.routine_name, now, counters);

          if (body.finalize_pending) {
            sweepUnfinalizedWorkouts(db, routineId, now);
          }

          // Active-workout gate: any unfinalized workout on this routine blocks
          // the whole import (matches the pattern in routines.js PATCH).
          const active = db.prepare(
            'SELECT id FROM workouts WHERE routine_id = ? AND finalized_at IS NULL LIMIT 1'
          ).get(routineId);
          if (active) {
            const err = new Error('ACTIVE_WORKOUT');
            err.detail = { routine: day.routine_name, workout_id: active.id };
            throw err;
          }

          const templateIds = [];
          const perTemplateTargets = new Map();
          for (const ex of day.exercises) {
            const { id: templateId } = findOrCreateTemplate(db, ex, now, opts, counters);
            templateIds.push(templateId);
            if (!perTemplateTargets.has(templateId)) perTemplateTargets.set(templateId, []);
            perTemplateTargets.get(templateId).push({ targets: ex.targets, template_name: ex.template_name });
          }

          replaceRoutineTemplates(db, routineId, templateIds);

          if (day.sort_position !== undefined) {
            db.prepare('UPDATE routines SET sort_position = ? WHERE id = ?')
              .run(day.sort_position, routineId);
          }

          const presInfo = db.prepare(`
            INSERT INTO prescriptions (routine_id, starts_on, ends_on, source, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            routineId,
            body.week_starts_on,
            body.week_ends_on,
            body.source ?? null,
            day.notes ?? null,
            now,
          );
          const prescriptionId = presInfo.lastInsertRowid;

          for (const [templateId, entries] of perTemplateTargets) {
            const colMap = loadTemplateColumnMap(db, templateId);
            for (const { targets, template_name } of entries) {
              insertTargets(db, prescriptionId, templateId, targets, colMap, template_name);
            }
          }

          createdPrescriptions.push({
            id: prescriptionId,
            routine_id: routineId,
            routine_name: day.routine_name,
            starts_on: body.week_starts_on,
            ends_on: body.week_ends_on,
          });
        }

        return { prescriptions: createdPrescriptions };
      })();
    } catch (err) {
      if (err.message === 'ACTIVE_WORKOUT') {
        return reply.code(409).send({
          error: `active workout exists on routine "${err.detail.routine}"; finish or end it before importing`,
          workout_id: err.detail.workout_id,
        });
      }
      if (err.message === 'TEMPLATE_NOT_FOUND') {
        return reply.code(400).send({
          error: `template "${err.detail}" does not exist and create_if_missing is false`,
        });
      }
      if (err.message === 'TEMPLATE_SHAPE_MISMATCH') {
        return reply.code(409).send({
          error: `template_shape_mismatch: column "${err.detail.column}" not found on template "${err.detail.template}"`,
        });
      }
      if (err.message === 'MAX_NEW_ROUTINES') {
        return reply.code(400).send({
          error: `max_new_routines exceeded (would create "${err.detail}")`,
        });
      }
      if (err.message === 'MAX_NEW_TEMPLATES') {
        return reply.code(400).send({
          error: `max_new_templates exceeded (would create "${err.detail}")`,
        });
      }
      if (err.message === 'CHECKBOX_NEEDS_DESCRIPTION') {
        return reply.code(400).send({
          error: `checkbox template "${err.detail}" requires a non-empty description`,
        });
      }
      if (err.message === 'STANDARD_NEEDS_COLUMNS') {
        return reply.code(400).send({
          error: `standard template "${err.detail}" requires at least one column on creation`,
        });
      }
      req.log.error({ err }, 'prescription import failed');
      throw err;
    }

    return reply.code(201).send(result);
  });

  app.get('/api/prescriptions/active', {
    schema: {
      querystring: {
        type: 'object',
        required: ['routine_id'],
        properties: {
          routine_id: { type: 'integer' },
          on: { type: 'string', pattern: ISO_DATE },
        },
      },
    },
  }, async (req) => {
    const db = app.db;
    const onDate = req.query.on || todayUtcISO();
    const row = db.prepare(`
      SELECT id FROM prescriptions
       WHERE routine_id = ? AND starts_on <= ?
       ORDER BY starts_on DESC, id DESC
       LIMIT 1
    `).get(req.query.routine_id, onDate);
    if (!row) return null;
    return loadPrescription(db, row.id);
  });
}
