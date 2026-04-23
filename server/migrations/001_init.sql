-- Enforced by db.js on connect: PRAGMA foreign_keys=ON, journal_mode=WAL, synchronous=NORMAL.

CREATE TABLE templates (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  archived_at  INTEGER
);

CREATE TABLE template_columns (
  id           INTEGER PRIMARY KEY,
  template_id  INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  unit         TEXT,
  position     INTEGER NOT NULL,
  value_type   TEXT    NOT NULL DEFAULT 'number'
                       CHECK (value_type IN ('number','text','duration'))
);
CREATE UNIQUE INDEX ux_template_columns_tpl_pos  ON template_columns(template_id, position);
CREATE UNIQUE INDEX ux_template_columns_tpl_name ON template_columns(template_id, name);

CREATE TABLE template_defaults (
  template_id  INTEGER PRIMARY KEY REFERENCES templates(id) ON DELETE CASCADE,
  default_rows INTEGER NOT NULL DEFAULT 1,
  rows_fixed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id             TEXT    PRIMARY KEY,
  template_id    INTEGER NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  finalized_at   INTEGER,
  client_version INTEGER NOT NULL DEFAULT 0,
  notes          TEXT
);
CREATE INDEX ix_sessions_template ON sessions(template_id, started_at DESC);
CREATE INDEX ix_sessions_drafts   ON sessions(finalized_at) WHERE finalized_at IS NULL;

CREATE TABLE session_values (
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  row_index    INTEGER NOT NULL,
  column_id    INTEGER NOT NULL REFERENCES template_columns(id) ON DELETE RESTRICT,
  value_num    REAL,
  value_text   TEXT,
  PRIMARY KEY (session_id, row_index, column_id)
) WITHOUT ROWID;
CREATE INDEX ix_session_values_col ON session_values(column_id, value_num);

-- M1 seed: Bicep Curls template (4 fixed sets, one column "reps" in pounds).
INSERT INTO templates (name, created_at)
  VALUES ('Bicep Curls', CAST(strftime('%s','now') AS INTEGER) * 1000);
INSERT INTO template_columns (template_id, name, unit, position, value_type)
  VALUES ((SELECT id FROM templates WHERE name='Bicep Curls'), 'reps', 'pounds', 0, 'number');
INSERT INTO template_defaults (template_id, default_rows, rows_fixed)
  VALUES ((SELECT id FROM templates WHERE name='Bicep Curls'), 4, 1);
