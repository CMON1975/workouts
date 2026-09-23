import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB } from '../../test/fake-idb.js';

const fake = createFakeIndexedDB();
globalThis.indexedDB = fake;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

let respondStatus = 200;
globalThis.fetch = async () => new Response('{}', { status: respondStatus });

const { loadLocalDraft, enqueueFailedPatch, drainOutbox, serverDraftToAdopt } = await import('./persistence.js');
const idb = await import('./idb.js');

const draft = (id, client_version) => ({ id, template_id: 3, client_version, values: [] });
const shadow = (d) => localStorage.setItem('draft:' + d.id, JSON.stringify(d));

// The shadow is written synchronously on hide precisely because the IDB put
// may not commit before WebKit freezes the tab, so it can be the newer copy.
test('loadLocalDraft takes whichever local copy has the higher client_version', async () => {
  await idb.putDraft(draft('a', 8));
  shadow(draft('a', 10));
  assert.equal((await loadLocalDraft('a')).client_version, 10, 'shadow newer');

  await idb.putDraft(draft('b', 5));
  shadow(draft('b', 4));
  assert.equal((await loadLocalDraft('b')).client_version, 5, 'IDB newer');

  await idb.putDraft(draft('c', 2));
  assert.equal((await loadLocalDraft('c')).client_version, 2, 'IDB only');
  shadow(draft('d', 1));
  assert.equal((await loadLocalDraft('d')).client_version, 1, 'shadow only');
  assert.equal(await loadLocalDraft('none'), null);
});

test('loadLocalDraft falls back to the shadow when IndexedDB throws', async () => {
  shadow(draft('e', 3));
  fake.killConnections();
  fake.failOpens = true;
  try {
    assert.equal((await loadLocalDraft('e')).client_version, 3);
  } finally {
    fake.failOpens = false;
  }
});

// ---- outbox drain ----

async function clearOutbox() {
  for (const e of await idb.listOutbox()) await idb.deleteOutbox(e.id);
}

test('drainOutbox keeps a failed entry for a later retry and counts the attempt (characterization)', async () => {
  await clearOutbox();
  await enqueueFailedPatch(draft('o1', 4));
  respondStatus = 503;
  await drainOutbox();
  const left = await idb.listOutbox();
  assert.equal(left.length, 1);
  assert.equal(left[0].attempts, 1);
  assert.ok(left[0].nextAttemptAt > Date.now());
});

// A 409 means the server holds a newer version: resending the same body can
// never succeed. The local draft is still in IDB / the shadow, and the live
// session (or the next restore) re-pushes it past the server's version.
test('drainOutbox drops an entry the server rejects as stale (409)', async () => {
  await clearOutbox();
  await enqueueFailedPatch(draft('o2', 4));
  respondStatus = 409;
  await drainOutbox();
  assert.deepEqual(await idb.listOutbox(), []);
  respondStatus = 200;
});

// ---- background reconcile on resume (code audit 2026-09-22) ----
// The server copy replaces the resumed draft only when it is newer, still a
// draft, and the user has not typed since the form was drawn; otherwise the
// screen (and the edit just made) would silently diverge from the draft.

test('serverDraftToAdopt takes a newer server draft when nothing was typed since bind', () => {
  const local = { ...draft('r1', 5), workout_id: 'w-1' };
  const server = { ...draft('r1', 7), values: [{ row_index: 0, column_id: 1, value_num: 9 }] };
  assert.deepEqual(serverDraftToAdopt({ local, server, versionAtBind: 5 }), { ...server, workout_id: 'w-1' });
});

test('serverDraftToAdopt keeps the local draft otherwise', () => {
  const local = draft('r2', 5);
  assert.equal(serverDraftToAdopt({ local, server: draft('r2', 7), versionAtBind: 4 }), null, 'typed since bind');
  assert.equal(serverDraftToAdopt({ local, server: draft('r2', 5), versionAtBind: 5 }), null, 'not newer');
  assert.equal(serverDraftToAdopt({ local, server: { ...draft('r2', 7), finalized_at: 1 }, versionAtBind: 5 }), null, 'finalized');
  assert.equal(serverDraftToAdopt({ local, server: null, versionAtBind: 5 }), null);
});
