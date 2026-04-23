export function renderSessionForm(root, { template, draft, onInput }) {
  root.innerHTML = '';

  const h = document.createElement('h2');
  h.textContent = template.name;
  root.appendChild(h);

  const form = document.createElement('div');
  form.className = 'session-form';
  if (!template.rows_fixed) form.classList.add('no-row-labels');

  const valuesMax = draft.values.reduce((m, v) => Math.max(m, v.row_index + 1), 0);
  const rows = Math.max(template.default_rows, valuesMax);

  for (let r = 0; r < rows; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'session-row';

    if (template.rows_fixed) {
      const label = document.createElement('label');
      label.textContent = `Set ${r + 1}`;
      rowEl.appendChild(label);
    }

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

function formatDate(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch (_) {
    return new Date(ms).toISOString();
  }
}

function summarizeValues(session, template) {
  if (!template) return '';
  const firstCol = template.columns[0];
  if (!firstCol) return '';
  const cells = session.values
    .filter(v => v.column_id === firstCol.id)
    .sort((a, b) => a.row_index - b.row_index)
    .map(v => (firstCol.value_type === 'text' ? (v.value_text ?? '') : (v.value_num ?? '')));
  if (!cells.length) return '';
  const joined = cells.join(', ');
  return firstCol.unit ? `${joined} ${firstCol.unit}` : joined;
}

export function renderHistoryList(root, { sessions, templatesById, onPick }) {
  root.innerHTML = '';
  for (const s of sessions) {
    const template = templatesById.get(s.template_id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-row';
    btn.dataset.sessionId = s.id;

    const primary = document.createElement('div');
    primary.className = 'history-primary';
    primary.textContent = template?.name ?? `Template #${s.template_id}`;

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const ts = s.finalized_at ?? s.started_at;
    meta.textContent = formatDate(ts);

    const summary = document.createElement('div');
    summary.className = 'history-summary';
    summary.textContent = summarizeValues(s, template);

    btn.appendChild(primary);
    btn.appendChild(summary);
    btn.appendChild(meta);
    btn.addEventListener('click', () => onPick(s));
    root.appendChild(btn);
  }
}

export function renderSessionDetail(root, { session, template }) {
  root.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = template?.name ?? 'Session';
  root.appendChild(h);

  const ts = session.finalized_at ?? session.started_at;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = (session.finalized_at ? 'Submitted ' : 'Started ') + formatDate(ts);
  root.appendChild(meta);

  if (!template) {
    const warn = document.createElement('p');
    warn.textContent = 'Template definition not available.';
    root.appendChild(warn);
    return;
  }

  const maxRow = session.values.reduce((m, v) => Math.max(m, v.row_index), 0);
  const rows = maxRow + 1;
  const table = document.createElement('table');
  table.className = 'detail-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  for (const col of template.columns) {
    const th = document.createElement('th');
    th.textContent = col.name + (col.unit ? ` (${col.unit})` : '');
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let r = 0; r < rows; r++) {
    const tr = document.createElement('tr');
    const label = document.createElement('th');
    label.scope = 'row';
    label.textContent = template.rows_fixed ? `Set ${r + 1}` : `Row ${r + 1}`;
    tr.appendChild(label);
    for (const col of template.columns) {
      const td = document.createElement('td');
      const v = session.values.find(x => x.row_index === r && x.column_id === col.id);
      if (v) {
        td.textContent = col.value_type === 'text'
          ? (v.value_text ?? '')
          : (v.value_num != null ? String(v.value_num) : '');
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

export function renderManageList(root, { templates, onRename, onArchiveToggle }) {
  root.innerHTML = '';
  for (const t of templates) {
    const card = document.createElement('div');
    card.className = 'manage-row';
    if (t.archived_at) card.classList.add('is-archived');

    const name = document.createElement('div');
    name.className = 'manage-name';
    name.textContent = t.name + (t.archived_at ? ' (archived)' : '');
    card.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'manage-meta';
    const shape = t.rows_fixed
      ? `${t.default_rows} set${t.default_rows === 1 ? '' : 's'} · ${t.columns.map(c => c.name).join(', ')}`
      : `${t.columns.length} column${t.columns.length === 1 ? '' : 's'}: ${t.columns.map(c => c.name).join(', ')}`;
    meta.textContent = shape;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'manage-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'secondary small';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => onRename(t));
    actions.appendChild(renameBtn);

    const archBtn = document.createElement('button');
    archBtn.type = 'button';
    archBtn.className = 'secondary small';
    archBtn.textContent = t.archived_at ? 'Restore' : 'Archive';
    archBtn.addEventListener('click', () => onArchiveToggle(t));
    actions.appendChild(archBtn);

    card.appendChild(actions);
    root.appendChild(card);
  }
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
