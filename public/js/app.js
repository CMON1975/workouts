import { api } from './api.js';
import { uuidv7 } from './uuidv7.js';
import { getDraft, getLastActiveSessionId } from './idb.js';
import { installHideFlush, installOutboxDrainers, drainOutbox, readShadow } from './persistence.js';
import { createSessionState } from './session-state.js';
import {
  renderSessionForm, renderStatus,
  renderHistoryList, renderSessionDetail,
  renderManageList, applyPreviousHints,
  renderRoutineList, renderRoutineBuilder, renderRoutineManageList,
} from './renderer.js';

const els = {
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  loginPw: document.getElementById('login-pw'),
  loginErr: document.getElementById('login-err'),
  app: document.getElementById('app'),
  home: document.getElementById('home'),
  templateList: document.getElementById('template-list'),
  newTemplateBtn: document.getElementById('new-template'),
  manageBtn: document.getElementById('manage-templates'),
  openHistory: document.getElementById('open-history'),
  session: document.getElementById('session'),
  sessionBack: document.getElementById('session-back'),
  sessionRoot: document.getElementById('session-root'),
  status: document.getElementById('status'),
  submit: document.getElementById('submit'),
  history: document.getElementById('history'),
  historyBack: document.getElementById('history-back'),
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),
  detail: document.getElementById('detail'),
  detailBack: document.getElementById('detail-back'),
  detailRoot: document.getElementById('detail-root'),
  newTpl: document.getElementById('new-tpl'),
  newTplBack: document.getElementById('new-tpl-back'),
  newTplForm: document.getElementById('new-tpl-form'),
  ntName: document.getElementById('nt-name'),
  ntSetsPanel: document.getElementById('nt-sets'),
  ntRowsPanel: document.getElementById('nt-rows'),
  ntMetric: document.getElementById('nt-metric'),
  ntUnit: document.getElementById('nt-unit'),
  ntSetsCount: document.getElementById('nt-sets-count'),
  ntAddCol: document.getElementById('nt-add-col'),
  ntColBuilder: document.getElementById('nt-col-builder'),
  ntErr: document.getElementById('nt-err'),
  ntSubmit: document.getElementById('nt-submit'),
  manage: document.getElementById('manage'),
  manageBack: document.getElementById('manage-back'),
  manageList: document.getElementById('manage-list'),
  manageEmpty: document.getElementById('manage-empty'),
  routineList: document.getElementById('routine-list'),
  routineEmpty: document.getElementById('routine-empty'),
  newRoutineBtn: document.getElementById('new-routine'),
  manageRoutinesBtn: document.getElementById('manage-routines'),
  newRt: document.getElementById('new-rt'),
  newRtBack: document.getElementById('new-rt-back'),
  newRtForm: document.getElementById('new-rt-form'),
  nrName: document.getElementById('nr-name'),
  nrSelected: document.getElementById('nr-selected'),
  nrSelectedEmpty: document.getElementById('nr-selected-empty'),
  nrAvailable: document.getElementById('nr-available'),
  nrAvailableEmpty: document.getElementById('nr-available-empty'),
  nrErr: document.getElementById('nr-err'),
  nrSubmit: document.getElementById('nr-submit'),
  manageRt: document.getElementById('manage-rt'),
  manageRtBack: document.getElementById('manage-rt-back'),
  manageRtList: document.getElementById('manage-rt-list'),
  manageRtEmpty: document.getElementById('manage-rt-empty'),
  logout: document.getElementById('logout'),
  resumeBanner: document.getElementById('resume-banner'),
};

const VIEWS = ['home', 'session', 'history', 'detail', 'newTpl', 'manage', 'newRt', 'manageRt'];

let currentSession = null;
let templates = [];
let routines = [];
let rtSelectedIds = [];

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

function showView(name) {
  for (const v of VIEWS) {
    if (v === name) show(els[v]);
    else hide(els[v]);
  }
}

function templatesById() {
  return new Map(templates.map(t => [t.id, t]));
}

