async function request(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: opts.body
      ? { 'content-type': 'application/json', ...(opts.headers || {}) }
      : (opts.headers || {}),
    ...opts,
  });
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  login: (password) => request('/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/api/logout', { method: 'POST' }),
  templates: () => request('/api/templates'),
  getSession: (id) => request('/api/sessions/' + encodeURIComponent(id)),
  patchDraft: (id, draft) => request('/api/drafts/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify(draft),
  }),
  finalize: (id, clientVersion) => request('/api/sessions/' + encodeURIComponent(id) + '/finalize', {
    method: 'POST',
    body: JSON.stringify({ client_version: clientVersion }),
  }),
};
