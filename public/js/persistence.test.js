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

const { loadLocalDraft } = await import('./persistence.js');
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