async function tryAutoRestore() {
  const lastId = await getLastActiveSessionId();
  if (!lastId) return false;
  const local = (await getDraft(lastId)) || readShadow(lastId);
  if (!local) return false;
  if (local.finalized_at) return false;
  return local;
}

function emptyDraft(template) {
  return {
    id: uuidv7(),
    template_id: template.id,
    started_at: Date.now(),
    updated_at: Date.now(),
    client_version: 0,
    finalized_at: null,
    notes: null,
    values: [],
  };
}

function bindSession(draft, template) {
  const session = createSessionState({
    draft,
    onChange: ({ state }) => renderStatus(els.status, { state }),
  });
  currentSession = session;

  renderSessionForm(els.sessionRoot, {
    template,
    draft: session.getDraft(),
    onInput: session.onInput,
  });
  renderStatus(els.status, { state: session.getState() });

  installHideFlush(() => currentSession?.getDraft());

  show(els.submit);
  els.submit.disabled = false;
  showView('session');

  loadPreviousHints(template, draft.id);
}

async function loadPreviousHints(template, draftId) {
  try {
    const prev = await api.lastTemplateSession(template.id);
    if (!prev) return;
    if (currentSession?.getDraft()?.id !== draftId) return;
    applyPreviousHints(els.sessionRoot, { template, prev });
  } catch (err) {
    console.warn('previous fetch failed', err);
  }
}

async function reconcileWithServer(draft) {
  try {
    const server = await api.getSession(draft.id);
    if (server && server.client_version > draft.client_version) {
      Object.assign(draft, server);
    }
  } catch (err) {
    if (err.status !== 404) console.warn('reconcile failed', err);
  }
}

function startSession(template) {
  bindSession(emptyDraft(template), template);
}

function resumeSession(draft) {
  const template = templates.find(t => t.id === draft.template_id);
  if (!template) {
    console.warn('template for draft not found', draft.template_id);
    return;
  }
  bindSession(draft, template);
  reconcileWithServer(draft);
}

function activeTemplates() {
  return templates.filter(t => !t.archived_at);
}

function renderTemplateList() {
  els.templateList.innerHTML = '';
  const active = activeTemplates();
  if (!active.length) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'No active templates. Tap "New template" to add one.';
    els.templateList.appendChild(hint);
    return;
  }
  for (const t of active) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'template-btn';
    btn.textContent = t.name;
    btn.addEventListener('click', () => startSession(t));
    els.templateList.appendChild(btn);
  }
}

function renderHomeRoutines() {
  const active = routines.filter(r => !r.archived_at);
  els.routineEmpty.hidden = active.length > 0;
  renderRoutineList(els.routineList, {
    routines: active,
    onPick: handleRoutinePick,
  });
}

function handleRoutinePick(_routine) {
  alert('Routine runner is coming in the next update.');
}

async function openHistory() {
  showView('history');
  els.historyList.innerHTML = '';
  hide(els.historyEmpty);
  try {
    const sessions = await api.listSessions({ finalized: true, limit: 100 });
    if (!sessions.length) {
      show(els.historyEmpty);
      return;
    }
    renderHistoryList(els.historyList, {
      sessions,
      templatesById: templatesById(),
      onPick: (s) => openDetail(s),
    });
  } catch (err) {
    console.error(err);
    els.historyList.textContent = 'Failed to load history.';
  }
}

function openDetail(session) {
  const template = templates.find(t => t.id === session.template_id);
  renderSessionDetail(els.detailRoot, { session, template });
  showView('detail');
}

function goHome() {
  currentSession = null;
  showView('home');
}

let rowColumns = [];

function openNewTemplate() {
  els.newTplForm.reset();
  els.ntErr.textContent = '';
  rowColumns = [{ name: '', value_type: 'text' }];
  renderColBuilder();
  setModePanels('sets');
  els.ntSubmit.disabled = false;
  showView('newTpl');
  setTimeout(() => els.ntName.focus(), 0);
}

function setModePanels(mode) {
  els.ntSetsPanel.hidden = mode !== 'sets';
  els.ntRowsPanel.hidden = mode !== 'rows';
}

