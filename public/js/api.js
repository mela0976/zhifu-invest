import { demoAdmin, demoMember, demoProjects, demoSubscriptions } from './demo-data.js';

const browserWindow = typeof window === 'undefined' ? null : window;
const currentLocation = browserWindow?.location || { hostname: '', pathname: '/' };

export function normalizeApiBaseUrl(value = '') {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return url.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function resolveRuntimeMode({ hostname = '', apiBaseUrl = '' } = {}) {
  if (String(apiBaseUrl || '').trim()) return normalizeApiBaseUrl(apiBaseUrl) ? 'live-api' : 'invalid-config';
  if (String(hostname).toLowerCase().endsWith('.github.io')) return 'static-preview';
  return 'same-origin';
}

export function canUseDemoFallback({ hostname = '', apiBaseUrl = '' } = {}) {
  const mode = resolveRuntimeMode({ hostname, apiBaseUrl });
  const local = ['localhost', '127.0.0.1', '0.0.0.0'].includes(String(hostname).toLowerCase());
  return mode === 'static-preview' || (mode === 'same-origin' && local);
}

export function resolveApiUrl(path, apiBaseUrl = configuredApiBaseUrl) {
  const value = String(path || '');
  if (!value.startsWith('/api/')) return value;
  const base = normalizeApiBaseUrl(apiBaseUrl);
  return base ? `${base}${value}` : value;
}

const rawApiBaseUrl = browserWindow?.__ZHIFU_CONFIG__?.API_BASE_URL || '';
const configuredApiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl);
const runtimeMode = resolveRuntimeMode({ hostname: currentLocation.hostname, apiBaseUrl: rawApiBaseUrl });
const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(currentLocation.hostname);
const isStaticPreview = runtimeMode === 'static-preview';
const allowDemoFallback = canUseDemoFallback({ hostname: currentLocation.hostname, apiBaseUrl: rawApiBaseUrl });
let detectedDemoMode = isLocalHost || isStaticPreview;
let csrfToken = '';

function sessionStorageSafe() {
  try { return browserWindow?.sessionStorage || null; }
  catch { return null; }
}

const csrfStorageKey = `zhifu_csrf:${configuredApiBaseUrl || 'same-origin'}`;

function extractCsrfToken(payload) {
  return payload?.csrfToken
    || payload?.csrf_token
    || payload?.data?.csrfToken
    || payload?.data?.csrf_token
    || '';
}

function rememberCsrfToken(payload) {
  const token = extractCsrfToken(payload);
  if (!token || typeof token !== 'string') return;
  csrfToken = token;
  sessionStorageSafe()?.setItem(csrfStorageKey, token);
}

function clearCsrfToken() {
  csrfToken = '';
  sessionStorageSafe()?.removeItem(csrfStorageKey);
}

function storedCsrfToken() {
  if (csrfToken) return csrfToken;
  csrfToken = sessionStorageSafe()?.getItem(csrfStorageKey) || '';
  return csrfToken;
}

function isMutation(method = 'GET') {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase());
}

export function shouldRejectStaticWrite(mode, method = 'GET') {
  return mode === 'static-preview' && isMutation(method);
}

function staticWriteError() {
  const error = new Error('GitHub Pages 是唯讀預覽，不會儲存或送出資料；請使用本機 Docker Demo。');
  error.status = 503;
  return error;
}

function staticActor() {
  try { return JSON.parse(sessionStorageSafe()?.getItem('zhifu_static_actor') || 'null'); }
  catch { return null; }
}

