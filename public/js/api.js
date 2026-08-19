import {
  demoAdmin,
  demoContent,
  demoDigest,
  demoLeads,
  demoMatches,
  demoMember,
  demoNewsletterPreferences,
  demoProjects,
  demoSubscriptions,
} from './demo-data.js';

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

export function filterPublicSafeContent(items = [], now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  const comparisonTime = Number.isFinite(nowMs) ? nowMs : Date.now();
  return (Array.isArray(items) ? items : []).filter((item) => {
    const publishedAt = Date.parse(item?.publishedAt || '');
    return item?.status === 'published'
      && item?.publicSafe === true
      && item?.visibility === 'public'
      && Boolean(String(item?.riskDisclosure || item?.riskNotice || '').trim())
      && Number.isFinite(publishedAt)
      && publishedAt <= comparisonTime;
  });
}

export const LEAD_EXPORT_HEADERS = Object.freeze([
  'schemaVersion', 'id', 'displayName', 'phone', 'email', 'channel', 'sourceReference',
  'privacyEvidenceReference', 'privacyConsentedAt', 'privacyNoticeVersion', 'ownerReferrerId',
  'memberId', 'status', 'importedBy', 'importedAt', 'subscriptionCount',
  'attributableRequestedAmountTwd', 'attributableAllocatedAmountTwd',
]);

function csvExportCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safe = /^[\t ]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function demoLeadExportCsv(items = demoLeads) {
  const rows = items.map((item) => ({
    schemaVersion: 'DEMO-lead-export-v1',
    id: `DEMO-${item.id}`,
    displayName: item.displayName,
    phone: item.phone || '',
    email: item.email || '',
    channel: item.channel,
    sourceReference: item.sourceReference,
    privacyEvidenceReference: item.privacyEvidence?.reference || '',
    privacyConsentedAt: item.privacyEvidence?.consentedAt || '',
    privacyNoticeVersion: 'DEMO',
    ownerReferrerId: item.ownerReferrerId,
    memberId: item.memberId || '',
    status: item.status,
    importedBy: 'DEMO ONLY',
    importedAt: item.createdAt || '',
    subscriptionCount: 0,
    attributableRequestedAmountTwd: 0,
    attributableAllocatedAmountTwd: 0,
  }));
  return `\uFEFF${[LEAD_EXPORT_HEADERS, ...rows.map((row) => LEAD_EXPORT_HEADERS.map((field) => row[field]))].map((row) => row.map(csvExportCell).join(',')).join('\r\n')}`;
}

function unwrapApiData(value) {
  return value?.data ?? value ?? null;
}

function dtoList(value, keys = []) {
  const root = unwrapApiData(value);
  if (Array.isArray(root)) return root;
  for (const key of keys) {
    if (Array.isArray(root?.[key])) return root[key];
  }
  return [];
}

function normalizeDigestProgress(progress) {
  const items = Array.isArray(progress) ? progress : progress?.items || [];
  const source = Array.isArray(progress) ? progress.reduce((totals, item) => {
    const depositPaid = Number(item.depositPaidAmountTwd ?? item.receivedAmountTwd ?? item.receivedAmount ?? item.received ?? 0);
    const accountRecorded = Number(item.accountRecordedAmountTwd ?? Math.max(0, depositPaid - Number(item.refundedAmountTwd ?? item.refundedAmount ?? item.refunded ?? 0)));
    return {
      requestedAmountTwd: totals.requestedAmountTwd + Number(item.requestedAmountTwd ?? item.requestedAmount ?? item.requested ?? 0),
      approvedAmountTwd: totals.approvedAmountTwd + Number(item.approvedAmountTwd ?? item.approvedAmount ?? item.approved ?? 0),
      depositPaidAmountTwd: totals.depositPaidAmountTwd + depositPaid,
      accountRecordedAmountTwd: totals.accountRecordedAmountTwd + accountRecorded,
      allocatedAmountTwd: totals.allocatedAmountTwd + Number(item.allocatedAmountTwd ?? item.allocatedAmount ?? item.allocated ?? 0),
    };
  }, {
    requestedAmountTwd: 0,
    approvedAmountTwd: 0,
    depositPaidAmountTwd: 0,
    accountRecordedAmountTwd: 0,
    allocatedAmountTwd: 0,
  }) : progress || {};
  const depositPaidAmountTwd = Number(source.depositPaidAmountTwd ?? source.receivedAmountTwd ?? source.receivedAmount ?? source.received ?? 0);
  return {
    ...source,
    requestedAmountTwd: Number(source.requestedAmountTwd ?? source.requestedAmount ?? source.requested ?? 0),
    approvedAmountTwd: Number(source.approvedAmountTwd ?? source.approvedAmount ?? source.approved ?? 0),
    depositPaidAmountTwd,
    accountRecordedAmountTwd: Number(source.accountRecordedAmountTwd
      ?? Math.max(0, depositPaidAmountTwd - Number(source.refundedAmountTwd ?? source.refundedAmount ?? source.refunded ?? 0))),
    allocatedAmountTwd: Number(source.allocatedAmountTwd ?? source.allocatedAmount ?? source.allocated ?? 0),
    items,
  };
}

