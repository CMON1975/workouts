import { buildStats } from '../stats/build.js';

// Everything the stats page shows, derived per session. Finalized sessions
// count even while their workout is still open: those sets are done.
export default async function statsRoutes(app) {
  app.get('/api/stats', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          // Date#getTimezoneOffset in the browser: local days for the
          // body-weight lookup and the handle-correction cutoff.
          tz_offset: { type: 'integer', minimum: -840, maximum: 840, default: 0 },
        },
      },
    },
  }, async (req) => {
    const db = app.db;
    const sessions = db.prepare(`
      SELECT s.id, s.template_id, s.workout_id, s.started_at, s.finalized_at, s.duration_seconds,
             w.prescription_id, w.finalized_at AS workout_finalized_at
        FROM sessions s
        LEFT JOIN workouts w ON w.id = s.workout_id
       WHERE s.finalized_at IS NOT NULL
       ORDER BY s.started_at
    `).all();
    const values = db.prepare(`
      SELECT v.session_id, v.row_index, v.column_id, v.value_num, v.value_text
        FROM session_values v
        JOIN sessions s ON s.id = v.session_id
       WHERE s.finalized_at IS NOT NULL
    `).all();
    return buildStats({
      sessions,
      values,
      templates: db.prepare('SELECT id, name, kind, archived_at FROM templates').all(),
      columns: db.prepare('SELECT id, template_id, name, unit, value_type, retired_at FROM template_columns').all(),
      rests: db.prepare('SELECT prescription_id, template_id, rest_seconds, rows_per_rest FROM prescription_exercises').all(),
      bodyWeights: db.prepare("SELECT date, value FROM body_metrics WHERE metric = 'body_weight'").all(),
      tzOffset: req.query.tz_offset,
    });
  });
}
