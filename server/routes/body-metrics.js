// 'food' is free-text off-core eating ("300g lay's bacon potato chips"); the
// nutrition math is done downstream at review time, not stored here.
// resting_hr is bpm; blood_pressure is free-form "systolic/diastolic" text.
const METRICS = ['body_weight', 'waist', 'food', 'resting_hr', 'blood_pressure'];
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

const createBodySchema = {
  type: 'object',
  required: ['date', 'metric', 'value'],
  additionalProperties: false,
  properties: {
    date: { type: 'string', pattern: DATE_PATTERN },
    metric: { type: 'string', enum: METRICS },
    value: { type: 'string', minLength: 1, maxLength: 500 },
  },
};

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', pattern: DATE_PATTERN },
    to: { type: 'string', pattern: DATE_PATTERN },
    metric: { type: 'string', enum: METRICS },
  },
};

export default async function bodyMetricsRoutes(app) {
  app.get('/api/body-metrics', { schema: { querystring: listQuerySchema } }, async (req) => {
    const { from, to, metric } = req.query ?? {};
    const where = [];
    const params = [];
    if (from) { where.push('date >= ?'); params.push(from); }
    if (to)   { where.push('date <= ?'); params.push(to); }
    if (metric) { where.push('metric = ?'); params.push(metric); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return app.db.prepare(`
      SELECT id, date, metric, value, created_at
        FROM body_metrics
        ${clause}
       ORDER BY date DESC, id DESC
    `).all(...params);
  });

  app.post('/api/body-metrics', { schema: { body: createBodySchema } }, async (req, reply) => {
    const value = req.body.value.trim();
    if (!value) return reply.code(400).send({ error: 'value cannot be blank' });
    const now = Date.now();
    const info = app.db.prepare(`
      INSERT INTO body_metrics (date, metric, value, created_at)
      VALUES (?, ?, ?, ?)
    `).run(req.body.date, req.body.metric, value, now);
    const row = app.db.prepare(`
      SELECT id, date, metric, value, created_at
        FROM body_metrics WHERE id = ?
    `).get(info.lastInsertRowid);
    return reply.code(201).send(row);
  });
}
