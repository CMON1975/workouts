const VALUE_TYPES = ['number', 'text', 'duration'];
const KINDS = ['standard', 'checkbox'];

const columnSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 50 },
    unit: { type: ['string', 'null'], maxLength: 20 },
    value_type: { type: 'string', enum: VALUE_TYPES, default: 'text' },
  },
};

// `kind: 'checkbox'` records only done/not-done; the server fills in the
// columns and defaults so the client only has to send a name (and a
// description, which the runner displays as static "what to do" text).
const createBodySchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    kind: { type: 'string', enum: KINDS, default: 'standard' },
    description: { type: ['string', 'null'], maxLength: 1000 },
    default_rows: { type: 'integer', minimum: 1, maximum: 100 },
    rows_fixed: { type: 'integer', minimum: 0, maximum: 1 },
    columns: { type: 'array', minItems: 1, maxItems: 16, items: columnSchema },
  },
};

const patchColumnSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string', minLength: 1, maxLength: 50 },
    unit: { type: ['string', 'null'], maxLength: 20 },
    value_type: { type: 'string', enum: VALUE_TYPES },
  },
};

const patchBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: ['string', 'null'], maxLength: 1000 },
    archived: { type: 'boolean' },
    default_rows: { type: 'integer', minimum: 1, maximum: 100 },
    rows_fixed: { type: 'integer', minimum: 0, maximum: 1 },
    columns: { type: 'array', minItems: 1, maxItems: 16, items: patchColumnSchema },
  },
  additionalProperties: false,
};

function loadTemplate(db, id) {
  const t = db.prepare(`
    SELECT t.id, t.name, t.kind, t.description, t.created_at, t.archived_at,
           d.default_rows, d.rows_fixed
      FROM templates t
      LEFT JOIN template_defaults d ON d.template_id = t.id
     WHERE t.id = ?
  `).get(id);
  if (!t) return null;
  t.columns = db.prepare(`
    SELECT id, name, unit, position, value_type
      FROM template_columns
     WHERE template_id = ?
     ORDER BY position
  `).all(id);
  t.default_rows = t.default_rows ?? 1;
  t.rows_fixed = t.rows_fixed ?? 0;
  return t;
}

