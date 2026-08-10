// Weight-column auto-fill (HANDOFF 2026-08-09): weight is the one column that
// almost never changes mid-session, so its inputs prefill instead of starting
// blank. Pure planning logic only — DOM wiring lives in renderer.js.

export function isWeightColumn(col) {
  return typeof col?.name === 'string' && col.name.trim().toLowerCase() === 'weight';
}

// Plan the display value for every weight cell the user does NOT own.
// Resolution per row: prescription target if one exists, else the nearest
// non-empty value above (typed or auto). userValues maps "row:columnId" of
// user-owned cells to their current value; those cells are never emitted but
// anchor the carry. Cells that resolve to nothing are emitted with value ''
// so a stale auto-filled input can be cleared when its source goes away.
export function planWeightAutofill({ template, prescribed, rows, userValues = new Map() }) {
  const plan = [];
  if (!template || template.kind === 'checkbox' || !Array.isArray(template.columns)) return plan;
  const weightCols = template.columns.filter(isWeightColumn);
  if (!weightCols.length || !rows) return plan;

  const targets = (Array.isArray(prescribed?.targets) ? prescribed.targets : [])
    .filter(t => t.template_id === template.id);

  for (const col of weightCols) {
    const targetByRow = new Map();
    for (const t of targets) {
      if (t.column_id !== col.id) continue;
      // Same number ↔ text fallback as the target hints: read whichever side
      // is populated, preferring the one matching the column type.
      const raw = col.value_type === 'text'
        ? (t.target_text ?? t.target_num)
        : (t.target_num ?? t.target_text);
      if (raw === null || raw === undefined || raw === '') continue;
      targetByRow.set(t.row_index, String(raw));
    }

    let carry = '';
    for (let r = 0; r < rows; r++) {
      if (userValues.has(`${r}:${col.id}`)) {
        const v = userValues.get(`${r}:${col.id}`);
        if (v !== '' && v != null) carry = String(v);
        continue;
      }
      const value = targetByRow.get(r) ?? carry;
      plan.push({ row_index: r, column_id: col.id, value });
      if (value !== '') carry = value;
    }
  }
  return plan;
}
