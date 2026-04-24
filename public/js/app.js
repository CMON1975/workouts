import { api } from './api.js';
import { uuidv7 } from './uuidv7.js';
import {
  getDraft, getLastActiveSessionId,
  putWorkout, getWorkout, deleteWorkout,
  getActiveWorkoutId, clearActiveWorkoutId,
} from './idb.js';
import { installHideFlush, installOutboxDrainers, drainOutbox, readShadow } from './persistence.js';
import { createSessionState } from './session-state.js';
import {
  renderSessionForm, renderStatus,
  renderHistoryList, renderSessionDetail, renderWorkoutDetail,
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
  runner: document.getElementById('runner'),
  runnerBack: document.getElementById('runner-back'),
  runnerRoot: document.getElementById('runner-root'),
  runnerStatus: document.getElementById('runner-status'),
  runnerRoutineName: document.getElementById('runner-routine-name'),
  runnerStep: document.getElementById('runner-step'),
  runnerNext: document.getElementById('runner-next'),
  runnerEnd: document.getElementById('runner-end'),
  logout: document.getElementById('logout'),
  resumeBanner: document.getElementById('resume-banner'),
};

const VIEWS = ['home', 'session', 'history', 'detail', 'newTpl', 'manage', 'newRt', 'manageRt', 'runner'];

let currentSession = null;
let templates = [];
let routines = [];
let rtSelectedIds = [];
let activeWorkout = null;       // { routine, workoutId, workoutClientVersion, startedAt, currentIndex, sessionIds: {0: uuid, ...} }
let detailOrigin = 'history';   // 'history' | 'runner'

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

