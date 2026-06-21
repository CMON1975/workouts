-- 009: flip every template_column to value_type='text'
--
-- The schema originally distinguished number / text / duration columns, but in
-- practice the user wants flexibility ("24 x 2", "8 left 6 right", "60s") and
-- has already created most templates as text. Uniform text across the board:
-- input.type='text' on the form, value stored in value_text, no parse coercion.
-- Prescription targets continue to use either target_num or target_text; the
-- renderer falls back across both columns, so existing wk 7 / wk 8 targets
-- (stored as target_num) still render their blue hints.
--
-- Idempotent: re-running matches nothing on the second pass.

UPDATE template_columns SET value_type = 'text' WHERE value_type != 'text';
