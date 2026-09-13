// Screen Wake Lock for routine runs. The OS releases the lock whenever the
// page hides (tab switch, lock button), so the app tracks whether a lock is
// *wanted* and re-requests on the next visible / gesture. Every failure
// path resolves false: an unsupported browser or a refused request must
// never break the runner.

export function createWakeLock({ navigator = globalThis.navigator } = {}) {
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
      s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
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
    if (!wanted || sentinel) return;
    await acquire();
  }

  function isHeld() { return sentinel != null; }

  return { acquire, release, reacquireIfWanted, isHeld };
}
