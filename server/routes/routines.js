import { requireAuth } from '../auth.js';

const createBodySchema = {
  type: 'object',
  required: ['name', 'template_ids'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    template_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: { type: 'integer' },
    },
  },
};

const patchBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    archived: { type: 'boolean' },
    template_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: { type: 'integer' },
    },
  },
  additionalProperties: false,
};

function loadRoutine(db, id) {
  const r = db.prepare(`
    SELECT id, name, created_at, archived_at
      FROM routines WHERE id = ?
  `).get(id);
  if (!r) return null;
  r.templates = db.prepare(`
    SELECT t.id, t.name, t.created_at, t.archived_at,
           d.default_rows, d.rows_fixed,
           rt.position
      FROM routine_templates rt
      JOIN templates t ON t.id = rt.template_id
      LEFT JOIN template_defaults d ON d.template_id = t.id
     WHERE rt.routine_id = ?
     ORDER BY rt.position
  `).all(id);
  const colsStmt = db.prepare(`
    SELECT id, name, unit, position, value_type
      FROM template_columns
     WHERE template_id = ?
     ORDER BY position
  `);
  for (const t of r.templates) {
    t.columns = colsStmt.all(t.id);
    t.default_rows = t.default_rows ?? 1;
    t.rows_fixed = t.rows_fixed ?? 0;
  }
  return r;
}

function uniqueInts(arr) {
  return new Set(arr).size === arr.length;
}

function replaceRoutineTemplates(db, routineId, templateIds) {
  const existing = db.prepare('SELECT id FROM templates WHERE id = ?');
  for (const tid of templateIds) {
    if (!existing.get(tid)) {
      const err = new Error('TEMPLATE_NOT_FOUND');
      err.templateId = tid;
      throw err;
    }
  }
  db.prepare('DELETE FROM routine_templates WHERE routine_id = ?').run(routineId);
  const ins = db.prepare(`
    INSERT INTO routine_templates (routine_id, template_id, position)
    VALUES (?, ?, ?)
  `);
  templateIds.forEach((tid, i) => ins.run(routineId, tid, i));
}

export default async function routinesRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/routines', {
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
    const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
    const routines = db.prepare(`
      SELECT id FROM routines ${where} ORDER BY name
    `).all();
    return routines.map(r => loadRoutine(db, r.id));
  });

  app.get('/api/routines/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  }, async (req, reply) => {
    const r = loadRoutine(app.db, Number(req.params.id));
    if (!r) return reply.code(404).send({ error: 'not found' });
    return r;
  });

  app.post('/api/routines', {
    schema: { body: createBodySchema },
  }, async (req, reply) => {
    const db = app.db;
    const name = req.body.name.trim();
    if (!name) return reply.code(400).send({ error: 'name cannot be blank' });
    if (!uniqueInts(req.body.template_ids)) {
      return reply.code(400).send({ error: 'template_ids must be unique' });
    }

    let newId;
    try {
      newId = db.transaction(() => {
        const info = db.prepare(
          'INSERT INTO routines (name, created_at) VALUES (?, ?)'
        ).run(name, Date.now());
        const id = info.lastInsertRowid;
        replaceRoutineTemplates(db, id, req.body.template_ids);
        return id;
      })();
    } catch (err) {
      if (/UNIQUE constraint failed: routines\.name/i.test(err.message)) {
        return reply.code(409).send({ error: 'routine name already exists' });
      }
      if (err.message === 'TEMPLATE_NOT_FOUND') {
        return reply.code(400).send({ error: `template ${err.templateId} not found` });
      }
      req.log.error({ err }, 'routine insert failed');
      throw err;
    }
    return reply.code(201).send(loadRoutine(db, newId));
  });

  app.patch('/api/routines/:id', {
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
    if (body.template_ids && !uniqueInts(body.template_ids)) {
      return reply.code(400).send({ error: 'template_ids must be unique' });
    }

    try {
      const changed = db.transaction(() => {
        const existing = db.prepare('SELECT id FROM routines WHERE id = ?').get(id);
        if (!existing) return false;

        if (body.name !== undefined) {
          const nm = body.name.trim();
          if (!nm) throw new Error('BLANK_NAME');
          db.prepare('UPDATE routines SET name = ? WHERE id = ?').run(nm, id);
        }
        if (body.archived !== undefined) {
          const val = body.archived ? Date.now() : null;
          db.prepare('UPDATE routines SET archived_at = ? WHERE id = ?').run(val, id);
        }
        if (body.template_ids !== undefined) {
          replaceRoutineTemplates(db, id, body.template_ids);
        }
        return true;
      })();

      if (!changed) return reply.code(404).send({ error: 'not found' });
      return reply.code(200).send(loadRoutine(db, id));
    } catch (err) {
      if (err.message === 'BLANK_NAME') {
        return reply.code(400).send({ error: 'name cannot be blank' });
      }
      if (err.message === 'TEMPLATE_NOT_FOUND') {
        return reply.code(400).send({ error: `template ${err.templateId} not found` });
      }
      if (/UNIQUE constraint failed: routines\.name/i.test(err.message)) {
        return reply.code(409).send({ error: 'routine name already exists' });
      }
      req.log.error({ err }, 'routine update failed');
      throw err;
    }
  });
}
