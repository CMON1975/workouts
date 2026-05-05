-- Free-text description on templates. Nullable for back-compat with
-- existing standard templates; required-by-app only for kind='checkbox',
-- where it explains *what* the exercise is (the recorded data is just
-- done/not-done).
ALTER TABLE templates ADD COLUMN description TEXT;
