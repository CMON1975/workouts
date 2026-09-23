import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock } from './wakelock.js';

function fakeNavigator({ reject = null } = {}) {
  const sentinels = [];
  const nav = {
    requests: [],
    sentinels,
    reject,
    wakeLock: {
      async request(type) {
        nav.requests.push(type);
        if (nav.reject) throw nav.reject;
        const listeners = {};
        const s = {
          released: false,
          addEventListener: (ev, fn) => { listeners[ev] = fn; },
          async release() { s.released = true; listeners.release?.(); },
          // The OS releasing it (tab hidden) fires the same event.
          osRelease() { s.released = true; listeners.release?.(); },
        };
        sentinels.push(s);
        return s;
      },
    },
  };
  return nav;
}

test('acquire requests a screen lock once and holds it', async () => {
  const nav = fakeNavigator();
  const wl = createWakeLock({ navigator: nav });
  assert.equal(await wl.acquire(), true);
  assert.equal(await wl.acquire(), true);
  assert.deepEqual(nav.requests, ['screen']);
  assert.equal(wl.isHeld(), true);
});

test('release drops the lock and clears the wanted flag', async () => {
  const nav = fakeNavigator();
  const wl = createWakeLock({ navigator: nav });
  await wl.acquire();
  await wl.release();
  assert.equal(nav.sentinels[0].released, true);
  assert.equal(wl.isHeld(), false);
  // Not wanted any more: a visibility wake must not re-request.
  await wl.reacquireIfWanted();
  assert.deepEqual(nav.requests, ['screen']);
});

test('after the OS releases it, reacquireIfWanted requests again', async () => {
  const nav = fakeNavigator();
  const wl = createWakeLock({ navigator: nav });
  await wl.acquire();
  nav.sentinels[0].osRelease();
  assert.equal(wl.isHeld(), false);
  await wl.reacquireIfWanted();
  assert.deepEqual(nav.requests, ['screen', 'screen']);
  assert.equal(wl.isHeld(), true);
});

test('missing API or a refused request resolves false without throwing', async () => {
  const none = createWakeLock({ navigator: {} });
  assert.equal(await none.acquire(), false);
  assert.equal(none.isHeld(), false);
  await none.release();

  const nav = fakeNavigator({ reject: new DOMException('nope', 'NotAllowedError') });
  const wl = createWakeLock({ navigator: nav });
  assert.equal(await wl.acquire(), false);
  assert.equal(wl.isHeld(), false);
  // Still wanted: a later gesture-backed acquire retries.
  await wl.reacquireIfWanted();
  assert.deepEqual(nav.requests, ['screen', 'screen']);
});

// HANDOFF 2026-09-20: the 70-min walk lost the lock while the page stayed
// visible (low power / thermal release), and nothing asked for it back until
// the next press. An OS release with the page still visible re-requests at
// once; a refusal is reported so the runner can say so instead of going dark.
test('an OS release while visible re-requests by itself', async () => {
  const nav = fakeNavigator();
  const doc = { visibilityState: 'visible' };
  const lost = [];
  const wl = createWakeLock({ navigator: nav, document: doc, onLost: () => lost.push(1) });
  await wl.acquire();
  nav.sentinels[0].osRelease();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(nav.requests, ['screen', 'screen']);
  assert.equal(wl.isHeld(), true);
  assert.equal(lost.length, 0);
  // Hidden: the release is expected, so wait for the visibility wake.
  doc.visibilityState = 'hidden';
  nav.sentinels[1].osRelease();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(nav.requests, ['screen', 'screen']);
  assert.equal(wl.isHeld(), false);
  assert.equal(lost.length, 0);
});

test('a refused re-request reports the lock as lost, once per loss', async () => {
  const nav = fakeNavigator();
  const doc = { visibilityState: 'visible' };
  const lost = [];
  const wl = createWakeLock({ navigator: nav, document: doc, onLost: () => lost.push(1) });
  await wl.acquire();
  nav.reject = new DOMException('low power', 'NotAllowedError');
  nav.sentinels[0].osRelease();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(wl.isHeld(), false);
  assert.equal(lost.length, 1);
  // The visibility wake / press path reports too when it is still refused.
  assert.equal(await wl.reacquireIfWanted(), false);
  assert.equal(lost.length, 2);
  // Granted again: silent.
  nav.reject = null;
  assert.equal(await wl.reacquireIfWanted(), true);
  assert.equal(lost.length, 2);
  // Not wanted (run over): a refusal is not a loss.
  await wl.release();
  nav.reject = new DOMException('nope', 'NotAllowedError');
  await wl.reacquireIfWanted();
  assert.equal(lost.length, 2);
});

// pageshow + visibilitychange both wake the runner on a bfcache restore, and
// a press can land while a request is still in flight.
test('overlapping acquires share one request and one lock', async () => {
  const nav = fakeNavigator();
  const wl = createWakeLock({ navigator: nav });
  assert.deepEqual(await Promise.all([wl.acquire(), wl.reacquireIfWanted()]), [true, true]);
  assert.deepEqual(nav.requests, ['screen']);
  await wl.release();
  assert.ok(nav.sentinels.every(s => s.released), 'no lock left behind');
});

test('a release while the request is in flight drops the lock when it arrives', async () => {
  const nav = fakeNavigator();
  const lost = [];
  const wl = createWakeLock({ navigator: nav, onLost: () => lost.push(1) });
  const pending = wl.acquire();
  await wl.release();
  assert.equal(await pending, false);
  assert.equal(wl.isHeld(), false);
  assert.equal(nav.sentinels[0].released, true);
  assert.deepEqual(lost, [], 'not wanted, so not lost');
});

test('a request that throws synchronously does not wedge later acquires', async () => {
  const nav = fakeNavigator();
  const real = nav.wakeLock.request;
  nav.wakeLock.request = () => { throw new Error('NotAllowedError'); };
  const wl = createWakeLock({ navigator: nav });
  assert.equal(await wl.acquire(), false);
  nav.wakeLock.request = real;
  assert.equal(await wl.acquire(), true);
  assert.equal(wl.isHeld(), true);
});