export function resolveAppUrl(path = '/', location = currentLocation) {
  if (!String(location.hostname || '').endsWith('.github.io')) return path;
  const repository = String(location.pathname || '/').split('/').filter(Boolean)[0] || '';
  const suffix = String(path).replace(/^\//, '');
  return `/${repository}/${suffix}`;
}

export function appUrl(path = '/') {
  return resolveAppUrl(path, currentLocation);
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
  return payload;
}

async function ensureCsrfToken() {
  const existing = storedCsrfToken();
  if (existing) return existing;
  try {
    const session = await request('/api/auth/me', { _skipCsrf: true });
    rememberCsrfToken(session);
  } catch (error) {
    if (![401, 403].includes(error.status)) console.info(`CSRF token 暫時無法取得：${error.message}`);
  }
  return storedCsrfToken();
}

async function request(path, options = {}) {
  const { _skipCsrf = false, ...fetchOptions } = options;
  if (shouldRejectStaticWrite(runtimeMode, fetchOptions.method)) throw staticWriteError();
  const headers = new Headers(fetchOptions.headers || {});
  if (fetchOptions.body && !(fetchOptions.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (!_skipCsrf && String(path).startsWith('/api/') && isMutation(fetchOptions.method)) {
    const token = await ensureCsrfToken();
    if (token && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
  }

  const response = await fetch(resolveApiUrl(path), {
    credentials: 'include',
    ...fetchOptions,
    headers,
    body: fetchOptions.body && !(fetchOptions.body instanceof FormData) && typeof fetchOptions.body !== 'string'
      ? JSON.stringify(fetchOptions.body)
      : fetchOptions.body,
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `請求失敗（${response.status}）`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  if (String(path).startsWith('/api/auth/me')) rememberCsrfToken(payload);
  return unwrap(payload);
}

function withDemoFallback(label, fallbackFactory) {
  return async (operation) => {
    try {
      const data = await operation();
      return { data, source: detectedDemoMode ? 'demo-api' : 'api', error: null };
    } catch (error) {
      if (!allowDemoFallback) throw error;
      console.info(`[Demo fallback] ${label}: ${error.message}`);
      return { data: fallbackFactory(), source: 'demo-fallback', error };
    }
  };
}

export const api = {
  async detectConfig() {
    try {
      const config = await request('/api/config');
      detectedDemoMode = Boolean(config?.demoMode ?? config?.mode === 'demo' ?? isLocalHost);
      return {
        ...config,
        staticPreview: false,
        apiBaseUrl: configuredApiBaseUrl,
        lineLoginUrl: resolveApiUrl(config?.lineLoginUrl || '/api/auth/line'),
      };
    } catch (error) {
      if (!isLocalHost && !isStaticPreview) throw error;
      return {
        demoMode: true,
        staticPreview: isStaticPreview,
        lineConfigured: false,
        projectName: '致富投資',
        apiBaseUrl: '',
        lineLoginUrl: resolveApiUrl('/api/auth/line'),
      };
    }
  },

  isDemo() {
    return detectedDemoMode;
  },

  isStaticPreview() {
    return isStaticPreview;
  },

  hasLiveApi() {
    return runtimeMode === 'live-api';
  },

  apiUrl(path) {
    return resolveApiUrl(path);
  },

  projects: () => withDemoFallback('projects', () => structuredClone(demoProjects))(
    () => request('/api/projects'),
  ),

  project: (id) => withDemoFallback('project', () => structuredClone(demoProjects.find((item) => item.id === id) || demoProjects[0]))(
    () => request(`/api/projects/${encodeURIComponent(id)}`),
  ),

  me: () => withDemoFallback('session', () => {
    const actor = staticActor();
    if (isStaticPreview && !actor) return { authenticated: false, role: 'visitor', member: null };
    return { authenticated: true, user: structuredClone(demoMember), role: actor?.role || 'member', member: structuredClone(demoMember) };
  })(
    () => request('/api/auth/me'),
  ),

  demoLogin: async (role, memberId) => {
    if (isStaticPreview) {
      sessionStorageSafe()?.setItem('zhifu_static_actor', JSON.stringify({ role, memberId: memberId || null }));
      return { role, subject: role === 'admin' ? { id: 'admin-static-demo', displayName: '雪芬姐 DEMO' } : structuredClone(demoMember) };
    }
    const session = await request('/api/auth/demo', { method: 'POST', body: { role, ...(memberId ? { memberId } : {}) } });
    clearCsrfToken();
    return session;
  },

  logout: async () => {
    if (isStaticPreview) {
      sessionStorageSafe()?.removeItem('zhifu_static_actor');
      clearCsrfToken();
      return { ok: true };
    }
    try { return await request('/api/auth/logout', { method: 'POST' }); }
    finally { clearCsrfToken(); }
  },

  activate: (input) => isStaticPreview
    ? Promise.reject(staticWriteError())
    : request('/api/activation', { method: 'POST', body: input }),

  bookings: () => request('/api/bookings'),
  createBooking: (input) => isStaticPreview
    ? Promise.reject(staticWriteError())
    : request('/api/bookings', { method: 'POST', body: input }),

  subscriptions: () => withDemoFallback('subscriptions', () => structuredClone(demoSubscriptions))(
    () => request('/api/subscriptions'),
  ),

  createSubscription: (input, idempotencyKey = crypto.randomUUID()) => isStaticPreview
    ? Promise.reject(staticWriteError())
    : request('/api/subscriptions', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: input,
    }),

  dashboard: () => withDemoFallback('member dashboard', () => ({
    member: structuredClone(demoMember),
    projects: structuredClone(demoProjects),
    subscriptions: structuredClone(demoSubscriptions),
  }))(
    async () => {
      const [session, projects, subscriptions] = await Promise.all([
        request('/api/auth/me'),
        request('/api/projects'),
        request('/api/subscriptions'),
      ]);
      if (session?.authenticated === false) {
        const error = new Error('請先完成 LINE 會員登入');
        error.status = 401;
        throw error;
      }
      return { member: session?.member || session?.user || session, projects, subscriptions };
    },
  ),

  adminDashboard: () => withDemoFallback('admin dashboard', () => structuredClone(demoAdmin))(
    async () => {
      try {
        return await request('/api/admin/dashboard');
      } catch (error) {
        if (error.status !== 404) throw error;
        const [overview, members, subscriptions, referrers, commissions, actions] = await Promise.all([
          request('/api/admin/overview'),
          request('/api/admin/members'),
          request('/api/admin/subscriptions'),
          request('/api/admin/referrers').catch(() => []),
          request('/api/admin/commissions').catch(() => []),
          request('/api/admin/actions'),
        ]);
        return { ...overview, members, subscriptions, referrers, commissions, actions };
      }
    },
  ),

  updateMember: (id, input) => request(`/api/admin/members/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input,
  }),

  updateSubscription: (id, input) => request(`/api/admin/subscriptions/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input,
  }),

  referrers: () => withDemoFallback('referrers', () => structuredClone(demoAdmin.referrers || []))(
    () => request('/api/admin/referrers'),
  ),

  createReferrer: (input) => request('/api/admin/referrers', { method: 'POST', body: input }),

  updateReferrer: (id, input) => request(`/api/admin/referrers/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input,
  }),

  commissions: () => withDemoFallback('commissions', () => structuredClone(demoAdmin.commissions || []))(
    () => request('/api/admin/commissions'),
  ),

  updateCommission: (subscriptionId, input) => request(`/api/admin/commissions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH', body: input,
  }),

  sendNotification: (input) => request('/api/admin/notifications', { method: 'POST', body: input }),

  deckToken: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/deck-token`, { method: 'POST' }),
};

export { request };
