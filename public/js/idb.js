const DB_NAME = 'workouts';
const DB_VER = 2;

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('IDB blocked — close other tabs');
  });
  return _dbPromise;
}

function tx(db, stores, mode = 'readonly') {
  return db.transaction(stores, mode);
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
  const db = await openDB();
  const t = tx(db, ['drafts', 'meta'], 'readwrite');
  t.objectStore('drafts').put(draft);
  t.objectStore('meta').put({ k: 'lastActiveSessionId', v: draft.id });
  await awaitTx(t);
}

export async function getDraft(id) {
  const db = await openDB();
  return awaitReq(tx(db, 'drafts').objectStore('drafts').get(id));
}

export async function deleteDraft(id) {
  const db = await openDB();
  const t = tx(db, ['drafts', 'meta'], 'readwrite');
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
  const db = await openDB();
  const r = await awaitReq(tx(db, 'meta').objectStore('meta').get('lastActiveSessionId'));
  return r?.v ?? null;
}

export async function listDrafts() {
  const db = await openDB();
  return awaitReq(tx(db, 'drafts').objectStore('drafts').getAll());
}

export async function enqueueOutbox(entry) {
  const db = await openDB();
  const t = tx(db, 'outbox', 'readwrite');
  t.objectStore('outbox').add(entry);
  await awaitTx(t);
}

export async function listOutbox() {
  const db = await openDB();
  return awaitReq(tx(db, 'outbox').objectStore('outbox').getAll());
}

export async function deleteOutbox(id) {
  const db = await openDB();
  const t = tx(db, 'outbox', 'readwrite');
  t.objectStore('outbox').delete(id);
  await awaitTx(t);
}

export async function updateOutbox(entry) {
  const db = await openDB();
  const t = tx(db, 'outbox', 'readwrite');
  t.objectStore('outbox').put(entry);
  await awaitTx(t);
}

// --- Workouts (routine-run wrappers) ---

export async function putWorkout(workout) {
  const db = await openDB();
  const t = tx(db, ['workouts', 'meta'], 'readwrite');
  t.objectStore('workouts').put(workout);
  t.objectStore('meta').put({ k: 'activeWorkoutId', v: workout.id });
  await awaitTx(t);
}

export async function getWorkout(id) {
  const db = await openDB();
  return awaitReq(tx(db, 'workouts').objectStore('workouts').get(id));
}

export async function deleteWorkout(id) {
  const db = await openDB();
  const t = tx(db, ['workouts', 'meta'], 'readwrite');
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
  const db = await openDB();
  const r = await awaitReq(tx(db, 'meta').objectStore('meta').get('activeWorkoutId'));
  return r?.v ?? null;
}

export async function clearActiveWorkoutId() {
  const db = await openDB();
  const t = tx(db, 'meta', 'readwrite');
  t.objectStore('meta').delete('activeWorkoutId');
  await awaitTx(t);
}
