import { requireAuth } from '../auth.js';

const VALUE_TYPES = ['number', 'text', 'duration'];

const columnSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 50 },
    unit: { type: ['string', 'null'], maxLength: 20 },
    value_type: { type: 'string', enum: VALUE_TYPES, default: 'number' },
  },
};

const createBodySchema = {
  type: 'object',
  required: ['name', 'columns', 'default_rows', 'rows_fixed'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    default_rows: { type: 'integer', minimum: 1, maximum: 100 },
    rows_fixed: { type: 'integer', minimum: 0, maximum: 1 },
    columns: { type: 'array', minItems: 1, maxItems: 16, items: columnSchema },
  },
};

const patchBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    archived: { type: 'boolean' },
    default_rows: { type: 'integer', minimum: 1, maximum: 100 },
    rows_fixed: { type: 'integer', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
};

function loadTemplate(db, id) {
  const t = db.prepare(`
    SELECT t.id, t.name, t.created_at, t.archived_at,
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
  app.addHook('preHandler', requireAuth);

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
      SELECT t.id, t.name, t.created_at, t.archived_at,
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

  app.post('/api/templates', {
    schema: { body: createBodySchema },
  }, async (req, reply) => {
    const db = app.db;
    const body = req.body;
    const name = body.name.trim();
    if (!name) return reply.code(400).send({ error: 'name cannot be blank' });
    if (!uniqueColumnNames(body.columns)) {
      return reply.code(400).send({ error: 'column names must be unique and non-blank' });
    }

    const now = Date.now();
    let newId;
    try {
      newId = db.transaction(() => {
        const info = db.prepare(
          'INSERT INTO templates (name, created_at) VALUES (?, ?)'
        ).run(name, now);
        const id = info.lastInsertRowid;
        const colIns = db.prepare(`
          INSERT INTO template_columns (template_id, name, unit, position, value_type)
          VALUES (?, ?, ?, ?, ?)
        `);
        body.columns.forEach((c, i) => {
          colIns.run(
            id,
            c.name.trim(),
            c.unit ? c.unit.trim() : null,
            i,
            c.value_type || 'number',
          );
        });
        db.prepare(`
          INSERT INTO template_defaults (template_id, default_rows, rows_fixed)
          VALUES (?, ?, ?)
        `).run(id, body.default_rows, body.rows_fixed);
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
        return true;
      })();

      if (!changed) return reply.code(404).send({ error: 'not found' });
      return reply.code(200).send(loadTemplate(db, id));
    } catch (err) {
      if (err.message === 'BLANK_NAME') {
        return reply.code(400).send({ error: 'name cannot be blank' });
      }
      if (/UNIQUE constraint failed: templates\.name/i.test(err.message)) {
        return reply.code(409).send({ error: 'template name already exists' });
      }
      req.log.error({ err }, 'template update failed');
      throw err;
    }
  });
}
