// The bible's confirm (design_bible PATTERNS.md "Confirm", ported from
// _confirm_script.html): the step before an action that throws work away.
// A [data-confirm] box holds three bars, one shown at a time: idle (the ask
// button), ask (the question, the safe answer and the danger one) and done
// (what happened), plus a status line under them. Asking moves focus to the
// safe answer; it or Escape goes back to idle, focus on the ask button. The
// danger answer fires confirm:go on the box, so the page does the work and
// can word the done bar, then shows done with focus on its first button;
// undo fires confirm:undo and goes back to idle.
//
// Work that can fail (a request) holds the next bar: the page calls
// event.detail.waitUntil(promise) in its handler. The box is aria-busy
// meanwhile, the status line says the button's data-pending words, and
// clicks and Escape in the box do nothing. Nothing is disabled, so focus
// stays on the button: a rejection leaves it there with the reason's
// message in the status line, in danger, and Enter tries again.
//
// App deviation: the bible's done bar always holds undo. Workouts' End
// workout has no way back yet, so done focuses whatever button it holds.

function say(box, words, failed) {
  const status = box.querySelector('[data-confirm-status]');
  if (!status) return;
  status.textContent = words;
  status.classList.toggle('failed', failed);
}

function showBar(box, bar) {
  box.querySelectorAll('[data-confirm-bar]').forEach((each) => {
    each.hidden = each.dataset.confirmBar !== bar;
  });
  say(box, '', false);
}

function show(box, bar, focus) {
  showBar(box, bar);
  box.querySelector(focus).focus();
}

function run(box, button, name, bar, focus) {
  const waits = [];
  box.dispatchEvent(new CustomEvent(name, {
    bubbles: true,
    detail: { waitUntil: (promise) => { waits.push(promise); } },
  }));
  if (!waits.length) return show(box, bar, focus);
  box.setAttribute('aria-busy', 'true');
  say(box, button.dataset.pending || '', false);
  Promise.all(waits).then(() => {
    box.removeAttribute('aria-busy');
    show(box, bar, focus);
  }, (reason) => {
    box.removeAttribute('aria-busy');
    say(box, String(reason?.message || reason), true);
  });
}

// Back to the idle bar without moving focus: a box reused for the next run.
export function resetConfirm(box) {
  box.removeAttribute('aria-busy');
  showBar(box, 'idle');
}

export function installConfirm(doc = document) {
  doc.addEventListener('click', (e) => {
    const box = e.target.closest('[data-confirm]');
    if (!box || box.getAttribute('aria-busy') === 'true') return;
    const go = e.target.closest('[data-confirm-go]');
    const undo = e.target.closest('[data-confirm-undo]');
    if (e.target.closest('[data-confirm-ask]')) {
      show(box, 'ask', '[data-confirm-keep]');
    } else if (e.target.closest('[data-confirm-keep]')) {
      show(box, 'idle', '[data-confirm-ask]');
    } else if (go) {
      run(box, go, 'confirm:go', 'done', '[data-confirm-bar="done"] button');
    } else if (undo) {
      run(box, undo, 'confirm:undo', 'idle', '[data-confirm-ask]');
    }
  });
  doc.addEventListener('keydown', (e) => {
    const box = e.target.closest('[data-confirm]');
    if (e.key === 'Escape' && e.target.closest('[data-confirm-bar="ask"]')
        && box.getAttribute('aria-busy') !== 'true') {
      show(box, 'idle', '[data-confirm-ask]');
    }
  });
}