function uniqueColumnNames(columns) {
  const seen = new Set();
  for (const c of columns) {
    const key = c.name.trim().toLowerCase();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export default async function templatesRoutes(app) {
  app.get('/api/templates', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          include_archived: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req) => {
    const db = app.db;
    const includeArchived = req.query?.include_archived === true;
    const where = includeArchived ? '' : 'WHERE t.archived_at IS NULL';
    const templates = db.prepare(`
      SELECT t.id, t.name, t.kind, t.description, t.created_at, t.archived_at,
             d.default_rows, d.rows_fixed
        FROM templates t
        LEFT JOIN template_defaults d ON d.template_id = t.id
        ${where}
       ORDER BY t.name
    `).all();
    const colsStmt = db.prepare(`
      SELECT id, name, unit, position, value_type
        FROM template_columns
       WHERE template_id = ?
       ORDER BY position
    `);
    for (const t of templates) {
      t.columns = colsStmt.all(t.id);
      t.default_rows = t.default_rows ?? 1;
      t.rows_fixed = t.rows_fixed ?? 0;
    }
    return templates;
  });

  app.get('/api/templates/:id/last-session', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  }, async (req, reply) => {
    const db = app.db;
    const id = Number(req.params.id);
    const tpl = db.prepare('SELECT id FROM templates WHERE id = ?').get(id);
    if (!tpl) return reply.code(404).send({ error: 'not found' });

    const session = db.prepare(`
      SELECT id, started_at, finalized_at, notes
        FROM sessions
       WHERE template_id = ? AND finalized_at IS NOT NULL
       ORDER BY finalized_at DESC
       LIMIT 1
    `).get(id);
    if (!session) return reply.code(200).send(null);

    session.values = db.prepare(`
      SELECT row_index, column_id, value_num, value_text
        FROM session_values
       WHERE session_id = ?
       ORDER BY row_index, column_id
    `).all(session.id);
    return reply.code(200).send(session);
  });

  app.post('/api/templates', {
    schema: { body: createBodySchema },
  }, async (req, reply) => {
    const db = app.db;
    const body = req.body;
    const name = body.name.trim();
    if (!name) return reply.code(400).send({ error: 'name cannot be blank' });

    const kind = body.kind || 'standard';
    const description = body.description != null ? String(body.description).trim() : null;
    let columns, defaultRows, rowsFixed;
    if (kind === 'checkbox') {
      // Checkbox templates record only done/not-done. The description is a
      // template-level prose label rendered above the tickbox at run time.
      if (!description) {
        return reply.code(400).send({ error: 'description is required for checkbox templates' });
      }
      columns = [{ name: 'completed', unit: null, value_type: 'text' }];
      defaultRows = 1;
      rowsFixed = 1;
    } else {
      if (!Array.isArray(body.columns) || body.columns.length < 1) {
        return reply.code(400).send({ error: 'columns required for standard templates' });
      }
      if (body.default_rows == null || body.rows_fixed == null) {
        return reply.code(400).send({ error: 'default_rows and rows_fixed required for standard templates' });
      }
      if (!uniqueColumnNames(body.columns)) {
        return reply.code(400).send({ error: 'column names must be unique and non-blank' });
      }
      columns = body.columns;
      defaultRows = body.default_rows;
      rowsFixed = body.rows_fixed;
    }

    const now = Date.now();
    let newId;
    try {
      newId = db.transaction(() => {
        const info = db.prepare(
          'INSERT INTO templates (name, kind, description, created_at) VALUES (?, ?, ?, ?)'
        ).run(name, kind, description, now);
        const id = info.lastInsertRowid;
        const colIns = db.prepare(`
          INSERT INTO template_columns (template_id, name, unit, position, value_type)
          VALUES (?, ?, ?, ?, ?)
        `);
        columns.forEach((c, i) => {
          colIns.run(
            id,
            c.name.trim(),
            c.unit ? c.unit.trim() : null,
            i,
            c.value_type || 'text',
          );
        });
        db.prepare(`
          INSERT INTO template_defaults (template_id, default_rows, rows_fixed)
          VALUES (?, ?, ?)
        `).run(id, defaultRows, rowsFixed);
        return id;
      })();
    } catch (err) {
      if (/UNIQUE constraint failed: templates\.name/i.test(err.message)) {
        return reply.code(409).send({ error: 'template name already exists' });
      }
      if (/UNIQUE constraint failed: .+template_columns/i.test(err.message)) {
        return reply.code(400).send({ error: 'duplicate column position or name' });
      }
      req.log.error({ err }, 'template insert failed');
      throw err;
    }
    return reply.code(201).send(loadTemplate(db, newId));
  });

  app.patch('/api/templates/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'integer' } } },
      body: patchBodySchema,
    },
  }, async (req, reply) => {
    const db = app.db;
    const id = Number(req.params.id);
    const body = req.body;
    if (!Object.keys(body).length) {
      return reply.code(400).send({ error: 'no fields to update' });
    }

    try {
      const changed = db.transaction(() => {
        const existing = db.prepare('SELECT id FROM templates WHERE id = ?').get(id);
        if (!existing) return false;

        if (body.name !== undefined) {
          const name = body.name.trim();
          if (!name) throw new Error('BLANK_NAME');
          db.prepare('UPDATE templates SET name = ? WHERE id = ?').run(name, id);
        }
        if (body.description !== undefined) {
          const desc = body.description == null ? null : String(body.description).trim() || null;
          db.prepare('UPDATE templates SET description = ? WHERE id = ?').run(desc, id);
        }
        if (body.archived !== undefined) {
          const val = body.archived ? Date.now() : null;
          db.prepare('UPDATE templates SET archived_at = ? WHERE id = ?').run(val, id);
        }
        if (body.default_rows !== undefined || body.rows_fixed !== undefined) {
          const d = db.prepare(
            'SELECT default_rows, rows_fixed FROM template_defaults WHERE template_id = ?'
          ).get(id) ?? { default_rows: 1, rows_fixed: 0 };
          const nextRows = body.default_rows ?? d.default_rows;
          const nextFixed = body.rows_fixed ?? d.rows_fixed;
          db.prepare(`
            INSERT INTO template_defaults (template_id, default_rows, rows_fixed)
            VALUES (?, ?, ?)
            ON CONFLICT(template_id) DO UPDATE
              SET default_rows = excluded.default_rows,
                  rows_fixed = excluded.rows_fixed
          `).run(id, nextRows, nextFixed);
        }
        if (body.columns !== undefined) {
          if (!uniqueColumnNames(body.columns)) throw new Error('DUP_COLUMN_NAMES');

          const active = db.prepare(`
            SELECT w.id FROM workouts w
            JOIN routine_templates rt ON rt.routine_id = w.routine_id
            WHERE rt.template_id = ? AND w.finalized_at IS NULL
            LIMIT 1
          `).get(id);
          if (active) throw new Error('ACTIVE_WORKOUT');

          const existingCols = db.prepare(
            'SELECT id FROM template_columns WHERE template_id = ?'
          ).all(id);
          const existingIds = new Set(existingCols.map(c => c.id));

          for (const c of body.columns) {
            if (c.id !== undefined && !existingIds.has(c.id)) throw new Error('FOREIGN_COLUMN_ID');
          }
          const sentIds = new Set();
          for (const c of body.columns) {
            if (c.id !== undefined) {
              if (sentIds.has(c.id)) throw new Error('DUP_COLUMN_ID');
              sentIds.add(c.id);
            }
          }

          // Shift kept columns to a non-colliding range first so the unique
          // (template_id, position) index doesn't fire mid-update.
          db.prepare(
            'UPDATE template_columns SET position = position + 10000 WHERE template_id = ?'
          ).run(id);

          const updateExisting = db.prepare(`
            UPDATE template_columns
               SET name = ?, unit = ?, position = ?
             WHERE id = ? AND template_id = ?
          `);
          const insertNew = db.prepare(`
            INSERT INTO template_columns (template_id, name, unit, position, value_type)
            VALUES (?, ?, ?, ?, ?)
          `);

          body.columns.forEach((c, i) => {
            const name = c.name.trim();
            if (!name) throw new Error('BLANK_COLUMN_NAME');
            const unit = c.unit == null ? null : String(c.unit).trim() || null;
            if (c.id !== undefined) {
              updateExisting.run(name, unit, i, c.id, id);
            } else {
              insertNew.run(id, name, unit, i, c.value_type || 'text');
            }
          });
        }
        return true;
      })();

      if (!changed) return reply.code(404).send({ error: 'not found' });
      return reply.code(200).send(loadTemplate(db, id));
    } catch (err) {
      if (err.message === 'BLANK_NAME') {
        return reply.code(400).send({ error: 'name cannot be blank' });
      }
      if (err.message === 'BLANK_COLUMN_NAME') {
        return reply.code(400).send({ error: 'column name cannot be blank' });
      }
      if (err.message === 'DUP_COLUMN_NAMES') {
        return reply.code(400).send({ error: 'column names must be unique' });
      }
      if (err.message === 'DUP_COLUMN_ID') {
        return reply.code(400).send({ error: 'duplicate column id in payload' });
      }
      if (err.message === 'FOREIGN_COLUMN_ID') {
        return reply.code(400).send({ error: 'column id does not belong to this template' });
      }
      if (err.message === 'ACTIVE_WORKOUT') {
        return reply.code(409).send({ error: 'finish or end the active workout before editing columns' });
      }
      if (/UNIQUE constraint failed: templates\.name/i.test(err.message)) {
        return reply.code(409).send({ error: 'template name already exists' });
      }
      req.log.error({ err }, 'template update failed');
      throw err;
    }
  });
}
