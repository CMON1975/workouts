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
  templates: ({ includeArchived = false } = {}) =>
    request('/api/templates' + (includeArchived ? '?include_archived=true' : '')),
  createTemplate: (body) => request('/api/templates', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  updateTemplate: (id, body) => request('/api/templates/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  lastTemplateSession: (id) =>
    request('/api/templates/' + encodeURIComponent(id) + '/last-session'),
  routines: ({ includeArchived = false } = {}) =>
    request('/api/routines' + (includeArchived ? '?include_archived=true' : '')),
  routine: (id) => request('/api/routines/' + encodeURIComponent(id)),
  createRoutine: (body) => request('/api/routines', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  updateRoutine: (id, body) => request('/api/routines/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  listSessions: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    return request('/api/sessions' + (s ? '?' + s : ''));
  },
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