function currentMode() {
  const checked = els.newTplForm.querySelector('input[name="nt-mode"]:checked');
  return checked ? checked.value : 'sets';
}

function renderColBuilder() {
  els.ntColBuilder.innerHTML = '';
  rowColumns.forEach((col, i) => {
    const row = document.createElement('div');
    row.className = 'col-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = 50;
    nameInput.placeholder = 'Column name';
    nameInput.autocomplete = 'off';
    nameInput.value = col.name;
    nameInput.addEventListener('input', () => { rowColumns[i].name = nameInput.value; });
    row.appendChild(nameInput);

    const typeSel = document.createElement('select');
    for (const t of ['text', 'number']) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (col.value_type === t) opt.selected = true;
      typeSel.appendChild(opt);
    }
    typeSel.addEventListener('change', () => { rowColumns[i].value_type = typeSel.value; });
    row.appendChild(typeSel);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'secondary small col-del';
    delBtn.textContent = '×';
    delBtn.setAttribute('aria-label', 'Remove column');
    delBtn.disabled = rowColumns.length <= 1;
    delBtn.addEventListener('click', () => {
      rowColumns.splice(i, 1);
      renderColBuilder();
    });
    row.appendChild(delBtn);

    els.ntColBuilder.appendChild(row);
  });
}

function buildTemplateBody() {
  const name = els.ntName.value.trim();
  if (!name) return { error: 'Template name is required.' };
  const mode = currentMode();
  if (mode === 'sets') {
    const metric = els.ntMetric.value.trim();
    if (!metric) return { error: 'Metric name is required.' };
    const unit = els.ntUnit.value.trim();
    const count = Number(els.ntSetsCount.value);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return { error: 'Sets must be between 1 and 100.' };
    }
    return {
      body: {
        name,
        default_rows: count,
        rows_fixed: 1,
        columns: [{
          name: metric,
          unit: unit || null,
          value_type: 'number',
        }],
      },
    };
  }
  const cols = rowColumns
    .map(c => ({ name: c.name.trim(), value_type: c.value_type }))
    .filter(c => c.name);
  if (!cols.length) return { error: 'At least one column is required.' };
  if (cols.length > 16) return { error: 'At most 16 columns.' };
  const lower = cols.map(c => c.name.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    return { error: 'Column names must be unique.' };
  }
  return {
    body: {
      name,
      default_rows: 1,
      rows_fixed: 0,
      columns: cols,
    },
  };
}

async function handleNewTemplateSubmit(e) {
  e.preventDefault();
  els.ntErr.textContent = '';
  const { error, body } = buildTemplateBody();
  if (error) { els.ntErr.textContent = error; return; }

  els.ntSubmit.disabled = true;
  try {
    const created = await api.createTemplate(body);
    templates.push(created);
    templates.sort((a, b) => a.name.localeCompare(b.name));
    renderTemplateList();
    showView('home');
  } catch (err) {
    if (err.status === 409) {
      els.ntErr.textContent = 'A template with that name already exists.';
    } else if (err.status === 400) {
      els.ntErr.textContent = err.body?.error || 'Invalid template.';
    } else {
      els.ntErr.textContent = 'Save failed — try again.';
    }
    els.ntSubmit.disabled = false;
  }
}

function openManage() {
  renderManage();
  showView('manage');
}

