import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

import {
  canUseDemoFallback,
  normalizeApiBaseUrl,
  request,
  resolveApiUrl,
  resolveAppUrl,
  resolveRuntimeMode,
  shouldRejectStaticWrite,
} from '../public/js/api.js';
import {
  activationSourceFromUrl,
  normalizeExternalHttpsUrl,
  qualificationExpiryIso,
  resolveAdminDashboardRoute,
} from '../public/js/common.js';
import { approvedProjectReports, protectedProjectContent } from '../public/js/project-content.js';
import {
  buildPages,
  normalizePublicApiBaseUrl,
  runtimeConfigSource,
} from '../scripts/build-pages.js';

test('public API base normalization accepts safe HTTP(S) origins and paths', () => {
  assert.equal(normalizePublicApiBaseUrl(' https://api.example.com/edge/ '), 'https://api.example.com/edge');
  assert.equal(normalizeApiBaseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(resolveApiUrl('/api/projects', 'https://api.example.com/edge/'), 'https://api.example.com/edge/api/projects');
  assert.equal(resolveApiUrl('/member.html', 'https://api.example.com'), '/member.html');
  assert.throws(() => normalizePublicApiBaseUrl('javascript:alert(1)'), /http or https/);
  assert.throws(() => normalizePublicApiBaseUrl('https://user:secret@api.example.com'), /credentials/);
  assert.throws(() => normalizePublicApiBaseUrl('https://api.example.com?token=secret'), /query string/);
});

test('runtime mode fails closed and Pages navigation keeps the repository base', () => {
  assert.equal(resolveRuntimeMode({ hostname: 'mela0976.github.io', apiBaseUrl: '' }), 'static-preview');
  assert.equal(resolveRuntimeMode({ hostname: 'mela0976.github.io', apiBaseUrl: 'https://api.example.com' }), 'live-api');
  assert.equal(resolveRuntimeMode({ hostname: 'mela0976.github.io', apiBaseUrl: 'not-a-url' }), 'invalid-config');
  assert.equal(resolveRuntimeMode({ hostname: 'localhost', apiBaseUrl: '' }), 'same-origin');
  assert.equal(canUseDemoFallback({ hostname: 'mela0976.github.io', apiBaseUrl: '' }), true);
  assert.equal(canUseDemoFallback({ hostname: 'localhost', apiBaseUrl: '' }), true);
  assert.equal(canUseDemoFallback({ hostname: 'mela0976.github.io', apiBaseUrl: 'https://api.example.com' }), false);
  assert.equal(canUseDemoFallback({ hostname: 'mela0976.github.io', apiBaseUrl: 'not-a-url' }), false);
  assert.equal(shouldRejectStaticWrite('static-preview', 'POST'), true);
  assert.equal(shouldRejectStaticWrite('static-preview', 'GET'), false);
  assert.equal(shouldRejectStaticWrite('live-api', 'PATCH'), false);
  assert.equal(
    resolveAppUrl('/member.html', { hostname: 'mela0976.github.io', pathname: '/zhifu-invest/admin.html' }),
    '/zhifu-invest/member.html',
  );
});

test('activation links normalize community source query parameters', () => {
  assert.deepEqual(
    activationSourceFromUrl('?sourceCode=SF-NORTH&sourceName=%E5%8C%97%E5%8D%80OpenChat'),
    { sourceCode: 'SF-NORTH', sourceName: '北區OpenChat' },
  );
  assert.deepEqual(
    activationSourceFromUrl('?sc=%20GROUP-7%00%20&openChat=%20%E9%9B%AA%E8%8A%AC%E5%A7%90%E7%A4%BE%E7%BE%A4%20'),
    { sourceCode: 'GROUP-7', sourceName: '雪芬姐社群' },
  );
});

test('formal admin routing redirects only to a credential-free HTTPS dashboard', () => {
  const url = 'https://script.google.com/macros/s/example/exec';
  assert.equal(normalizeExternalHttpsUrl(url), url);
  assert.deepEqual(resolveAdminDashboardRoute({ adminDashboardUrl: url }, true), { mode: 'redirect', url });
  assert.deepEqual(resolveAdminDashboardRoute({}, true), { mode: 'blocked', url: '' });
  assert.deepEqual(resolveAdminDashboardRoute({ adminDashboardUrl: url }, false), { mode: 'local', url: '' });
  assert.equal(normalizeExternalHttpsUrl('http://example.com/admin'), '');
  assert.equal(normalizeExternalHttpsUrl('https://user:secret@example.com/admin'), '');
});

test('approved qualification requires a future expiry date', () => {
  const now = Date.parse('2026-08-18T00:00:00+08:00');
  assert.equal(qualificationExpiryIso('2026-08-17', now), '');
  assert.equal(qualificationExpiryIso('', now), '');
  assert.equal(qualificationExpiryIso('2026-08-19', now), '2026-08-19T15:59:59.000Z');
});

test('protected project content exposes approved AI and expert report metadata only', () => {
  const project = {
    protected: {
      companyName: '測試生技股份有限公司',
      round: 'Series A',
      teamSummary: '藥物開發與商務團隊',
      useOfFunds: '["臨床驗證", "法規申請"]',
      financialSummary: '最近年度營收與現金水位摘要',
      reports: [
        { id: 'AI-1', type: 'ai', status: 'approved', version: '2.1', basisDate: '2026-07-31', reviewedBy: '王藥師' },
        { id: 'EX-1', reportType: 'expert', approved: true, versionNumber: 3, dataBasisDate: '2026-08-01', reviewer: '李博士' },
        { id: 'AI-DRAFT', type: 'ai', status: 'draft', version: 4 },
        { id: 'OTHER', type: 'marketing', status: 'approved', version: 1 },
      ],
    },
  };
  const content = protectedProjectContent(project);
  assert.equal(content.companyName, '測試生技股份有限公司');
  assert.deepEqual(content.useOfFunds, ['臨床驗證', '法規申請']);
  assert.deepEqual(approvedProjectReports(project), [
    { id: 'AI-1', type: 'ai', version: '2.1', basisDate: '2026-07-31', reviewedBy: '王藥師' },
    { id: 'EX-1', type: 'expert', version: 3, basisDate: '2026-08-01', reviewedBy: '李博士' },
  ]);
});

test('state mutations obtain an auth/me CSRF token and send credentialed requests', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/me') {
      return new Response(JSON.stringify({ data: { authenticated: false, csrfToken: 'csrf-from-session' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ data: { accepted: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await request('/api/bookings', { method: 'POST', body: { topic: '測試' } });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/auth/me');
  assert.equal(calls[1].url, '/api/bookings');
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.headers.get('X-CSRF-Token'), 'csrf-from-session');
});

test('runtime config contains only the normalized public API setting', () => {
  const source = runtimeConfigSource('https://api.example.com/edge/');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  assert.equal(JSON.stringify(context.window.__ZHIFU_CONFIG__), JSON.stringify({ API_BASE_URL: 'https://api.example.com/edge' }));
  assert.equal(Object.isFrozen(context.window.__ZHIFU_CONFIG__), true);
  assert.doesNotMatch(source, /SECRET|TOKEN|PASSWORD|LINE_/i);
});

test('Pages build injects runtime config before every module and rewrites API links for live mode', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'zhifu-pages-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = pathToFileURL(`${directory}/`);
  const secretMarker = 'must-never-appear-in-pages-output';

  await buildPages({
    output,
    repository: 'zhifu-invest',
    publicApiBaseUrl: 'https://api.example.com/edge/',
    ignoredSecret: secretMarker,
  });

  const runtimeConfig = await readFile(join(directory, 'runtime-config.js'), 'utf8');
  assert.match(runtimeConfig, /"API_BASE_URL":"https:\/\/api\.example\.com\/edge"/);
  assert.doesNotMatch(runtimeConfig, new RegExp(secretMarker));
  assert.doesNotMatch(runtimeConfig, /SECRET|PASSWORD|ACCESS_TOKEN|CHANNEL_SECRET/i);

  const htmlFiles = (await readdir(directory)).filter((name) => name.endsWith('.html'));
  assert.ok(htmlFiles.length >= 7);
  for (const name of htmlFiles) {
    const html = await readFile(join(directory, name), 'utf8');
    const modules = [...html.matchAll(/<script\b(?=[^>]*\btype=["']module["'])[^>]*>/g)];
    const injectedPairs = [...html.matchAll(/<script src="\/zhifu-invest\/runtime-config\.js"><\/script>\s*<script\b(?=[^>]*\btype=["']module["'])[^>]*>/g)];
    assert.equal(injectedPairs.length, modules.length, `${name} must load runtime config before every module`);
  }

  const admin = await readFile(join(directory, 'admin.html'), 'utf8');
  assert.match(admin, /href="https:\/\/api\.example\.com\/edge\/api\/admin\/export\/subscriptions\.csv"/);
  assert.match(admin, /href="https:\/\/api\.example\.com\/edge\/api\/admin\/export\/referrers\.csv"/);
  assert.match(admin, /href="https:\/\/api\.example\.com\/edge\/api\/admin\/export\/commissions\.csv"/);
  assert.doesNotMatch(admin, /href="\/zhifu-invest\/api\//);

  const index = await readFile(join(directory, 'index.html'), 'utf8');
  assert.match(index, /power by 奇華智能投資顧問股份有限公司/);
  assert.doesNotMatch(index, /奇華智能投資顧問股份有限公司（名稱待核）/);
});
