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
  getStatistics: (range) => request(`/api/statistics?range=${encodeURIComponent(range)}`),

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
  getMonitorStatus: (id) => request(`/api/monitors/${id}/status`),
  getMonitorStatistics: (id, range) =>
    request(`/api/monitors/${id}/statistics?range=${encodeURIComponent(range)}`),
  getServiceMaintenance: (id, limit = 50) =>
    request(`/api/services/${id}/maintenance?limit=${limit}`),

  listNotifications: () => request('/api/notifications'),
  createNotification: (data) => request('/api/notifications', { method: 'POST', body: data }),
  updateNotification: (id, data) => request(`/api/notifications/${id}`, { method: 'PUT', body: data }),
  deleteNotification: (id) => request(`/api/notifications/${id}`, { method: 'DELETE' }),
  testNotification: (id) => request(`/api/notifications/${id}/test`, { method: 'POST' }),

  listStatusPages: () => request('/api/status-pages'),
  createStatusPage: (data) => request('/api/status-pages', { method: 'POST', body: data }),
  updateStatusPage: (id, data) => request(`/api/status-pages/${id}`, { method: 'PUT', body: data }),
  deleteStatusPage: (id) => request(`/api/status-pages/${id}`, { method: 'DELETE' }),

  listApiKeys: () => request('/api/api-keys'),
  createApiKey: (name) => request('/api/api-keys', { method: 'POST', body: { name } }),
  toggleApiKey: (id, enabled) => request(`/api/api-keys/${id}`, { method: 'PATCH', body: { enabled } }),
  deleteApiKey: (id) => request(`/api/api-keys/${id}`, { method: 'DELETE' }),

  listMaintenance: (limit = 100) => request(`/api/maintenance?limit=${limit}`),
  startMaintenance: (serviceId, until, reason) =>
    request('/api/maintenance', { method: 'POST', body: { service_id: serviceId, until, reason } }),
  endMaintenance: (id) => request(`/api/maintenance/${id}/end`, { method: 'POST' }),
};
