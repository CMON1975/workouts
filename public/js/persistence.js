import { putDraft, enqueueOutbox, listOutbox, deleteOutbox, updateOutbox } from './idb.js';

const OUTBOX_MAX_ATTEMPTS = 20;
const OUTBOX_MAX_BACKOFF_MS = 60_000;

export function installHideFlush(getDraft) {
  const flush = () => {
    const d = getDraft();
    if (!d) return;
    const json = JSON.stringify(d);
    // Layer 1: synchronous same-tick shadow.
    try { localStorage.setItem('draft:' + d.id, json); } catch (_) {}
    // Layer 2: IDB put (queued; WebKit usually drains before freeze).
    try { putDraft(d); } catch (_) {}
    // Layer 3: fire-and-forget beacon.
    try {
      const blob = new Blob([json], { type: 'application/json' });
      navigator.sendBeacon('/api/drafts/' + d.id, blob);
    } catch (_) {}
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  // Intentionally no beforeunload — unreliable on iOS WebKit.

  return flush;
}

export function readShadow(id) {
  try {
    const raw = localStorage.getItem('draft:' + id);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export function clearShadow(id) {
  try { localStorage.removeItem('draft:' + id); } catch (_) {}
}

function backoffMs(attempts) {
  const base = Math.min(OUTBOX_MAX_BACKOFF_MS, 500 * Math.pow(2, attempts));
  const jitter = Math.random() * 250;
  return base + jitter;
}

export async function enqueueFailedPatch(draft) {
  await enqueueOutbox({
    url: '/api/drafts/' + draft.id,
    method: 'PATCH',
    body: JSON.stringify(draft),
    draftId: draft.id,
    clientVersion: draft.client_version,
    attempts: 0,
    nextAttemptAt: Date.now(),
  });
}

let draining = false;
export async function drainOutbox() {
  if (draining) return;
  draining = true;
  try {
    const entries = await listOutbox();
    // Supersede: for same draftId + same url+method, keep only the highest clientVersion.
    const byKey = new Map();
    for (const e of entries) {
      const k = e.url + '|' + e.method;
      const prev = byKey.get(k);
      if (!prev || (e.clientVersion ?? 0) >= (prev.clientVersion ?? 0)) {
        if (prev) await deleteOutbox(prev.id);
        byKey.set(k, e);
      } else {
        await deleteOutbox(e.id);
      }
    }
    const now = Date.now();
    for (const entry of byKey.values()) {
      if (entry.nextAttemptAt > now) continue;
      try {
        const res = await fetch(entry.url, {
          method: entry.method,
          headers: { 'content-type': 'application/json' },
          body: entry.body,
          credentials: 'same-origin',
        });
        if (res.ok) {
          await deleteOutbox(entry.id);
        } else if (res.status === 401) {
          // not authed — stop draining, user will re-login
          break;
        } else {
          entry.attempts += 1;
          if (entry.attempts >= OUTBOX_MAX_ATTEMPTS) {
            await deleteOutbox(entry.id);
          } else {
            entry.nextAttemptAt = Date.now() + backoffMs(entry.attempts);
            await updateOutbox(entry);
          }
        }
      } catch (_) {
        entry.attempts += 1;
        if (entry.attempts >= OUTBOX_MAX_ATTEMPTS) {
          await deleteOutbox(entry.id);
        } else {
          entry.nextAttemptAt = Date.now() + backoffMs(entry.attempts);
          await updateOutbox(entry);
        }
      }
    }
  } finally {
    draining = false;
  }
}

export function installOutboxDrainers() {
  window.addEventListener('online', () => { drainOutbox(); });
  window.addEventListener('pageshow', () => { drainOutbox(); });
}