function renderManage() {
  els.manageEmpty.hidden = true;
  if (!templates.length) {
    els.manageList.innerHTML = '';
    els.manageEmpty.hidden = false;
    return;
  }
  const sorted = templates.slice().sort((a, b) => {
    if (!!a.archived_at !== !!b.archived_at) return a.archived_at ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  renderManageList(els.manageList, {
    templates: sorted,
    onRename: handleRename,
    onArchiveToggle: handleArchiveToggle,
  });
}

async function handleRename(tpl) {
  const next = prompt('Rename template', tpl.name);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === tpl.name) return;
  try {
    const updated = await api.updateTemplate(tpl.id, { name: trimmed });
    const idx = templates.findIndex(t => t.id === tpl.id);
    if (idx >= 0) templates[idx] = updated;
    renderManage();
    renderTemplateList();
  } catch (err) {
    if (err.status === 409) alert('A template with that name already exists.');
    else alert('Rename failed.');
  }
}

function openNewRoutine() {
  els.newRtForm.reset();
  els.nrErr.textContent = '';
  rtSelectedIds = [];
  renderBuilder();
  els.nrSubmit.disabled = false;
  showView('newRt');
  setTimeout(() => els.nrName.focus(), 0);
}

function renderBuilder() {
  renderRoutineBuilder({
    selectedRoot: els.nrSelected,
    availableRoot: els.nrAvailable,
    emptySelectedEl: els.nrSelectedEmpty,
    emptyAvailableEl: els.nrAvailableEmpty,
    templatesById: templatesById(),
    selectedIds: rtSelectedIds,
    onAdd: (id) => { rtSelectedIds.push(id); renderBuilder(); },
    onRemove: (id) => { rtSelectedIds = rtSelectedIds.filter(x => x !== id); renderBuilder(); },
    onMoveUp: (i) => {
      if (i <= 0) return;
      [rtSelectedIds[i - 1], rtSelectedIds[i]] = [rtSelectedIds[i], rtSelectedIds[i - 1]];
      renderBuilder();
    },
    onMoveDown: (i) => {
      if (i >= rtSelectedIds.length - 1) return;
      [rtSelectedIds[i], rtSelectedIds[i + 1]] = [rtSelectedIds[i + 1], rtSelectedIds[i]];
      renderBuilder();
    },
  });
}

async function handleNewRoutineSubmit(e) {
  e.preventDefault();
  els.nrErr.textContent = '';
  const name = els.nrName.value.trim();
  if (!name) { els.nrErr.textContent = 'Name is required.'; return; }
  if (!rtSelectedIds.length) { els.nrErr.textContent = 'Pick at least one exercise.'; return; }

  els.nrSubmit.disabled = true;
  try {
    const created = await api.createRoutine({ name, template_ids: rtSelectedIds });
    routines.push(created);
    routines.sort((a, b) => a.name.localeCompare(b.name));
    renderHomeRoutines();
    showView('home');
  } catch (err) {
    if (err.status === 409) els.nrErr.textContent = 'A routine with that name already exists.';
    else if (err.status === 400) els.nrErr.textContent = err.body?.error || 'Invalid routine.';
    else els.nrErr.textContent = 'Save failed — try again.';
    els.nrSubmit.disabled = false;
  }
}

function openManageRoutines() {
  renderManageRoutines();
  showView('manageRt');
}

function renderManageRoutines() {
  els.manageRtEmpty.hidden = true;
  if (!routines.length) {
    els.manageRtList.innerHTML = '';
    els.manageRtEmpty.hidden = false;
    return;
  }
  const sorted = routines.slice().sort((a, b) => {
    if (!!a.archived_at !== !!b.archived_at) return a.archived_at ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  renderRoutineManageList(els.manageRtList, {
    routines: sorted,
    onRename: handleRoutineRename,
    onArchiveToggle: handleRoutineArchiveToggle,
  });
}

async function handleRoutineRename(r) {
  const next = prompt('Rename routine', r.name);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === r.name) return;
  try {
    const updated = await api.updateRoutine(r.id, { name: trimmed });
    const idx = routines.findIndex(x => x.id === r.id);
    if (idx >= 0) routines[idx] = updated;
    renderManageRoutines();
    renderHomeRoutines();
  } catch (err) {
    if (err.status === 409) alert('A routine with that name already exists.');
    else alert('Rename failed.');
  }
}

async function handleRoutineArchiveToggle(r) {
  const archiving = !r.archived_at;
  if (archiving && !confirm(`Archive "${r.name}"? Past workouts are kept; it just won't appear in the list.`)) return;
  try {
    const updated = await api.updateRoutine(r.id, { archived: archiving });
    const idx = routines.findIndex(x => x.id === r.id);
    if (idx >= 0) routines[idx] = updated;
    renderManageRoutines();
    renderHomeRoutines();
  } catch (err) {
    alert(archiving ? 'Archive failed.' : 'Restore failed.');
  }
}

async function handleArchiveToggle(tpl) {
  const archiving = !tpl.archived_at;
  if (archiving && !confirm(`Archive "${tpl.name}"? Past sessions are kept; it just won't appear in the list.`)) return;
  try {
    const updated = await api.updateTemplate(tpl.id, { archived: archiving });
    const idx = templates.findIndex(t => t.id === tpl.id);
    if (idx >= 0) templates[idx] = updated;
    renderManage();
    renderTemplateList();
  } catch (err) {
    alert(archiving ? 'Archive failed.' : 'Restore failed.');
  }
}

async function enterApp() {
  hide(els.login);
  show(els.app);
  show(els.logout);

  templates = await api.templates({ includeArchived: true });
  renderTemplateList();
  try {
    routines = await api.routines({ includeArchived: true });
  } catch (err) {
    console.warn('routines fetch failed', err);
    routines = [];
  }
  renderHomeRoutines();
  showView('home');

  const restored = await tryAutoRestore();
  if (restored) {
    const template = templates.find(t => t.id === restored.template_id);
    if (template) {
      els.resumeBanner.hidden = false;
      els.resumeBanner.textContent = `Resumed draft for ${template.name}`;
      resumeSession(restored);
      setTimeout(() => { els.resumeBanner.hidden = true; }, 4000);
    }
  }

  installOutboxDrainers();
  drainOutbox();
}

async function handleLogin(e) {
  e.preventDefault();
  els.loginErr.textContent = '';
  try {
    await api.login(els.loginPw.value);
    els.loginPw.value = '';
    await enterApp();
  } catch (err) {
    els.loginErr.textContent = err.status === 401 ? 'Incorrect password' : 'Login failed';
  }
}

async function handleSubmit() {
  if (!currentSession) return;
  els.submit.disabled = true;
  try {
    await currentSession.finalize();
    els.sessionRoot.innerHTML = '<p class="done">Session submitted.</p>';
    hide(els.submit);
  } catch (err) {
    els.submit.disabled = false;
    alert('Submit failed — try again.');
  }
}

async function handleLogout() {
  try { await api.logout(); } catch (_) {}
  location.reload();
}

async function boot() {
  els.loginForm.addEventListener('submit', handleLogin);
  els.submit.addEventListener('click', handleSubmit);
  els.logout.addEventListener('click', handleLogout);
  els.openHistory.addEventListener('click', openHistory);
  els.sessionBack.addEventListener('click', goHome);
  els.historyBack.addEventListener('click', goHome);
  els.detailBack.addEventListener('click', openHistory);
  els.newTemplateBtn.addEventListener('click', openNewTemplate);
  els.newTplBack.addEventListener('click', goHome);
  els.newTplForm.addEventListener('submit', handleNewTemplateSubmit);
  els.newTplForm.querySelectorAll('input[name="nt-mode"]').forEach(r => {
    r.addEventListener('change', () => setModePanels(currentMode()));
  });
  els.ntAddCol.addEventListener('click', () => {
    if (rowColumns.length >= 16) return;
    rowColumns.push({ name: '', value_type: 'text' });
    renderColBuilder();
  });
  els.manageBtn.addEventListener('click', openManage);
  els.manageBack.addEventListener('click', goHome);
  els.newRoutineBtn.addEventListener('click', openNewRoutine);
  els.newRtBack.addEventListener('click', goHome);
  els.newRtForm.addEventListener('submit', handleNewRoutineSubmit);
  els.manageRoutinesBtn.addEventListener('click', openManageRoutines);
  els.manageRtBack.addEventListener('click', goHome);

  try {
    await api.templates({ includeArchived: true });
    await enterApp();
  } catch (err) {
    if (err.status === 401) {
      show(els.login);
    } else {
      show(els.login);
      els.loginErr.textContent = 'Server unreachable.';
    }
  }
}

boot();
