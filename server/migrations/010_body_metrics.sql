-- Body metrics: daily weight / waist (and future BP) logged in-app.
-- Replaces the hand-edited bodymetrics.csv in the health repo.
-- value is TEXT so fractional measurements like "44 3/8" round-trip cleanly.
CREATE TABLE body_metrics (
  id         INTEGER PRIMARY KEY,
  date       TEXT    NOT NULL,    -- 'YYYY-MM-DD'
  metric     TEXT    NOT NULL,    -- 'body_weight' | 'waist' | (future: 'bp_systolic', etc)
  value      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_body_metrics_date ON body_metrics(date DESC);
