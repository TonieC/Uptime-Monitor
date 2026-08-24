'use strict';

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError('Could not reach the server', 0, 'network');
  }

  if (res.status === 401) {
    throw new ApiError('Authentication required', 401, 'unauthorized');
  }
  if (res.status === 204) return null;

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const message =
      body && body.error && body.error.message
        ? body.error.message
        : `Request failed with status ${res.status}`;
    throw new ApiError(message, res.status, body && body.error && body.error.code);
  }
  return body;
}

const API = {
  getSession: () => request('/api/session'),
  getSummary: () => request('/api/summary'),
  listServices: () => request('/api/services'),
  getService: (id) => request(`/api/services/${id}`),
  createService: (data) => request('/api/services', { method: 'POST', body: data }),
  updateService: (id, data) => request(`/api/services/${id}`, { method: 'PUT', body: data }),
  deleteService: (id) => request(`/api/services/${id}`, { method: 'DELETE' }),
  checkNow: (id) => request(`/api/services/${id}/check`, { method: 'POST' }),
  getUptime: (id, range) => request(`/api/services/${id}/uptime?range=${encodeURIComponent(range)}`),
  getChecks: (id, limit = 50, before) =>
    request(`/api/services/${id}/checks?limit=${limit}${before ? `&before=${before}` : ''}`),
  getServiceIncidents: (id, limit = 100) =>
    request(`/api/services/${id}/incidents?limit=${limit}`),
  getIncidents: (limit = 100) => request(`/api/incidents?limit=${limit}`),
};
