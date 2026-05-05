-- Templates gain a "kind" discriminator. 'standard' is today's
-- rows × columns shape; 'checkbox' is a minimal one-tap exercise that
-- records only done/not-done. App enforces the value set; no CHECK
-- here so future kinds can be added without rebuilding the table.
ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';
