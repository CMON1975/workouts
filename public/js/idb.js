const DB_NAME = 'workouts';
const DB_VER = 2;

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  const p = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('drafts')) {
        const drafts = db.createObjectStore('drafts', { keyPath: 'id' });
        drafts.createIndex('byTemplate', 'template_id');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('workouts')) {
        db.createObjectStore('workouts', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // WebKit closes connections while a tab is suspended (iOS sleep / app
      // switch). Drop the cached handle so the next call reopens instead of
      // throwing InvalidStateError forever; a hard refresh was the only way
      // out before (HANDOFF 2026-09-13).
      db.onclose = () => { if (_dbPromise === p) _dbPromise = null; };
      db.onversionchange = () => { db.close(); if (_dbPromise === p) _dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { if (_dbPromise === p) _dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('IDB blocked — close other tabs');
  });
  _dbPromise = p;
  return p;
}

// Opens a transaction on the cached connection, reopening once if the handle
// is dead. iOS does not reliably fire `close`, so the InvalidStateError from
// transaction() is the other signal that the connection went away.
async function tx(stores, mode = 'readonly') {
  const db = await openDB();
  try {
    return db.transaction(stores, mode);
  } catch (err) {
    if (err?.name !== 'InvalidStateError') throw err;
    if (_dbPromise && (await _dbPromise) === db) _dbPromise = null;
    const fresh = await openDB();
    return fresh.transaction(stores, mode);
  }
}

function awaitReq(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function awaitTx(t) {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function putDraft(draft) {
  const t = await tx(['drafts', 'meta'], 'readwrite');
  t.objectStore('drafts').put(draft);
  t.objectStore('meta').put({ k: 'lastActiveSessionId', v: draft.id });
  await awaitTx(t);
}

export async function getDraft(id) {
  return awaitReq((await tx('drafts')).objectStore('drafts').get(id));
}

export async function deleteDraft(id) {
  const t = await tx(['drafts', 'meta'], 'readwrite');
  t.objectStore('drafts').delete(id);
  const metaReq = t.objectStore('meta').get('lastActiveSessionId');
  await new Promise((res) => {
    metaReq.onsuccess = () => {
      if (metaReq.result?.v === id) t.objectStore('meta').delete('lastActiveSessionId');
      res();
    };
    metaReq.onerror = () => res();
  });
  await awaitTx(t);
}

export async function getLastActiveSessionId() {
  const r = await awaitReq((await tx('meta')).objectStore('meta').get('lastActiveSessionId'));
  return r?.v ?? null;
}

export async function listDrafts() {
  return awaitReq((await tx('drafts')).objectStore('drafts').getAll());
}

export async function enqueueOutbox(entry) {
  const t = await tx('outbox', 'readwrite');
  t.objectStore('outbox').add(entry);
  await awaitTx(t);
}

export async function listOutbox() {
  return awaitReq((await tx('outbox')).objectStore('outbox').getAll());
}

export async function deleteOutbox(id) {
  const t = await tx('outbox', 'readwrite');
  t.objectStore('outbox').delete(id);
  await awaitTx(t);
}

export async function updateOutbox(entry) {
  const t = await tx('outbox', 'readwrite');
  t.objectStore('outbox').put(entry);
  await awaitTx(t);
}

export async function deleteOutboxByDraftId(draftId) {
  const t = await tx('outbox', 'readwrite');
  const store = t.objectStore('outbox');
  const all = await awaitReq(store.getAll());
  for (const entry of all) {
    if (entry.draftId === draftId) store.delete(entry.id);
  }
  await awaitTx(t);
}

// --- Workouts (routine-run wrappers) ---

export async function putWorkout(workout) {
  const t = await tx(['workouts', 'meta'], 'readwrite');
  t.objectStore('workouts').put(workout);
  t.objectStore('meta').put({ k: 'activeWorkoutId', v: workout.id });
  await awaitTx(t);
}

export async function getWorkout(id) {
  return awaitReq((await tx('workouts')).objectStore('workouts').get(id));
}

export async function deleteWorkout(id) {
  const t = await tx(['workouts', 'meta'], 'readwrite');
  t.objectStore('workouts').delete(id);
  const metaReq = t.objectStore('meta').get('activeWorkoutId');
  await new Promise((res) => {
    metaReq.onsuccess = () => {
      if (metaReq.result?.v === id) t.objectStore('meta').delete('activeWorkoutId');
      res();
    };
    metaReq.onerror = () => res();
  });
  await awaitTx(t);
}

export async function getActiveWorkoutId() {
  const r = await awaitReq((await tx('meta')).objectStore('meta').get('activeWorkoutId'));
  return r?.v ?? null;
}

export async function clearActiveWorkoutId() {
  const t = await tx('meta', 'readwrite');
  t.objectStore('meta').delete('activeWorkoutId');
  await awaitTx(t);
}
