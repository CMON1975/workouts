export function renderSessionForm(root, { template, draft, onInput }) {
  root.innerHTML = '';

  const h = document.createElement('h2');
  h.textContent = template.name;
  root.appendChild(h);

  const form = document.createElement('div');
  form.className = 'session-form';

  const rows = Math.max(template.default_rows, draft.values.reduce((m, v) => Math.max(m, v.row_index + 1), 0));

  for (let r = 0; r < rows; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'session-row';

    const label = document.createElement('label');
    label.textContent = template.rows_fixed ? `Set ${r + 1}` : `Row ${r + 1}`;
    rowEl.appendChild(label);

    for (const col of template.columns) {
      const existing = draft.values.find(v => v.row_index === r && v.column_id === col.id);

      const field = document.createElement('div');
      field.className = 'session-field';

      const input = document.createElement('input');
      input.type = col.value_type === 'text' ? 'text' : 'number';
      if (col.value_type === 'number') {
        input.inputMode = 'decimal';
        input.step = 'any';
      }
      input.placeholder = col.name + (col.unit ? ` (${col.unit})` : '');
      input.setAttribute('aria-label', col.name);
      input.dataset.rowIndex = String(r);
      input.dataset.columnId = String(col.id);

      if (existing) {
        if (col.value_type === 'text' && existing.value_text != null) input.value = existing.value_text;
        else if (existing.value_num != null) input.value = String(existing.value_num);
      }

      input.addEventListener('input', () => {
        onInput((d) => {
          const rowIndex = r;
          const columnId = col.id;
          const idx = d.values.findIndex(v => v.row_index === rowIndex && v.column_id === columnId);
          const val = input.value;
          const entry = {
            row_index: rowIndex,
            column_id: columnId,
            value_num: col.value_type === 'text' ? null : (val === '' ? null : Number(val)),
            value_text: col.value_type === 'text' ? (val || null) : null,
          };
          if (idx >= 0) d.values[idx] = entry;
          else d.values.push(entry);
        });
      });

      field.appendChild(input);
      rowEl.appendChild(field);
    }

    form.appendChild(rowEl);
  }

  root.appendChild(form);
}

export function renderStatus(el, { state }) {
  el.dataset.state = state;
  const labels = {
    draft: 'Ready',
    dirty: 'Editing…',
    saving: 'Saving…',
    saved: 'Saved',
    finalizing: 'Submitting…',
    finalized: 'Submitted',
  };
  el.textContent = labels[state] ?? state;
}