async function tryResumeWorkout() {
  const wid = await getActiveWorkoutId();
  if (!wid) return false;

  const local = await getWorkout(wid);
  if (!local) {
    await clearActiveWorkoutId();
    return false;
  }

  let server = null;
  try {
    server = await api.getWorkout(wid);
  } catch (err) {
    if (err.status === 404) {
      await deleteWorkout(wid);
      return false;
    }
    // 401 / network: fall through on local copy.
  }
  if (server?.finalized_at) {
    await deleteWorkout(wid);
    return false;
  }

  const routine = routines.find(r => r.id === local.routine_id);
  if (!routine || !routine.templates.length) {
    console.warn('cannot resume workout — routine missing or empty', local.routine_id);
    await deleteWorkout(wid);
    return false;
  }

  const lastIdx = routine.templates.length - 1;
  const idx = Math.max(0, Math.min(local.current_index ?? 0, lastIdx));

  activeWorkout = {
    routine,
    workoutId: wid,
    workoutClientVersion: local.client_version ?? 1,
    startedAt: local.started_at,
    currentIndex: idx,
    sessionIds: local.session_ids || {},
  };

  els.resumeBanner.hidden = false;
  els.resumeBanner.textContent = `Resumed ${routine.name} at exercise ${idx + 1}`;
  setTimeout(() => { els.resumeBanner.hidden = true; }, 4000);

  await bindCurrentExercise();
  return true;
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

function bindSessionTo({ draft, template, formRoot, statusEl }) {
  const session = createSessionState({
    draft,
    onChange: ({ state }) => renderStatus(statusEl, { state }),
  });
  currentSession = session;

  renderSessionForm(formRoot, {
    template,
    draft: session.getDraft(),
    onInput: session.onInput,
  });
  renderStatus(statusEl, { state: session.getState() });

  loadPreviousHints(template, draft.id, formRoot);
  return session;
}

function bindSession(draft, template) {
  bindSessionTo({
    draft, template,
    formRoot: els.sessionRoot, statusEl: els.status,
  });
  show(els.submit);
  els.submit.disabled = false;
  showView('session');
}

async function loadPreviousHints(template, draftId, formRoot) {
  try {
    const prev = await api.lastTemplateSession(template.id);
    if (!prev) return;
    if (currentSession?.getDraft()?.id !== draftId) return;
    applyPreviousHints(formRoot, { template, prev });
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
    hint.textContent = 'No exercises yet. Tap "New exercise" to add one.';
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

async function handleRoutinePick(routine) {
  if (!routine.templates.length) {
    alert('This routine has no exercises.');
    return;
  }
  if (activeWorkout) {
    alert('Finish or End early on the current workout first.');
    return;
  }
  const workoutId = uuidv7();
  const startedAt = Date.now();
  activeWorkout = {
    routine,
    workoutId,
    workoutClientVersion: 1,
    startedAt,
    currentIndex: 0,
    sessionIds: {},
  };
  try {
    await api.patchWorkout(workoutId, {
      id: workoutId,
      routine_id: routine.id,
      started_at: startedAt,
      updated_at: startedAt,
      client_version: 1,
    });
  } catch (err) {
    console.error('start workout failed', err);
    alert('Could not start workout — check connection and try again.');
    activeWorkout = null;
    return;
  }
  await persistActiveWorkout();
  await bindCurrentExercise();
}

async function persistActiveWorkout() {
  if (!activeWorkout) return;
  try {
    await putWorkout({
      id: activeWorkout.workoutId,
      routine_id: activeWorkout.routine.id,
      started_at: activeWorkout.startedAt,
      current_index: activeWorkout.currentIndex,
      client_version: activeWorkout.workoutClientVersion,
      session_ids: activeWorkout.sessionIds,
    });
  } catch (err) {
    console.warn('workout IDB put failed', err);
  }
}

async function bindCurrentExercise() {
  if (!activeWorkout) return;
  const { routine, currentIndex } = activeWorkout;
  const template = routine.templates[currentIndex];

  let sid = activeWorkout.sessionIds[currentIndex];
  let draft = null;
  if (sid) {
    // Resume path: this index already has a sid; try to recover its in-progress draft.
    const local = (await getDraft(sid)) || readShadow(sid);
    if (local && !local.finalized_at) {
      draft = local;
      // workout_id may be missing from older shadows; make sure the belongs-to link is present.
      draft.workout_id = activeWorkout.workoutId;
    }
  } else {
    sid = uuidv7();
    activeWorkout.sessionIds[currentIndex] = sid;
    await persistActiveWorkout();
  }

  if (!draft) {
    draft = {
      id: sid,
      template_id: template.id,
      started_at: Date.now(),
      updated_at: Date.now(),
      client_version: 0,
      finalized_at: null,
      notes: null,
      workout_id: activeWorkout.workoutId,
      values: [],
    };
  }
  bindSessionTo({
    draft, template,
    formRoot: els.runnerRoot, statusEl: els.runnerStatus,
  });
  updateRunnerHeader();
  showView('runner');

  // Reconcile in background if we restored a non-trivial local draft.
  if (draft.client_version > 0) reconcileWithServer(draft);
}

function updateRunnerHeader() {
  if (!activeWorkout) return;
  const { routine, currentIndex } = activeWorkout;
  const n = routine.templates.length;
  const template = routine.templates[currentIndex];
  els.runnerRoutineName.textContent = routine.name;
  els.runnerStep.textContent = `${currentIndex + 1} / ${n} · ${template.name}`;
  els.runnerBack.hidden = currentIndex === 0;
  els.runnerNext.textContent = currentIndex === n - 1 ? 'Finish' : 'Next';
}

async function handleRunnerNext() {
  if (!activeWorkout || !currentSession) return;
  els.runnerNext.disabled = true;

  const savedIndex = activeWorkout.currentIndex;
  const nextIndex = savedIndex + 1;
  const isLast = nextIndex >= activeWorkout.routine.templates.length;

  // Persist the advance *before* finalizing, so a crash/lock mid-finalize
  // doesn't leave IDB pointing at the just-finished exercise. If finalize
  // fails, roll currentIndex back.
  activeWorkout.currentIndex = isLast ? savedIndex : nextIndex;
  await persistActiveWorkout();

  try {
    await currentSession.finalize();
  } catch (err) {
    activeWorkout.currentIndex = savedIndex;
    await persistActiveWorkout();
    alert('Saving this exercise failed — try again.');
    els.runnerNext.disabled = false;
    return;
  }

  if (isLast) {
    await finalizeActiveWorkout();
    await resetRunner();
    els.runnerNext.disabled = false;
    goHome();
    return;
  }
  await bindCurrentExercise();
  els.runnerNext.disabled = false;
}

async function handleRunnerEnd() {
  if (!activeWorkout) return;
  if (!confirm('End this workout now? Past exercises are saved; remaining ones are skipped.')) return;
  if (currentSession) {
    const draft = currentSession.getDraft();
    const hasValues = draft.values.some(
      v => v.value_num != null || (v.value_text != null && v.value_text !== ''),
    );
    if (hasValues) {
      try { await currentSession.finalize(); } catch (err) {
        console.warn('finalizing current exercise failed on end-early', err);
      }
    }
  }
  await finalizeActiveWorkout();
  await resetRunner();
  goHome();
}

async function finalizeActiveWorkout() {
  if (!activeWorkout) return;
  try {
    activeWorkout.workoutClientVersion += 1;
    await api.finalizeWorkout(activeWorkout.workoutId, activeWorkout.workoutClientVersion);
  } catch (err) {
    console.warn('finalize workout failed', err);
  }
}

async function resetRunner() {
  if (activeWorkout) {
    try { await deleteWorkout(activeWorkout.workoutId); } catch (_) {}
    try { await clearActiveWorkoutId(); } catch (_) {}
  }
  activeWorkout = null;
  currentSession = null;
}

async function handleRunnerBack() {
  if (!activeWorkout || activeWorkout.currentIndex === 0) return;
  const prevIndex = activeWorkout.currentIndex - 1;
  const prevSid = activeWorkout.sessionIds[prevIndex];
  const template = activeWorkout.routine.templates[prevIndex];
  if (!prevSid) return;
  try {
    const session = await api.getSession(prevSid);
    detailOrigin = 'runner';
    renderSessionDetail(els.detailRoot, { session, template });
    showView('detail');
  } catch (err) {
    alert('Could not load previous exercise.');
  }
}

async function openHistory() {
  showView('history');
  els.historyList.innerHTML = '';
  hide(els.historyEmpty);
  try {
    const [sessions, workouts] = await Promise.all([
      api.listSessions({ finalized: true, include_workout_sessions: false, limit: 100 }),
      api.listWorkouts({ finalized: true, limit: 100 }),
    ]);
    const items = [
      ...sessions.map(s => ({ type: 'session', session: s, ts: s.finalized_at ?? s.started_at })),
      ...workouts.map(w => ({ type: 'workout', workout: w, ts: w.finalized_at ?? w.started_at })),
    ].sort((a, b) => b.ts - a.ts);

    if (!items.length) {
      show(els.historyEmpty);
      return;
    }
    renderHistoryList(els.historyList, {
      items,
      templatesById: templatesById(),
      onPickSession: (s) => openDetail(s),
      onPickWorkout: (w) => openWorkoutDetail(w),
    });
  } catch (err) {
    console.error(err);
    els.historyList.textContent = 'Failed to load history.';
  }
}

function openDetail(session) {
  const template = templates.find(t => t.id === session.template_id);
  detailOrigin = 'history';
  renderSessionDetail(els.detailRoot, { session, template });
  showView('detail');
}

async function openWorkoutDetail(summary) {
  try {
    const full = await api.getWorkout(summary.id);
    detailOrigin = 'history';
    renderWorkoutDetail(els.detailRoot, { workout: full, templatesById: templatesById() });
    showView('detail');
  } catch (err) {
    console.error(err);
    alert('Could not load workout.');
  }
}

function goHome() {
  currentSession = null;
  showView('home');
}

let rowColumns = [];

function openNewTemplate() {
  els.newTplForm.reset();
  els.ntErr.textContent = '';
  rowColumns = [{ name: '', value_type: 'number', unit: '' }];
  renderColBuilder();
  els.ntSubmit.disabled = false;
  showView('newTpl');
  setTimeout(() => els.ntName.focus(), 0);
}

function renderColBuilder() {
  els.ntColBuilder.innerHTML = '';
  rowColumns.forEach((col, i) => {
    const row = document.createElement('div');
    row.className = 'col-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'col-name';
    nameInput.maxLength = 50;
    nameInput.placeholder = 'Column name (e.g. reps, weight)';
    nameInput.autocomplete = 'off';
    nameInput.value = col.name;
    nameInput.addEventListener('input', () => { rowColumns[i].name = nameInput.value; });
    row.appendChild(nameInput);

    const typeSel = document.createElement('select');
    for (const t of ['number', 'text']) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      if (col.value_type === t) opt.selected = true;
      typeSel.appendChild(opt);
    }
    typeSel.addEventListener('change', () => { rowColumns[i].value_type = typeSel.value; });
    row.appendChild(typeSel);

    const unitInput = document.createElement('input');
    unitInput.type = 'text';
    unitInput.className = 'col-unit';
    unitInput.maxLength = 20;
    unitInput.placeholder = 'unit';
    unitInput.autocomplete = 'off';
    unitInput.value = col.unit || '';
    unitInput.addEventListener('input', () => { rowColumns[i].unit = unitInput.value; });
    row.appendChild(unitInput);

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
  if (!name) return { error: 'Exercise name is required.' };
  const cols = rowColumns
    .map(c => ({
      name: c.name.trim(),
      value_type: c.value_type,
      unit: (c.unit || '').trim() || null,
    }))
    .filter(c => c.name);
  if (!cols.length) return { error: 'At least one column is required.' };
  if (cols.length > 16) return { error: 'At most 16 columns.' };
  const lower = cols.map(c => c.name.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    return { error: 'Column names must be unique.' };
  }
  const count = Number(els.ntSetsCount.value);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return { error: 'Sets must be between 1 and 100.' };
  }
  return {
    body: {
      name,
      default_rows: count,
      rows_fixed: 1,
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
      els.ntErr.textContent = 'An exercise with that name already exists.';
    } else if (err.status === 400) {
      els.ntErr.textContent = err.body?.error || 'Invalid exercise.';
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
  const next = prompt('Rename exercise', tpl.name);
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
    if (err.status === 409) alert('An exercise with that name already exists.');
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

  const workoutResumed = await tryResumeWorkout();
  if (!workoutResumed) {
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
  }

  installHideFlush(() => currentSession?.getDraft());
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
  els.detailBack.addEventListener('click', () => {
    if (detailOrigin === 'runner' && activeWorkout) showView('runner');
    else openHistory();
  });
  els.runnerBack.addEventListener('click', handleRunnerBack);
  els.runnerNext.addEventListener('click', handleRunnerNext);
  els.runnerEnd.addEventListener('click', handleRunnerEnd);
  els.newTemplateBtn.addEventListener('click', openNewTemplate);
  els.newTplBack.addEventListener('click', goHome);
  els.newTplForm.addEventListener('submit', handleNewTemplateSubmit);
  els.ntAddCol.addEventListener('click', () => {
    if (rowColumns.length >= 16) return;
    rowColumns.push({ name: '', value_type: 'number', unit: '' });
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
