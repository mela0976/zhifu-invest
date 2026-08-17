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
  assert.doesNotMatch(admin, /href="\/zhifu-invest\/api\//);
});
