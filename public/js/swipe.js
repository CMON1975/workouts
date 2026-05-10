// Swipe-to-reveal a row-trailing action button. One wrap open at a time.
// Wrap structure expected:
//   <div class="row-wrap">
//     <... class="row-foreground">  ← clickable content (navigates etc.)
//     <button class="row-action">    ← revealed by leftward swipe
//   </div>

const REVEAL = 88;
const SLOP = 8;

let openWrap = null;

function closeWrap(wrap) {
  if (!wrap) return;
  wrap.classList.remove('is-open');
  const fg = wrap.querySelector('.row-foreground');
  if (fg) fg.style.transform = '';
  if (openWrap === wrap) openWrap = null;
}

export function closeAnyOpenRow() {
  closeWrap(openWrap);
}

export function attachSwipeReveal(wrap, { onAction }) {
  const fg = wrap.querySelector('.row-foreground');
  const action = wrap.querySelector('.row-action');
  if (!fg || !action) return;

  let startX = 0, startY = 0;
  let decided = false;
  let isHoriz = false;
  let captured = false;
  let suppressClick = false;
  let pointerId = null;

  function setOpen(open) {
    if (open) {
      if (openWrap && openWrap !== wrap) closeWrap(openWrap);
      openWrap = wrap;
      wrap.classList.add('is-open');
      fg.style.transform = `translateX(-${REVEAL}px)`;
    } else {
      closeWrap(wrap);
    }
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    decided = false;
    isHoriz = false;
    captured = false;
    suppressClick = false;
    pointerId = e.pointerId;
    // Suspend the snap transition while the finger is moving.
    fg.style.transition = 'none';
  }

  function onMove(e) {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) {
        decided = true;
        isHoriz = false;
        return;
      }
      if (Math.abs(dx) > SLOP) {
        decided = true;
        isHoriz = true;
        try { wrap.setPointerCapture(pointerId); captured = true; } catch (_) {}
      }
    }
    if (!isHoriz) return;
    e.preventDefault();
    const base = openWrap === wrap ? -REVEAL : 0;
    const x = Math.max(-REVEAL, Math.min(0, base + dx));
    fg.style.transform = `translateX(${x}px)`;
  }

  function onUp(e) {
    if (e.pointerId !== pointerId) return;
    fg.style.transition = '';
    if (captured) {
      try { wrap.releasePointerCapture(pointerId); } catch (_) {}
      captured = false;
    }
    if (isHoriz) {
      const dx = e.clientX - startX;
      const base = openWrap === wrap ? -REVEAL : 0;
      const finalX = Math.max(-REVEAL, Math.min(0, base + dx));
      setOpen(finalX <= -REVEAL / 2);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    } else {
      // Tap. If the tap landed on the action button, let its own click handler run.
      // If the wrap is open and the tap was on the foreground, close it and swallow nav.
      if (action.contains(e.target)) {
        // no-op here — action's click handler will fire
      } else if (openWrap === wrap) {
        setOpen(false);
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
    }
    pointerId = null;
    decided = false;
    isHoriz = false;
  }

  function onClickCapture(e) {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onActionClick(e) {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    onAction();
  }

  wrap.addEventListener('pointerdown', onDown);
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
  wrap.addEventListener('pointercancel', onUp);
  wrap.addEventListener('click', onClickCapture, true);
  action.addEventListener('click', onActionClick);
}
