// Screen Wake Lock for routine runs. The OS releases the lock whenever the
// page hides (tab switch, lock button), so the app tracks whether a lock is
// *wanted* and re-requests on the next visible / gesture. A release while
// the page is still visible (low power mode, thermal, battery) is not
// expected, so it re-requests at once; when that — or any wanted
// re-request — is refused, `onLost` fires so the runner can say the screen
// may sleep instead of going dark silently. Every failure path resolves
// false: an unsupported browser or a refused request must never break the
// runner.

export function createWakeLock({
  navigator = globalThis.navigator,
  document = globalThis.document,
  onLost = () => {},
} = {}) {
  let sentinel = null;
  let wanted = false;

  function supported() {
    return !!navigator?.wakeLock?.request;
  }

  async function acquire() {
    wanted = true;
    if (sentinel) return true;
    if (!supported()) return false;
    try {
      const s = await navigator.wakeLock.request('screen');
      s.addEventListener('release', () => {
        if (sentinel !== s) return;
        sentinel = null;
        if (wanted && document?.visibilityState === 'visible') reacquireIfWanted();
      });
      sentinel = s;
      return true;
    } catch (_) {
      return false;
    }
  }

  async function release() {
    wanted = false;
    const s = sentinel;
    sentinel = null;
    if (!s) return;
    try { await s.release(); } catch (_) {}
  }

  async function reacquireIfWanted() {
    if (!wanted || sentinel) return wanted;
    const ok = await acquire();
    if (!ok && wanted) onLost();
    return ok;
  }

  function isHeld() { return sentinel != null; }

  return { acquire, release, reacquireIfWanted, isHeld };
}
