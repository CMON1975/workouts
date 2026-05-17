import { attachSwipeReveal } from './swipe.js';

const TRASH_GLYPH = '🗑';

function makeTrashAction() {
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'row-action row-action-trash';
  action.setAttribute('aria-label', 'Delete');
  action.textContent = TRASH_GLYPH;
  return action;
}

export function renderSessionForm(root, { template, draft, onInput }) {
  root.innerHTML = '';

  const h = document.createElement('h2');
  h.textContent = template.name;
  root.appendChild(h);

  const form = document.createElement('div');
  form.className = 'session-form';

  if (template.kind === 'checkbox') {
    renderCheckboxField(form, { template, draft, onInput });
    root.appendChild(form);
    return;
  }

  const valuesMax = draft.values.reduce((m, v) => Math.max(m, v.row_index + 1), 0);
  const rows = Math.max(template.default_rows, valuesMax);
  if (rows <= 1) form.classList.add('no-row-labels');

  for (let r = 0; r < rows; r++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'session-row';

    if (rows > 1) {
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

  renderNotesField(form, { draft, onInput });
  root.appendChild(form);
}

function renderNotesField(form, { draft, onInput }) {
  const wrap = document.createElement('div');
  wrap.className = 'notes-field';

  const label = document.createElement('label');
  label.className = 'notes-label';
  const labelText = document.createElement('span');
  labelText.textContent = 'Notes';
  label.appendChild(labelText);

  const ta = document.createElement('textarea');
  ta.className = 'session-notes';
  ta.rows = 2;
  ta.maxLength = 2000;
  ta.placeholder = 'Optional note for next time';
  ta.setAttribute('aria-label', 'Session notes');
  ta.value = draft.notes ?? '';
  if (draft.finalized_at) ta.readOnly = true;
  ta.addEventListener('input', () => {
    onInput((d) => {
      const v = ta.value.trim();
      d.notes = v === '' ? null : ta.value;
    });
  });
  label.appendChild(ta);
  wrap.appendChild(label);
  form.appendChild(wrap);
}

function renderCheckboxField(form, { template, draft, onInput }) {
  const col = template.columns.find(c => c.name === 'completed');
  if (!col) return;

  if (template.description) {
    const desc = document.createElement('p');
    desc.className = 'checkbox-description';
    desc.textContent = template.description;
    form.appendChild(desc);
  }

  const existing = draft.values.find(v => v.row_index === 0 && v.column_id === col.id);

  const row = document.createElement('div');
  row.className = 'session-row checkbox-row';

  const label = document.createElement('label');
  label.className = 'checkbox-field';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.rowIndex = '0';
  input.dataset.columnId = String(col.id);
  input.checked = existing?.value_num === 1;

  const text = document.createElement('span');
  text.textContent = 'Completed';

  input.addEventListener('change', () => {
    onInput((d) => {
      const idx = d.values.findIndex(v => v.row_index === 0 && v.column_id === col.id);
      const entry = {
        row_index: 0,
        column_id: col.id,
        value_num: input.checked ? 1 : 0,
        value_text: null,
      };
      if (idx >= 0) d.values[idx] = entry;
      else d.values.push(entry);
    });
  });

  label.append(input, text);
  row.appendChild(label);
  form.appendChild(row);

  renderNotesField(form, { draft, onInput });
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
  if (template.kind === 'checkbox') {
    const col = template.columns.find(c => c.name === 'completed');
    const v = col && session.values.find(x => x.row_index === 0 && x.column_id === col.id);
    return v?.value_num === 1 ? 'Done' : 'Not done';
  }
  const cells = session.values
    .filter(v => v.column_id === firstCol.id)
    .sort((a, b) => a.row_index - b.row_index)
    .map(v => (firstCol.value_type === 'text' ? (v.value_text ?? '') : (v.value_num ?? '')));
  if (!cells.length) return '';
  const joined = cells.join(', ');
  return firstCol.unit ? `${joined} ${firstCol.unit}` : joined;
}

export function renderHistoryList(root, {
  items, templatesById,
  onPickSession, onPickWorkout,
  onDeleteSession, onDeleteWorkout,
}) {
  root.innerHTML = '';
  for (const item of items) {
    if (item.type === 'workout') {
      const w = item.workout;
      const wrap = document.createElement('div');
      wrap.className = 'row-wrap';
      wrap.dataset.workoutId = w.id;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-row row-foreground is-workout';

      const primary = document.createElement('div');
      primary.className = 'history-primary';
      primary.textContent = w.routine_name ?? 'Workout';

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const ts = w.finalized_at ?? w.started_at;
      meta.textContent = formatDate(ts);

      const summary = document.createElement('div');
      summary.className = 'history-summary';
      const n = w.sessions?.length ?? 0;
      const names = (w.sessions ?? [])
        .map(s => templatesById.get(s.template_id)?.name)
        .filter(Boolean)
        .join(', ');
      summary.textContent = `${n} exercise${n === 1 ? '' : 's'}${names ? ': ' + names : ''}`;

      btn.appendChild(primary);
      btn.appendChild(summary);
      btn.appendChild(meta);
      btn.addEventListener('click', () => onPickWorkout(w));

      const action = makeTrashAction();
      wrap.appendChild(btn);
      wrap.appendChild(action);
      root.appendChild(wrap);
      attachSwipeReveal(wrap, { onAction: () => onDeleteWorkout(w, wrap) });
      continue;
    }
    const s = item.session;
    const template = templatesById.get(s.template_id);
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';
    wrap.dataset.sessionId = s.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-row row-foreground';

    const primary = document.createElement('div');
    primary.className = 'history-primary';
    primary.textContent = template?.name ?? `Exercise #${s.template_id}`;

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
    btn.addEventListener('click', () => onPickSession(s));

    const action = makeTrashAction();
    wrap.appendChild(btn);
    wrap.appendChild(action);
    root.appendChild(wrap);
    attachSwipeReveal(wrap, { onAction: () => onDeleteSession(s, wrap) });
  }
}

function renderSessionTable(root, { session, template }) {
  if (!template) {
    const warn = document.createElement('p');
    warn.textContent = 'Exercise definition not available.';
    root.appendChild(warn);
    return;
  }

  if (typeof session.notes === 'string' && session.notes.trim() !== '') {
    const p = document.createElement('p');
    p.className = 'detail-notes';
    const label = document.createElement('strong');
    label.textContent = 'Notes: ';
    p.appendChild(label);
    p.appendChild(document.createTextNode(session.notes));
    root.appendChild(p);
  }

  if (template.kind === 'checkbox') {
    if (template.description) {
      const desc = document.createElement('p');
      desc.className = 'detail-description';
      desc.textContent = template.description;
      root.appendChild(desc);
    }
    const col = template.columns.find(c => c.name === 'completed');
    const v = col && session.values.find(x => x.row_index === 0 && x.column_id === col.id);
    const status = document.createElement('p');
    status.className = 'detail-checkbox';
    status.textContent = v?.value_num === 1 ? '✓ Done' : '✗ Not done';
    root.appendChild(status);
    return;
  }

  const maxRow = session.values.reduce((m, v) => Math.max(m, v.row_index), 0);
  const rows = Math.max(maxRow + 1, 1);
  const table = document.createElement('table');
  table.className = 'detail-table';

  const showRowLabels = rows > 1;
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  if (showRowLabels) headRow.appendChild(document.createElement('th'));
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
    if (showRowLabels) {
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = `Set ${r + 1}`;
      tr.appendChild(label);
    }
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

  renderSessionTable(root, { session, template });
}

export function renderWorkoutDetail(root, { workout, templatesById, onDeleteChildSession }) {
  root.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = workout.routine_name ?? 'Workout';
  root.appendChild(h);

  const ts = workout.finalized_at ?? workout.started_at;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = (workout.finalized_at ? 'Submitted ' : 'Started ') + formatDate(ts);
  root.appendChild(meta);

  const sessions = workout.sessions ?? [];
  if (!sessions.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No exercises recorded.';
    root.appendChild(p);
    return;
  }

  for (const session of sessions) {
    const template = templatesById.get(session.template_id);
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap workout-child-wrap';
    wrap.dataset.sessionId = session.id;

    const fg = document.createElement('div');
    fg.className = 'row-foreground workout-child';

    const sub = document.createElement('h3');
    sub.className = 'workout-exercise-name';
    sub.textContent = template?.name ?? `Exercise #${session.template_id}`;
    fg.appendChild(sub);
    renderSessionTable(fg, { session, template });

    const action = makeTrashAction();
    wrap.appendChild(fg);
    wrap.appendChild(action);
    root.appendChild(wrap);
    if (onDeleteChildSession) {
      attachSwipeReveal(wrap, {
        onAction: () => onDeleteChildSession(session, wrap),
      });
    }
  }
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
    if (template.kind === 'checkbox') {
      const row = input.closest('.checkbox-row') ?? field;
      if (row.querySelector('.prev-hint')) continue;
      const hint = document.createElement('span');
      hint.className = 'prev-hint';
      hint.textContent = v.value_num === 1 ? 'was done' : 'was not done';
      row.appendChild(hint);
      continue;
    }
    const raw = col?.value_type === 'text' ? (v.value_text ?? '') : (v.value_num ?? '');
    if (raw === '' || raw === null || raw === undefined) continue;
    const hint = document.createElement('span');
    hint.className = 'prev-hint';
    hint.textContent = 'was ' + raw;
    field.appendChild(hint);
  }

  const notesField = root.querySelector('.notes-field');
  if (notesField && !notesField.querySelector('.prev-note-hint')) {
    const noteHint = document.createElement('p');
    noteHint.className = 'prev-note-hint';
    const text = typeof prev.notes === 'string' && prev.notes.trim() !== ''
      ? `Last note: ${prev.notes}`
      : 'No previous note.';
    noteHint.textContent = text;
    notesField.appendChild(noteHint);
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
    ctrls.append(up, down);
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'secondary small'; rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove');
    rm.addEventListener('click', () => onRemove(id));
    ctrls.append(rm);
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

export function renderRoutineManageList(root, { routines, onEdit, onArchiveToggle }) {
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

    if (!r.archived_at) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'secondary small';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => onEdit(r));
      actions.appendChild(editBtn);
    }

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

export function renderManageList(root, { templates, onEdit, onArchiveToggle }) {
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
    let shape;
    if (t.kind === 'checkbox') {
      shape = 'Checkbox · done / not done';
    } else if (t.rows_fixed) {
      shape = `${t.default_rows} set${t.default_rows === 1 ? '' : 's'} · ${t.columns.map(c => c.name).join(', ')}`;
    } else {
      shape = `${t.columns.length} column${t.columns.length === 1 ? '' : 's'}: ${t.columns.map(c => c.name).join(', ')}`;
    }
    meta.textContent = shape;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'manage-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'secondary small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => onEdit(t));
    actions.appendChild(editBtn);

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
