import { api } from './api.js';
import { uuidv7 } from './uuidv7.js';
import { getDraft, getLastActiveSessionId } from './idb.js';
import { installHideFlush, installOutboxDrainers, drainOutbox, readShadow } from './persistence.js';
import { createSessionState } from './session-state.js';
import {
  renderSessionForm, renderStatus,
  renderHistoryList, renderSessionDetail,
} from './renderer.js';

const els = {
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  loginPw: document.getElementById('login-pw'),
  loginErr: document.getElementById('login-err'),
  app: document.getElementById('app'),
  home: document.getElementById('home'),
  templateList: document.getElementById('template-list'),
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
  logout: document.getElementById('logout'),
  resumeBanner: document.getElementById('resume-banner'),
};

const VIEWS = ['home', 'session', 'history', 'detail'];

let currentSession = null;
let templates = [];

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

function renderTemplateList() {
  els.templateList.innerHTML = '';
  for (const t of templates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'template-btn';
    btn.textContent = t.name;
    btn.addEventListener('click', () => startSession(t));
    els.templateList.appendChild(btn);
  }
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

async function enterApp() {
  hide(els.login);
  show(els.app);
  show(els.logout);

  templates = await api.templates();
  renderTemplateList();
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

  try {
    await api.templates();
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
