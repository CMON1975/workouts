// Which prescribed rows of a session are still blank. Used to confirm a
// Finish that would seal an exercise with a set never entered (HANDOFF
// 2026-09-04: Finish tapped instead of entering set 3, and a finalized
// session has no edit path). A row is "entered" when any of its values is
// a number or non-empty text; rows beyond the prescription are ignored.

export function blankPrescribedRows({ draft, template, prescribed }) {
  const targets = Array.isArray(prescribed?.targets) ? prescribed.targets : [];
  const rowCount = targets
    .filter(t => t.template_id === template?.id)
    .reduce((m, t) => Math.max(m, t.row_index + 1), 0);
  if (rowCount === 0) return [];
  const entered = new Set();
  for (const v of draft?.values ?? []) {
    if (v.value_num != null || (v.value_text != null && v.value_text !== '')) entered.add(v.row_index);
  }
  const blanks = [];
  for (let r = 0; r < rowCount; r += 1) if (!entered.has(r)) blanks.push(r);
  return blanks;
}
