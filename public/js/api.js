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
  reorderRoutines: (ids) => request('/api/routines/order', {
    method: 'PUT',
    body: JSON.stringify({ ids }),
  }),
  patchWorkout: (id, body) => request('/api/workouts/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  finalizeWorkout: (id, clientVersion) => request('/api/workouts/' + encodeURIComponent(id) + '/finalize', {
    method: 'POST',
    body: JSON.stringify({ client_version: clientVersion }),
  }),
  getWorkout: (id) => request('/api/workouts/' + encodeURIComponent(id)),
  listSessions: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    return request('/api/sessions' + (s ? '?' + s : ''));
  },
  listWorkouts: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const s = qs.toString();
    return request('/api/workouts' + (s ? '?' + s : ''));
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
  deleteSession: (id) => request('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }),
  deleteWorkout: (id) => request('/api/workouts/' + encodeURIComponent(id), { method: 'DELETE' }),
};
