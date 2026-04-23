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

function describeAge(ms) {
  const diffDays = Math.floor((Date.now() - ms) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

function shortDate(ms) {
  const d = new Date(ms);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

export function applyPreviousHints(root, { template, prev }) {
  if (!prev || !Array.isArray(prev.values)) return;

  if (prev.finalized_at && !root.querySelector('.prev-header')) {
    const header = document.createElement('p');
    header.className = 'prev-header';
    header.textContent = `Last session: ${shortDate(prev.finalized_at)} · ${describeAge(prev.finalized_at)}`;
    const h2 = root.querySelector('h2');
    if (h2 && h2.nextSibling) root.insertBefore(header, h2.nextSibling);
    else root.appendChild(header);
  }

  const colsById = new Map(template.columns.map(c => [c.id, c]));
  for (const v of prev.values) {
    const input = root.querySelector(
      `input[data-row-index="${v.row_index}"][data-column-id="${v.column_id}"]`,
    );
    if (!input) continue;
    const field = input.parentElement;
    if (!field || field.querySelector('.prev-hint')) continue;
    const col = colsById.get(v.column_id);
    const raw = col?.value_type === 'text' ? (v.value_text ?? '') : (v.value_num ?? '');
    if (raw === '' || raw === null || raw === undefined) continue;
    const hint = document.createElement('span');
    hint.className = 'prev-hint';
    hint.textContent = 'was ' + raw;
    field.appendChild(hint);
  }
}

export function renderRoutineBuilder({
  selectedRoot, availableRoot, emptySelectedEl, emptyAvailableEl,
  templatesById, selectedIds,
  onAdd, onRemove, onMoveUp, onMoveDown,
}) {
  selectedRoot.innerHTML = '';
  emptySelectedEl.hidden = selectedIds.length > 0;
  selectedIds.forEach((id, i) => {
    const t = templatesById.get(id);
    if (!t) return;
    const row = document.createElement('div');
    row.className = 'rt-row selected';

    const pos = document.createElement('span');
    pos.className = 'rt-pos';
    pos.textContent = String(i + 1) + '.';
    row.appendChild(pos);

    const name = document.createElement('span');
    name.className = 'rt-name';
    name.textContent = t.name + (t.archived_at ? ' (archived)' : '');
    row.appendChild(name);

    const ctrls = document.createElement('span');
    ctrls.className = 'rt-controls';
    const up = document.createElement('button');
    up.type = 'button'; up.className = 'secondary small'; up.textContent = '↑';
    up.disabled = i === 0;
    up.addEventListener('click', () => onMoveUp(i));
    const down = document.createElement('button');
    down.type = 'button'; down.className = 'secondary small'; down.textContent = '↓';
    down.disabled = i === selectedIds.length - 1;
    down.addEventListener('click', () => onMoveDown(i));
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'secondary small'; rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove');
    rm.addEventListener('click', () => onRemove(id));
    ctrls.append(up, down, rm);
    row.appendChild(ctrls);

    selectedRoot.appendChild(row);
  });

  availableRoot.innerHTML = '';
  const selectedSet = new Set(selectedIds);
  const candidates = [...templatesById.values()]
    .filter(t => !t.archived_at && !selectedSet.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  emptyAvailableEl.hidden = candidates.length > 0;
  for (const t of candidates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'template-btn';
    btn.textContent = t.name;
    btn.addEventListener('click', () => onAdd(t.id));
    availableRoot.appendChild(btn);
  }
}

export function renderRoutineManageList(root, { routines, onRename, onArchiveToggle }) {
  root.innerHTML = '';
  for (const r of routines) {
    const card = document.createElement('div');
    card.className = 'manage-row';
    if (r.archived_at) card.classList.add('is-archived');

    const name = document.createElement('div');
    name.className = 'manage-name';
    name.textContent = r.name + (r.archived_at ? ' (archived)' : '');
    card.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'manage-meta';
    const names = r.templates.map(t => t.name).join(', ');
    const count = r.templates.length;
    meta.textContent = `${count} exercise${count === 1 ? '' : 's'}: ${names || '(none)'}`;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'manage-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'secondary small';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => onRename(r));
    actions.appendChild(renameBtn);

    const archBtn = document.createElement('button');
    archBtn.type = 'button';
    archBtn.className = 'secondary small';
    archBtn.textContent = r.archived_at ? 'Restore' : 'Archive';
    archBtn.addEventListener('click', () => onArchiveToggle(r));
    actions.appendChild(archBtn);

    card.appendChild(actions);
    root.appendChild(card);
  }
}

export function renderRoutineList(root, { routines, onPick }) {
  root.innerHTML = '';
  for (const r of routines) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'template-btn routine-btn';
    const name = document.createElement('span');
    name.className = 'routine-name';
    name.textContent = r.name;
    const count = document.createElement('span');
    count.className = 'routine-count';
    const n = r.templates.length;
    count.textContent = `${n} exercise${n === 1 ? '' : 's'}`;
    btn.append(name, count);
    btn.addEventListener('click', () => onPick(r));
    root.appendChild(btn);
  }
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
