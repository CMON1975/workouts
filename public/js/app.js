import { api } from './api.js';
import { uuidv7 } from './uuidv7.js';
import { getDraft, getLastActiveSessionId } from './idb.js';
import { installHideFlush, installOutboxDrainers, drainOutbox, readShadow } from './persistence.js';
import { createSessionState } from './session-state.js';
import { renderSessionForm, renderStatus } from './renderer.js';

const els = {
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  loginPw: document.getElementById('login-pw'),
  loginErr: document.getElementById('login-err'),
  app: document.getElementById('app'),
  templateList: document.getElementById('template-list'),
  sessionRoot: document.getElementById('session-root'),
  status: document.getElementById('status'),
  submit: document.getElementById('submit'),
  logout: document.getElementById('logout'),
  resumeBanner: document.getElementById('resume-banner'),
};

let currentSession = null;
let currentTemplate = null;
let templates = [];

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

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
  currentTemplate = template;
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
}

async function reconcileWithServer(draft) {
  try {
    const server = await api.getSession(draft.id);
    if (server && server.client_version > draft.client_version) {
      // Server is ahead — replace local draft.
      Object.assign(draft, server);
    }
  } catch (err) {
    if (err.status !== 404) {
      console.warn('reconcile failed', err);
    }
  }
}

async function startSession(template) {
  const draft = emptyDraft(template);
  bindSession(draft, template);
}

async function resumeSession(draft) {
  const template = templates.find(t => t.id === draft.template_id);
  if (!template) {
    console.warn('template for draft not found', draft.template_id);
    return;
  }
  bindSession(draft, template);
  reconcileWithServer(draft);  // background
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

async function enterApp() {
  hide(els.login);
  show(els.app);

  templates = await api.templates();
  renderTemplateList();

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

  // Probe auth: hit /api/templates; 401 → show login.
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
