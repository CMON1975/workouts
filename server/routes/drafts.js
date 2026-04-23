import { requireAuth } from '../auth.js';

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const draftBodySchema = {
  type: 'object',
  required: ['id', 'template_id', 'started_at', 'updated_at', 'client_version', 'values'],
  properties: {
    id: { type: 'string', pattern: UUIDV7_RE.source },
    template_id: { type: 'integer' },
    started_at: { type: 'integer' },
    updated_at: { type: 'integer' },
    client_version: { type: 'integer', minimum: 0 },
    notes: { type: ['string', 'null'], maxLength: 2000 },
    values: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        required: ['row_index', 'column_id'],
        properties: {
          row_index: { type: 'integer', minimum: 0, maximum: 500 },
          column_id: { type: 'integer' },
          value_num: { type: ['number', 'null'] },
          value_text: { type: ['string', 'null'], maxLength: 1000 },
        },
      },
    },
  },
};

export default async function draftsRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.patch('/api/drafts/:id', {
    bodyLimit: 65536,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: draftBodySchema,
    },
  }, async (req, reply) => {
    const db = app.db;
    const { id } = req.params;
    const body = req.body;

    if (body.id !== id) {
      return reply.code(400).send({ error: 'id mismatch' });
    }

    const now = Date.now();

    const upsert = db.transaction(() => {
      const existing = db.prepare(
        'SELECT client_version, finalized_at FROM sessions WHERE id = ?'
      ).get(id);

      if (existing?.finalized_at) {
        // Finalized sessions are no longer drafts; ignore further draft PATCHes.
        return { server_version: existing.client_version, updated_at: existing.finalized_at, finalized: true };
      }

      if (existing && existing.client_version > body.client_version) {
        // Server has a newer version — tell client to reconcile.
        return { server_version: existing.client_version, updated_at: null, stale: true };
      }

      if (existing) {
        db.prepare(`
          UPDATE sessions
             SET template_id = ?, started_at = ?, updated_at = ?,
                 client_version = ?, notes = ?
           WHERE id = ?
        `).run(body.template_id, body.started_at, now, body.client_version, body.notes ?? null, id);
      } else {
        db.prepare(`
          INSERT INTO sessions
            (id, template_id, started_at, updated_at, client_version, notes)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, body.template_id, body.started_at, now, body.client_version, body.notes ?? null);
      }

      db.prepare('DELETE FROM session_values WHERE session_id = ?').run(id);
      const ins = db.prepare(`
        INSERT INTO session_values (session_id, row_index, column_id, value_num, value_text)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const v of body.values) {
        ins.run(id, v.row_index, v.column_id, v.value_num ?? null, v.value_text ?? null);
      }
      return { server_version: body.client_version, updated_at: now };
    });

    try {
      const result = upsert();
      if (result.stale) return reply.code(409).send(result);
      return reply.code(200).send(result);
    } catch (err) {
      req.log.error({ err }, 'draft upsert failed');
      // Foreign key / check constraint violation — 400, not 500.
      if (/FOREIGN KEY|CHECK/i.test(err.message)) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
