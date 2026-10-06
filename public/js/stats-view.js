// The Stats view's DOM. Read-only and network-required: it has nothing to
// lose on a tab eviction, so it skips the drafts/outbox machinery.

function el(tag, attrs = {}, text = null) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// A refetch keeps the previous render, dimmed, instead of flashing a
// skeleton; only a first load says "Loading".
export function renderStatsLoading(root) {
  if (root.childElementCount && !root.querySelector('#stats-retry')) {
    root.classList.add('stale');
    root.setAttribute('aria-busy', 'true');
    return;
  }
  root.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
}

export function renderStatsError(root, onRetry) {
  root.classList.remove('stale');
  root.removeAttribute('aria-busy');
  const retry = el('button', { id: 'stats-retry', type: 'button', class: 'secondary' }, 'Retry');
  retry.addEventListener('click', onRetry);
  root.replaceChildren(el('p', { class: 'err' }, 'Couldn’t load stats. Check the connection and try again.'), retry);
}

export function renderStatsView(root, { payload }) {
  root.classList.remove('stale');
  root.removeAttribute('aria-busy');
  if (!payload.sessions.length) {
    root.replaceChildren(el('p', { id: 'stats-empty', class: 'muted' }, 'No finished workouts yet.'));
    return;
  }
  root.replaceChildren();
}
