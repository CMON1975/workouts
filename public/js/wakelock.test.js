import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock } from './wakelock.js';

function fakeNavigator({ reject = null } = {}) {
  const sentinels = [];
  const nav = {
    requests: [],
    sentinels,
    wakeLock: {
      async request(type) {
        nav.requests.push(type);
        if (reject) throw reject;
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
