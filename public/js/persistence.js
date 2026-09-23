import { putDraft, getDraft, enqueueOutbox, listOutbox, deleteOutbox, updateOutbox } from './idb.js';

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

// Newest local copy of a draft for a restore: the IDB record or the shadow,
// whichever has the higher client_version (the shadow is written first on
// hide because the IDB put may not commit before a freeze). An IDB failure
// falls back to the shadow alone.
export async function loadLocalDraft(id) {
  let stored = null;
  try { stored = (await getDraft(id)) ?? null; } catch (_) {}
  const shadow = readShadow(id);
  if (!stored || !shadow) return stored ?? shadow;
  return (shadow.client_version ?? -1) > (stored.client_version ?? -1) ? shadow : stored;
}

// Background reconcile after a resume: the server copy replaces the resumed
// draft only when it is newer, still a draft, and nothing was typed since
// the form was drawn (client_version unchanged). The on-screen draft wins
// otherwise, as on a 409. Null = keep local.
export function serverDraftToAdopt({ local, server, versionAtBind }) {
  if (!server || server.finalized_at) return null;
  if (local.client_version !== versionAtBind) return null;
  if (!(server.client_version > local.client_version)) return null;
  return { ...server, workout_id: local.workout_id ?? server.workout_id ?? null };
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
        // 409 = the server holds a newer version; the same body can never
        // land. The live session / next restore re-pushes past it.
        if (res.ok || res.status === 409) {
          await deleteOutbox(entry.id);
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
