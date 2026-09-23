import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB } from '../../test/fake-idb.js';

// Browser globals the module graph touches: idb.js → indexedDB,
// api.js → fetch, session-state.js / persistence.js → localStorage.
const fake = createFakeIndexedDB();
globalThis.indexedDB = fake;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const calls = [];
let respond = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, opts = {}) => {
  const call = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
  calls.push(call);
  const { status, body } = respond(call);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
};

const { createSessionState, STATES } = await import('./session-state.js');
const idb = await import('./idb.js');

function makeDraft(over = {}) {
  return {
    id: 'sess-1', template_id: 7, started_at: 1, updated_at: 1,
    client_version: 3, finalized_at: null, notes: null, values: [], ...over,
  };
}

test('finalize flushes the draft, posts finalize, clears local copies, ends FINALIZED', async () => {
  calls.length = 0;
  respond = (c) => c.url.endsWith('/finalize')
    ? { status: 200, body: { finalized_at: 12345 } }
    : { status: 200, body: { server_version: 3 } };
  const draft = makeDraft();
  await idb.putDraft(draft);
  localStorage.setItem('draft:sess-1', JSON.stringify(draft));
  const states = [];
  const s = createSessionState({ draft, onChange: ({ state }) => states.push(state) });

  const res = await s.finalize({ durationSeconds: 90 });

  assert.deepEqual(res, { finalized_at: 12345 });
  assert.equal(draft.finalized_at, 12345);
  assert.deepEqual(calls.map(c => [c.method, c.url]), [
    ['PATCH', '/api/drafts/sess-1'],
    ['POST', '/api/sessions/sess-1/finalize'],
  ]);
  assert.deepEqual(calls[1].body, { client_version: 3, duration_seconds: 90 });
  assert.equal(await idb.getDraft('sess-1'), undefined);
  assert.equal(localStorage.getItem('draft:sess-1'), null);
  assert.equal(s.getState(), STATES.FINALIZED);
  assert.deepEqual(states, [STATES.SAVING, STATES.SAVED, STATES.FINALIZING, STATES.FINALIZED]);
});

test('finalize rejects and returns to SAVED when the server refuses', async () => {
  calls.length = 0;
  respond = (c) => c.url.endsWith('/finalize')
    ? { status: 409, body: { error: 'stale', server_version: 9 } }
    : { status: 200, body: { server_version: 3 } };
  const draft = makeDraft({ id: 'sess-2' });
  const s = createSessionState({ draft });

  await assert.rejects(() => s.finalize(), (err) => err.status === 409);
  assert.equal(draft.finalized_at, null);
  assert.equal(s.getState(), STATES.SAVED);
});

// --- IndexedDB unavailable (HANDOFF 2026-09-13) ---
// The server's answer is the source of truth. Local cleanup failing after a
// successful finalize must not read as a save failure, or Next stays locked.

test('finalize still succeeds when local cleanup throws after the server accepted', async () => {
  calls.length = 0;
  respond = (c) => c.url.endsWith('/finalize')
    ? { status: 200, body: { finalized_at: 777 } }
    : { status: 200, body: { server_version: 3 } };
  const draft = makeDraft({ id: 'sess-3' });
  const s = createSessionState({ draft });
  fake.killConnections();
  fake.failOpens = true;
  try {
    const res = await s.finalize({ durationSeconds: 5 });
    assert.deepEqual(res, { finalized_at: 777 });
    assert.equal(draft.finalized_at, 777);
    assert.equal(s.getState(), STATES.FINALIZED);
    assert.equal(calls.filter(c => c.url.endsWith('/finalize')).length, 1);
  } finally {
    fake.failOpens = false;
  }
});

test('a failed PATCH with no outbox available still reaches the finalize call', async () => {
  calls.length = 0;
  respond = (c) => c.url.endsWith('/finalize')
    ? { status: 200, body: { finalized_at: 888 } }
    : { status: 503, body: { error: 'down' } };
  const draft = makeDraft({ id: 'sess-4' });
  const s = createSessionState({ draft });
  fake.killConnections();
  fake.failOpens = true;
  try {
    const res = await s.finalize();
    assert.deepEqual(res, { finalized_at: 888 });
    assert.equal(s.getState(), STATES.FINALIZED);
  } finally {
    fake.failOpens = false;
  }
});

// --- 409 on a draft PATCH (code audit 2026-09-22) ---
// The server holds a higher client_version (a beacon or another tab got
// there first). The draft on screen is what the user sees, so it wins: jump
// past the server's version and push again, instead of 409ing on every Next
// until enough edits outpace it.

test('a 409 on the draft PATCH re-pushes past the server version and ends SAVED', async () => {
  calls.length = 0;
  let patches = 0;
  respond = (c) => {
    if (c.url.endsWith('/finalize')) return { status: 200, body: { finalized_at: 999 } };
    patches += 1;
    return patches === 1
      ? { status: 409, body: { server_version: 9, updated_at: null, stale: true } }
      : { status: 200, body: { server_version: c.body.client_version } };
  };
  const draft = makeDraft({ id: 'sess-409', client_version: 3 });
  const s = createSessionState({ draft });

  await s.flushNow();
  assert.deepEqual(calls.map(c => c.body?.client_version), [3, 10]);
  assert.equal(draft.client_version, 10);
  assert.equal(JSON.parse(localStorage.getItem('draft:sess-409')).client_version, 10);
  assert.equal(s.getState(), STATES.SAVED);

  await s.finalize();
  assert.deepEqual(calls.at(-1).body, { client_version: 10 });
  assert.equal(s.getState(), STATES.FINALIZED);
});