export function normalizeDigestDto(value) {
  const root = unwrapApiData(value);
  const raw = root?.digest ?? root;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    ...raw,
    date: raw.date || raw.digestDate || '',
    investmentProgress: normalizeDigestProgress(raw.investmentProgress || raw.fiveAmountProgress || raw.progress),
    contentItems: dtoList(raw, ['contentItems', 'content', 'newContent']),
    matchedProjects: dtoList(raw, ['matchedProjects', 'matches', 'projectMatches', 'recommendations']),
  };
}

export function normalizeNewsletterPreferencesDto(value) {
  const root = unwrapApiData(value) || {};
  const raw = root.preferences || root.preference || root;
  const channels = Array.isArray(raw.deliveryChannels)
    ? [...new Set(['in_app', ...raw.deliveryChannels.filter((item) => ['line', 'email'].includes(item))])]
    : ['in_app', ...(raw.deliveryChannels?.line ? ['line'] : []), ...(raw.deliveryChannels?.email ? ['email'] : [])];
  const availability = (key) => {
    const candidates = [raw[key], root[key], value?.[key]];
    return candidates.find((candidate) => typeof candidate === 'boolean');
  };
  return {
    ...raw,
    dailyDigestConsent: Boolean(raw.dailyDigestConsent),
    marketingConsent: Boolean(raw.marketingConsent),
    lineDeliveryConsent: Boolean(raw.lineDeliveryConsent ?? channels.includes('line')),
    emailDeliveryConsent: Boolean(raw.emailDeliveryConsent ?? channels.includes('email')),
    deliveryChannels: channels,
    lineAvailable: availability('lineAvailable'),
    emailAvailable: availability('emailAvailable'),
  };
}

function mergeDtoLists(primary, secondary) {
  const merged = new Map();
  [...primary, ...secondary].forEach((item, index) => {
    const key = item?.id || item?.projectId || item?.url || item?.title || `item-${index}`;
    if (!merged.has(key)) merged.set(key, item);
  });
  return [...merged.values()];
}

export function normalizeDailyExperienceDto({ digestResult, contentResult, matchResult, preferenceResult } = {}) {
  const digest = normalizeDigestDto(digestResult);
  return {
    digest,
    contentFeed: mergeDtoLists(
      dtoList(contentResult, ['content', 'contentItems', 'items']),
      digest?.contentItems || [],
    ),
    matches: mergeDtoLists(
      dtoList(matchResult, ['matches', 'matchedProjects', 'items']),
      digest?.matchedProjects || [],
    ),
    preferences: normalizeNewsletterPreferencesDto(preferenceResult),
  };
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
      return { role, subject: role === 'admin' ? { id: 'admin-static-demo', displayName: '引薦人 DEMO' } : structuredClone(demoMember) };
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

  adminLeads: () => withDemoFallback('admin leads', () => ({ leads: structuredClone(demoLeads) }))(
    () => request('/api/admin/leads'),
  ),

  createLead: (input) => request('/api/admin/leads', { method: 'POST', body: input }),

  importLeads: (input) => request('/api/admin/leads/import', { method: 'POST', body: input }),

  adminLeadExportCsv: () => withDemoFallback('lead CSV export', () => demoLeadExportCsv())(
    () => request('/api/admin/export/leads.csv'),
  ),

  updateLead: (id, input) => request(`/api/admin/leads/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input,
  }),

  adminMatches: () => withDemoFallback('admin matches', () => ({ matches: structuredClone(demoMatches) }))(
    () => request('/api/admin/matches'),
  ),

  adminContent: () => withDemoFallback('admin content', () => ({ content: structuredClone(demoContent) }))(
    () => request('/api/admin/content'),
  ),

  createContent: (input) => request('/api/admin/content', { method: 'POST', body: input }),

  updateContent: (id, input) => request(`/api/admin/content/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: input,
  }),

  newsletterPreview: () => withDemoFallback('newsletter preview', () => structuredClone(demoDigest))(
    () => request('/api/admin/newsletters/preview'),
  ),

  generateNewsletter: (input) => request('/api/admin/newsletters/generate', { method: 'POST', body: input }),

  newsletterPreferences: () => withDemoFallback('newsletter preferences', () => structuredClone(demoNewsletterPreferences))(
    () => request('/api/newsletter/preferences'),
  ),

  updateNewsletterPreferences: (input) => request('/api/newsletter/preferences', { method: 'PATCH', body: input }),

  digestToday: () => withDemoFallback('member digest', () => structuredClone(demoDigest))(
    () => request('/api/digest/today'),
  ),

  matches: () => withDemoFallback('member matches', () => ({ matches: structuredClone(demoMatches) }))(
    () => request('/api/matches'),
  ),

  contentFeed: () => withDemoFallback('member content feed', () => ({ content: structuredClone(demoContent.filter((item) => item.status === 'published')) }))(
    () => request('/api/content/feed'),
  ),

  publicContentFeed: () => withDemoFallback('public content feed', () => ({
    content: structuredClone(filterPublicSafeContent(demoContent)),
  }))(
    () => request('/api/content/public'),
  ),

  sendNotification: (input) => request('/api/admin/notifications', { method: 'POST', body: input }),

  deckToken: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/deck-token`, { method: 'POST' }),
};

export { request };
