const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const upsertBodySchema = {
  type: 'object',
  required: ['id', 'routine_id', 'started_at', 'updated_at', 'client_version'],
  properties: {
    id: { type: 'string', pattern: UUIDV7_RE.source },
    routine_id: { type: 'integer' },
    started_at: { type: 'integer' },
    updated_at: { type: 'integer' },
    client_version: { type: 'integer', minimum: 0 },
  },
};

function loadWorkout(db, id) {
  const w = db.prepare(`
    SELECT w.id, w.routine_id, r.name AS routine_name,
           w.started_at, w.updated_at, w.finalized_at, w.client_version, w.duration_seconds
      FROM workouts w
      JOIN routines r ON r.id = w.routine_id
     WHERE w.id = ?
  `).get(id);
  if (!w) return null;
  w.sessions = db.prepare(`
    SELECT s.id, s.template_id, s.started_at, s.updated_at,
           s.finalized_at, s.client_version, s.notes, s.duration_seconds
      FROM sessions s
     WHERE s.workout_id = ?
     ORDER BY s.started_at, s.id
  `).all(id);
  const valsStmt = db.prepare(`
    SELECT row_index, column_id, value_num, value_text
      FROM session_values
     WHERE session_id = ?
     ORDER BY row_index, column_id
  `);
  for (const s of w.sessions) s.values = valsStmt.all(s.id);
  return w;
}

export default async function workoutsRoutes(app) {
  app.get('/api/workouts', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          routine_id: { type: 'integer' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          finalized: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const db = app.db;
    const { routine_id, limit, finalized } = req.query;

    const where = [];
    const params = [];
    if (routine_id !== undefined) {
      where.push('w.routine_id = ?');
      params.push(routine_id);
    }
    if (finalized === true) where.push('w.finalized_at IS NOT NULL');
    else if (finalized === false) where.push('w.finalized_at IS NULL');
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT w.id, w.routine_id, r.name AS routine_name,
             w.started_at, w.updated_at, w.finalized_at, w.client_version, w.duration_seconds
        FROM workouts w
        JOIN routines r ON r.id = w.routine_id
        ${whereSql}
        ORDER BY COALESCE(w.finalized_at, w.started_at) DESC, w.started_at DESC
        LIMIT ?
    `).all(...params, limit);

    const childStmt = db.prepare(`
      SELECT s.id, s.template_id, s.started_at, s.updated_at,
             s.finalized_at, s.client_version, s.notes, s.duration_seconds
        FROM sessions s
       WHERE s.workout_id = ?
       ORDER BY s.started_at, s.id
    `);
    for (const w of rows) w.sessions = childStmt.all(w.id);
    return rows;
  });

  app.get('/api/workouts/:id', async (req, reply) => {
    const w = loadWorkout(app.db, req.params.id);
    if (!w) return reply.code(404).send({ error: 'not found' });
    return w;
  });

  app.patch('/api/workouts/:id', {
    bodyLimit: 4096,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: upsertBodySchema,
    },
  }, async (req, reply) => {
    const db = app.db;
    const { id } = req.params;
    const body = req.body;
    if (body.id !== id) return reply.code(400).send({ error: 'id mismatch' });

    const now = Date.now();
    const result = db.transaction(() => {
      const existing = db.prepare(
        'SELECT routine_id, client_version, finalized_at FROM workouts WHERE id = ?'
      ).get(id);

      if (existing?.finalized_at) {
        return { status: 200, body: { server_version: existing.client_version, finalized: true, updated_at: existing.finalized_at } };
      }
      if (existing && existing.client_version > body.client_version) {
        return { status: 409, body: { error: 'stale', server_version: existing.client_version } };
      }

      const routine = db.prepare(
        'SELECT id, archived_at FROM routines WHERE id = ?'
      ).get(body.routine_id);
      if (!routine) return { status: 400, body: { error: `routine ${body.routine_id} not found` } };
      if (!existing && routine.archived_at) {
        return { status: 400, body: { error: 'cannot start a workout against an archived routine' } };
      }
      if (existing && existing.routine_id !== body.routine_id) {
        return { status: 400, body: { error: 'routine_id mismatch on existing workout' } };
      }

      if (existing) {
        db.prepare(`
          UPDATE workouts
             SET started_at = ?, updated_at = ?, client_version = ?
           WHERE id = ?
        `).run(body.started_at, now, body.client_version, id);
      } else {
        // Stamp the active prescription (if any) onto this workout at creation
        // time. The pin is by id, not by date — re-importing the same week
        // later won't retroactively change what this workout was "run against".
        const onDate = new Date(body.started_at).toISOString().slice(0, 10);
        const presRow = db.prepare(`
          SELECT id FROM prescriptions
           WHERE routine_id = ? AND starts_on <= ?
           ORDER BY starts_on DESC, id DESC
           LIMIT 1
        `).get(body.routine_id, onDate);
        const presId = presRow ? presRow.id : null;
        db.prepare(`
          INSERT INTO workouts
            (id, routine_id, started_at, updated_at, client_version, prescription_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, body.routine_id, body.started_at, now, body.client_version, presId);
      }
      return { status: 200, body: { server_version: body.client_version, updated_at: now } };
    })();

    return reply.code(result.status).send(result.body);
  });

  app.delete('/api/workouts/:id', async (req, reply) => {
    const db = app.db;
    const { id } = req.params;

    const result = db.transaction(() => {
      const row = db.prepare(
        'SELECT id, finalized_at FROM workouts WHERE id = ?'
      ).get(id);
      if (!row) return { status: 404, body: { error: 'not found' } };
      if (row.finalized_at == null) {
        return { status: 409, body: { error: 'cannot delete active workout' } };
      }

      // FK is ON DELETE SET NULL on sessions.workout_id, which would orphan
      // children. Explicitly delete children first so their session_values
      // cascade away too.
      db.prepare('DELETE FROM sessions WHERE workout_id = ?').run(id);
      db.prepare('DELETE FROM workouts WHERE id = ?').run(id);
      return { status: 204 };
    })();

    if (result.status === 204) return reply.code(204).send();
    return reply.code(result.status).send(result.body);
  });

  app.post('/api/workouts/:id/finalize', {
    schema: {
      body: {
        type: 'object',
        required: ['client_version'],
        properties: { client_version: { type: 'integer', minimum: 0 } },
      },
    },
  }, async (req, reply) => {
    const db = app.db;
    const { id } = req.params;
    const { client_version } = req.body;

    const result = db.transaction(() => {
      const row = db.prepare(
        'SELECT finalized_at, client_version FROM workouts WHERE id = ?'
      ).get(id);
      if (!row) return { status: 404, body: { error: 'not found' } };
      if (row.finalized_at) return { status: 200, body: { finalized_at: row.finalized_at } };
      if (row.client_version > client_version) {
        return { status: 409, body: { error: 'stale', server_version: row.client_version } };
      }
      const now = Date.now();
      // Total = sum of recorded per-exercise durations, frozen at finalize.
      // SUM over all-NULL children yields NULL (never-started stopwatch).
      db.prepare(`
        UPDATE workouts
           SET finalized_at = ?, client_version = ?, updated_at = ?,
               duration_seconds = (SELECT SUM(duration_seconds) FROM sessions WHERE workout_id = workouts.id)
         WHERE id = ?
      `).run(now, client_version, now, id);
      return { status: 200, body: { finalized_at: now } };
    })();

    return reply.code(result.status).send(result.body);
  });
}
