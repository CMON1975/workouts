export default async function sessionsRoutes(app) {
  app.get('/api/sessions', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          template_id: { type: 'integer' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          finalized: { type: 'boolean' },
          include_workout_sessions: { type: 'boolean', default: true },
        },
      },
    },
  }, async (req) => {
    const db = app.db;
    const { template_id, limit, finalized, include_workout_sessions } = req.query;

    const where = [];
    const params = [];
    if (template_id !== undefined) {
      where.push('template_id = ?');
      params.push(template_id);
    }
    if (finalized === true) {
      where.push('finalized_at IS NOT NULL');
    } else if (finalized === false) {
      where.push('finalized_at IS NULL');
    }
    if (include_workout_sessions === false) {
      where.push('workout_id IS NULL');
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const sessions = db.prepare(`
      SELECT id, template_id, started_at, updated_at, finalized_at, client_version, notes, duration_seconds
        FROM sessions
        ${whereSql}
        ORDER BY COALESCE(finalized_at, started_at) DESC, started_at DESC
        LIMIT ?
    `).all(...params, limit);

    const valsStmt = db.prepare(`
      SELECT row_index, column_id, value_num, value_text
        FROM session_values
       WHERE session_id = ?
       ORDER BY row_index, column_id
    `);
    for (const s of sessions) s.values = valsStmt.all(s.id);
    return sessions;
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const db = app.db;
    const { id } = req.params;
    const session = db.prepare(`
      SELECT id, template_id, started_at, updated_at, finalized_at, client_version, notes, duration_seconds
        FROM sessions WHERE id = ?
    `).get(id);
    if (!session) return reply.code(404).send({ error: 'not found' });
    session.values = db.prepare(`
      SELECT row_index, column_id, value_num, value_text
        FROM session_values
       WHERE session_id = ?
       ORDER BY row_index, column_id
    `).all(id);
    return session;
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const db = app.db;
    const { id } = req.params;

    const result = db.transaction(() => {
      const row = db.prepare(
        'SELECT id, workout_id FROM sessions WHERE id = ?'
      ).get(id);
      if (!row) return { status: 404, body: { error: 'not found' } };

      if (row.workout_id) {
        const w = db.prepare(
          'SELECT finalized_at FROM workouts WHERE id = ?'
        ).get(row.workout_id);
        if (w && w.finalized_at == null) {
          return {
            status: 409,
            body: { error: 'cannot delete session from active workout', workout_id: row.workout_id },
          };
        }
      }

      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return { status: 204 };
    })();

    if (result.status === 204) return reply.code(204).send();
    return reply.code(result.status).send(result.body);
  });

  app.post('/api/sessions/:id/finalize', {
    schema: {
      body: {
        type: 'object',
        required: ['client_version'],
        properties: {
          client_version: { type: 'integer', minimum: 0 },
          duration_seconds: { type: ['integer', 'null'], minimum: 0 },
        },
      },
    },
  }, async (req, reply) => {
    const db = app.db;
    const { id } = req.params;
    const { client_version } = req.body;

    const result = db.transaction(() => {
      const row = db.prepare(
        'SELECT finalized_at, client_version FROM sessions WHERE id = ?'
      ).get(id);
      if (!row) return { status: 404 };
      if (row.finalized_at) {
        // Idempotent: already finalized.
        return { status: 200, body: { finalized_at: row.finalized_at } };
      }
      if (row.client_version > client_version) {
        return { status: 409, body: { error: 'stale', server_version: row.client_version } };
      }
      const now = Date.now();
      db.prepare(
        'UPDATE sessions SET finalized_at = ?, client_version = ?, updated_at = ?, duration_seconds = ? WHERE id = ?'
      ).run(now, client_version, now, req.body.duration_seconds ?? null, id);
      return { status: 200, body: { finalized_at: now } };
    })();

    return reply.code(result.status).send(result.body ?? { error: 'not found' });
  });
}
