import { requireAuth } from '../auth.js';

export default async function templatesRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/templates', async (req) => {
    const db = app.db;
    const templates = db.prepare(`
      SELECT t.id, t.name, t.archived_at,
             d.default_rows, d.rows_fixed
        FROM templates t
        LEFT JOIN template_defaults d ON d.template_id = t.id
       WHERE t.archived_at IS NULL
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
}
