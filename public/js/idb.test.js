import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB } from '../../test/fake-idb.js';

const fake = createFakeIndexedDB();
globalThis.indexedDB = fake;
const idb = await import('./idb.js');

test('putDraft / getDraft round-trip and track lastActiveSessionId', async () => {
  await idb.putDraft({ id: 'd1', template_id: 3, values: [] });
  assert.deepEqual(await idb.getDraft('d1'), { id: 'd1', template_id: 3, values: [] });
  assert.equal(await idb.getLastActiveSessionId(), 'd1');
});

test('deleteDraft removes the draft and clears lastActiveSessionId only if it matches', async () => {
  await idb.putDraft({ id: 'd2', template_id: 3, values: [] });
  await idb.putDraft({ id: 'd3', template_id: 3, values: [] });
  await idb.deleteDraft('d2');
  assert.equal(await idb.getDraft('d2'), undefined);
  assert.equal(await idb.getLastActiveSessionId(), 'd3');
  await idb.deleteDraft('d3');
  assert.equal(await idb.getLastActiveSessionId(), null);
});

test('outbox: enqueue, list, update, delete, deleteByDraftId', async () => {
  await idb.enqueueOutbox({ url: '/a', draftId: 'x', clientVersion: 1 });
  await idb.enqueueOutbox({ url: '/b', draftId: 'y', clientVersion: 1 });
  let all = await idb.listOutbox();
  assert.equal(all.length, 2);
  const a = all.find(e => e.url === '/a');
  await idb.updateOutbox({ ...a, attempts: 2 });
  all = await idb.listOutbox();
  assert.equal(all.find(e => e.url === '/a').attempts, 2);
  await idb.deleteOutboxByDraftId('x');
  all = await idb.listOutbox();
  assert.deepEqual(all.map(e => e.url), ['/b']);
  await idb.deleteOutbox(all[0].id);
  assert.deepEqual(await idb.listOutbox(), []);
});

test('workouts: put sets activeWorkoutId, delete clears it, clearActiveWorkoutId is explicit', async () => {
  await idb.putWorkout({ id: 'w1', routine_id: 5 });
  assert.equal(await idb.getActiveWorkoutId(), 'w1');
  assert.deepEqual(await idb.getWorkout('w1'), { id: 'w1', routine_id: 5 });
  await idb.deleteWorkout('w1');
  assert.equal(await idb.getWorkout('w1'), undefined);
  assert.equal(await idb.getActiveWorkoutId(), null);
  await idb.putWorkout({ id: 'w2', routine_id: 5 });
  await idb.clearActiveWorkoutId();
  assert.equal(await idb.getActiveWorkoutId(), null);
  assert.deepEqual(await idb.getWorkout('w2'), { id: 'w2', routine_id: 5 });
});

test('openDB reuses one connection across calls', async () => {
  const before = fake.opens;
  await idb.getDraft('nope');
  await idb.getDraft('nope');
  assert.equal(fake.opens, before);
  assert.equal(fake.liveConnections(), 1);
});

// --- Suspended-tab recovery ---
// iOS WebKit closes IndexedDB connections while a tab is suspended. A cached
// handle then throws InvalidStateError from transaction() forever, which is
// what locked Next after the phone slept (HANDOFF 2026-09-13).

test('reopens after the OS closes the connection with a close event', async () => {
  await idb.putDraft({ id: 'k1', template_id: 1, values: [] });
  fake.killConnections({ fireClose: true });
  await idb.putDraft({ id: 'k2', template_id: 1, values: [] });
  assert.deepEqual(await idb.getDraft('k1'), { id: 'k1', template_id: 1, values: [] });
  assert.deepEqual(await idb.getDraft('k2'), { id: 'k2', template_id: 1, values: [] });
  assert.equal(fake.liveConnections(), 1);
});

test('reopens after a silent close (no close event) on the first InvalidStateError', async () => {
  const before = fake.opens;
  fake.killConnections({ fireClose: false });
  await idb.deleteDraft('k1');
  assert.equal(await idb.getDraft('k1'), undefined);
  assert.equal(fake.opens, before + 1);
  assert.equal(fake.liveConnections(), 1);
});
