import { demoAdmin, demoMember, demoProjects, demoSubscriptions } from './demo-data.js';

const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
const isStaticPreview = window.location.hostname.endsWith('.github.io');
let detectedDemoMode = isLocalHost || isStaticPreview;

function staticWriteError() {
  const error = new Error('GitHub Pages 是唯讀預覽，不會儲存或送出資料；請使用本機 Docker Demo。');
  error.status = 503;
  return error;
}

function staticActor() {
  try { return JSON.parse(sessionStorage.getItem('zhifu_static_actor') || 'null'); }
  catch { return null; }
}

export function appUrl(path = '/') {
  if (!isStaticPreview) return path;
  const repository = window.location.pathname.split('/').filter(Boolean)[0] || '';
  const suffix = String(path).replace(/^\//, '');
  return `/${repository}/${suffix}`;
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
  return payload;
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers,
    body: options.body && !(options.body instanceof FormData) && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body,
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `請求失敗（${response.status}）`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return unwrap(payload);
}

function withDemoFallback(label, fallbackFactory) {
  return async (operation) => {
    try {
      const data = await operation();
      return { data, source: detectedDemoMode ? 'demo-api' : 'api', error: null };
    } catch (error) {
      if (!detectedDemoMode) throw error;
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
      return config;
    } catch (error) {
      if (!isLocalHost && !isStaticPreview) throw error;
      return { demoMode: true, staticPreview: isStaticPreview, lineConfigured: false, projectName: '致富投資' };
    }
  },

  isDemo() {
    return detectedDemoMode;
  },

  isStaticPreview() {
    return isStaticPreview;
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
      sessionStorage.setItem('zhifu_static_actor', JSON.stringify({ role, memberId: memberId || null }));
      return { role, subject: role === 'admin' ? { id: 'admin-static-demo', displayName: '雪芬姐 DEMO' } : structuredClone(demoMember) };
    }
    return request('/api/auth/demo', { method: 'POST', body: { role, ...(memberId ? { memberId } : {}) } });
  },

  logout: async () => {
    if (isStaticPreview) { sessionStorage.removeItem('zhifu_static_actor'); return { ok: true }; }
    return request('/api/auth/logout', { method: 'POST' });
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
        const [overview, members, subscriptions, actions] = await Promise.all([
          request('/api/admin/overview'),
          request('/api/admin/members'),
          request('/api/admin/subscriptions'),
          request('/api/admin/actions'),
        ]);
        return { ...overview, members, subscriptions, actions };
      }
    },
  ),

  updateMember: (id, input) => request(`/api/admin/members/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input,
  }),

  updateSubscription: (id, input) => request(`/api/admin/subscriptions/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input,
  }),

  sendNotification: (input) => request('/api/admin/notifications', { method: 'POST', body: input }),

  deckToken: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/deck-token`, { method: 'POST' }),
};

export { request };
