import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createSignedEnvelope } from '../src/apps-script';
import { hmacSha256Base64, sha256Hex, timingSafeBase64Equal } from '../src/crypto';
import { SESSION_COOKIE } from '../src/db';

const allowedOrigin = 'https://mela0976.github.io';

async function invoke(path: string, init: RequestInit = {}) {
  const request = new Request(`https://gateway.example${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  return { response, ctx };
}

async function insertSession(rawToken: string, lineUserId: string) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO sessions (
       id, line_user_id, member_id, display_name, role, friendship_status,
       csrf_token, created_at, expires_at, last_seen_at
     ) VALUES (?1, ?2, ?3, ?4, 'member', 'friend', ?5, ?6, ?7, ?6)`,
  ).bind(
    await sha256Hex(rawToken),
    lineUserId,
    `member-${lineUserId}`,
    `Member ${lineUserId}`,
    `csrf-${lineUserId}`,
    now,
    now + 3600,
  ).run();
}

async function insertAdminSession(rawToken: string) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO sessions (
       id, line_user_id, member_id, display_name, role, friendship_status,
       csrf_token, created_at, expires_at, last_seen_at
     ) VALUES (?1, 'google:admin-1', 'admin-1', 'Admin', 'admin', 'unknown',
       'csrf-admin', ?2, ?3, ?2)`,
  ).bind(await sha256Hex(rawToken), now, now + 3600).run();
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function stubAppsScriptSequence(replies: Array<Record<string, unknown>>) {
  let calls = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.toString() !== env.APPS_SCRIPT_URL) throw new Error(`Unexpected outbound request: ${url}`);
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    return Response.json(reply);
  });
  return () => calls;
}

async function runScheduledMaintenance() {
  const controller = createScheduledController({
    scheduledTime: new Date(),
    cron: '*/5 * * * *',
  });
  const ctx = createExecutionContext();
  await worker.scheduled(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM deck_tokens'),
    env.DB.prepare('DELETE FROM oauth_states'),
    env.DB.prepare('DELETE FROM webhook_events'),
    env.DB.prepare('DELETE FROM sessions'),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cloudflare gateway integration', () => {
  it('persists LINE OAuth state and nonce before redirecting', async () => {
    const { response, ctx } = await invoke('/api/auth/line');
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('location')!);
    expect(redirect.origin).toBe('https://access.line.me');
    expect(redirect.searchParams.get('nonce')).toBeTruthy();
    const state = redirect.searchParams.get('state')!;
    const saved = await env.DB.prepare(
      'SELECT nonce, consumed_at FROM oauth_states WHERE state_hash = ?1',
    ).bind(await sha256Hex(state)).first<{ nonce: string; consumed_at: number | null }>();
    expect(saved?.nonce).toBe(redirect.searchParams.get('nonce'));
    expect(saved?.consumed_at).toBeNull();

    const invalid = await invoke('/api/auth/line/callback?state=wrong&code=unused');
    expect(invalid.response.status).toBe(400);
    await expect(invalid.response.json()).resolves.toMatchObject({ error: { code: 'invalid_oauth_state' } });
  });

  it('rejects CORS and CSRF requests from an untrusted origin', async () => {
    const { response } = await invoke('/api/subscriptions', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'origin_not_allowed' } });
  });

  it('verifies the raw LINE webhook signature and deduplicates accepted events', async () => {
    const calls = stubAppsScriptSequence([{ ok: true, data: { accepted: true } }]);
    const body = JSON.stringify({ destination: 'bot', events: [{ webhookEventId: 'event-001', type: 'message' }] });
    const rejected = await invoke('/api/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': 'invalid' },
      body,
    });
    expect(rejected.response.status).toBe(401);

    const signature = await hmacSha256Base64(env.LINE_MESSAGING_CHANNEL_SECRET, new TextEncoder().encode(body).buffer);
    const accepted = await invoke('/api/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': signature },
      body,
    });
    expect(accepted.response.status).toBe(200);
    await waitOnExecutionContext(accepted.ctx);
    const stored = await env.DB.prepare(
      'SELECT webhook_event_id, attempts, status FROM webhook_events WHERE webhook_event_id = ?1',
    ).bind('event-001').first<{ webhook_event_id: string; attempts: number; status: string }>();
    expect(stored?.webhook_event_id).toBe('event-001');
    expect(stored?.attempts).toBe(1);
    expect(stored?.status).toBe('delivered');

    const duplicate = await invoke('/api/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': signature },
      body,
    });
    expect(duplicate.response.status).toBe(200);
    await waitOnExecutionContext(duplicate.ctx);
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM webhook_events WHERE webhook_event_id = ?1',
    ).bind('event-001').first<{ count: number }>();
    expect(count?.count).toBe(1);
    expect(calls()).toBe(1);
  });

  it('retries a failed webhook from D1 and never forwards a delivered duplicate', async () => {
    const calls = stubAppsScriptSequence([
      { ok: false, error: { code: 'apps_script_unavailable', message: 'temporary outage' } },
      { ok: true, data: { accepted: true } },
    ]);
    const body = JSON.stringify({
      destination: 'bot',
      events: [{
        webhookEventId: 'event-retry',
        type: 'message',
        source: { type: 'user', userId: 'line-1' },
        message: { id: 'message-1', type: 'text', text: 'hello' },
      }],
    });
    const signature = await hmacSha256Base64(
      env.LINE_MESSAGING_CHANNEL_SECRET,
      new TextEncoder().encode(body).buffer,
    );
    const first = await invoke('/api/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': signature },
      body,
    });
    expect(first.response.status).toBe(200);
    await waitOnExecutionContext(first.ctx);

    const queued = await env.DB.prepare(
      `SELECT attempts, status, payload_json, next_attempt_at
         FROM webhook_events WHERE webhook_event_id = 'event-retry'`,
    ).first<{ attempts: number; status: string; payload_json: string; next_attempt_at: number }>();
    expect(queued).toMatchObject({ attempts: 1, status: 'retry' });
    expect(JSON.parse(queued!.payload_json)).toMatchObject({
      webhookEventId: 'event-retry',
      source: { userId: 'line-1' },
    });
    expect(JSON.parse(queued!.payload_json)).not.toHaveProperty('message');
    expect(queued!.next_attempt_at).toBeGreaterThan(Date.now());

    await env.DB.prepare(
      `UPDATE webhook_events SET next_attempt_at = 0 WHERE webhook_event_id = 'event-retry'`,
    ).run();
    await runScheduledMaintenance();
    const delivered = await env.DB.prepare(
      `SELECT attempts, status, forwarded_at
         FROM webhook_events WHERE webhook_event_id = 'event-retry'`,
    ).first<{ attempts: number; status: string; forwarded_at: number | null }>();
    expect(delivered).toMatchObject({ attempts: 2, status: 'delivered' });
    expect(delivered!.forwarded_at).toBeTypeOf('number');

    const duplicate = await invoke('/api/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': signature },
      body,
    });
    await waitOnExecutionContext(duplicate.ctx);
    expect(calls()).toBe(2);
  });

  it('stops webhook retries after three attempts and cleans old terminal rows', async () => {
    const calls = stubAppsScriptSequence([
      { ok: false, error: { code: 'apps_script_unavailable', message: 'still unavailable' } },
    ]);
    const body = JSON.stringify({ events: [{ webhookEventId: 'event-exhausted', type: 'follow' }] });
    const signature = await hmacSha256Base64(
      env.LINE_MESSAGING_CHANNEL_SECRET,
      new TextEncoder().encode(body).buffer,
    );
    const accepted = await invoke('/api/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': signature },
      body,
    });
    await waitOnExecutionContext(accepted.ctx);

    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await env.DB.prepare(
        `UPDATE webhook_events SET next_attempt_at = 0 WHERE webhook_event_id = 'event-exhausted'`,
      ).run();
      await runScheduledMaintenance();
    }
    await runScheduledMaintenance();
    const exhausted = await env.DB.prepare(
      `SELECT attempts, status, next_attempt_at
         FROM webhook_events WHERE webhook_event_id = 'event-exhausted'`,
    ).first<{ attempts: number; status: string; next_attempt_at: number | null }>();
    expect(exhausted).toMatchObject({ attempts: 3, status: 'failed', next_attempt_at: null });
    expect(calls()).toBe(3);

    await env.DB.prepare(
      `UPDATE webhook_events SET received_at = ?1 WHERE webhook_event_id = 'event-exhausted'`,
    ).bind(Date.now() - 31 * 24 * 60 * 60 * 1000).run();
    await runScheduledMaintenance();
    const removed = await env.DB.prepare(
      `SELECT webhook_event_id FROM webhook_events WHERE webhook_event_id = 'event-exhausted'`,
    ).first();
    expect(removed).toBeNull();
  });

  it('fails LINE login closed when Apps Script cannot resolve a member', async () => {
    const started = await invoke('/api/auth/line');
    const redirect = new URL(started.response.headers.get('location')!);
    const state = redirect.searchParams.get('state')!;
    const nonce = redirect.searchParams.get('nonce')!;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === '/oauth2/v2.1/token') {
        return Response.json({
          access_token: 'access-token', expires_in: 3600, id_token: 'id-token', token_type: 'Bearer',
        });
      }
      if (url.pathname === '/oauth2/v2.1/verify') {
        return Response.json({
          iss: 'https://access.line.me', sub: 'line-unresolved', aud: env.LINE_LOGIN_CHANNEL_ID,
          exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), nonce,
        });
      }
      if (url.pathname === '/friendship/v1/status') return Response.json({ friendFlag: true });
      if (url.toString() === env.APPS_SCRIPT_URL) {
        return Response.json({
          ok: false,
          error: { code: 'apps_script_unavailable', message: 'Operations backend is unavailable' },
        });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });

    const callback = await invoke(`/api/auth/line/callback?state=${encodeURIComponent(state)}&code=code`);
    expect(callback.response.status).toBe(502);
    await expect(callback.response.json()).resolves.toMatchObject({
      error: { code: 'apps_script_unavailable' },
    });
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions').first<{ count: number }>();
    expect(sessions?.count).toBe(0);
  });

  it('invalidates legacy null-member sessions before member routes', async () => {
    const rawSession = 'unlinked-session';
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO sessions (
         id, line_user_id, member_id, display_name, role, friendship_status,
         csrf_token, created_at, expires_at, last_seen_at
       ) VALUES (?1, 'line-unlinked', NULL, 'Unlinked', 'member', 'unknown',
         'csrf-unlinked', ?2, ?3, ?2)`,
    ).bind(await sha256Hex(rawSession), now, now + 3600).run();
    const result = await invoke('/api/subscriptions', {
      headers: { cookie: `${SESSION_COOKIE}=${rawSession}` },
    });
    expect(result.response.status).toBe(401);
    const remaining = await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions').first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it('maps Apps Script errors and returns admin exports as real CSV', async () => {
    const rawSession = 'admin-session';
    await insertAdminSession(rawSession);
    stubAppsScriptSequence([
      { ok: true, data: { filename: 'members.csv', mimeType: 'text/csv', csv: 'id,name\n1,Ada' } },
      { ok: false, error: { code: 'not_found', message: 'Project not found' } },
    ]);
    const csv = await invoke('/api/admin/export/members.csv', {
      headers: { cookie: `${SESSION_COOKIE}=${rawSession}` },
    });
    expect(csv.response.status).toBe(200);
    expect(csv.response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.response.headers.get('content-disposition')).toContain("filename*=UTF-8''members.csv");
    expect(await csv.response.text()).toBe('id,name\n1,Ada');

    const missing = await invoke('/api/projects/missing');
    expect(missing.response.status).toBe(404);
    await expect(missing.response.json()).resolves.toMatchObject({ error: { code: 'not_found' } });
  });

  it('binds a five-minute deck token to the issuing session and streams from R2', async () => {
    const sessionA = 'raw-session-a';
    const sessionB = 'raw-session-b';
    await insertSession(sessionA, 'line-a');
    await insertSession(sessionB, 'line-b');
    await env.DECKS.put('protected/project-a.pdf', new TextEncoder().encode('private deck'), {
      httpMetadata: { contentType: 'application/pdf' },
    });
    const rawDeckToken = 'one-session-only-token';
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO deck_tokens (
         token_hash, session_id, project_id, object_key, filename, content_type, created_at, expires_at
       ) VALUES (?1, ?2, 'project-a', 'protected/project-a.pdf', 'project-a.pdf', 'application/pdf', ?3, ?4)`,
    ).bind(await sha256Hex(rawDeckToken), await sha256Hex(sessionA), now, now + 300).run();

    const wrongSession = await invoke(`/api/decks/${rawDeckToken}`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionB}` },
    });
    expect(wrongSession.response.status).toBe(403);

    const rightSession = await invoke(`/api/decks/${rawDeckToken}`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionA}` },
    });
    expect(rightSession.response.status).toBe(200);
    expect(rightSession.response.headers.get('content-type')).toBe('application/pdf');
    expect(rightSession.response.headers.get('content-disposition')).toContain('inline');
    expect(new TextDecoder().decode(await rightSession.response.arrayBuffer())).toBe('private deck');
    await waitOnExecutionContext(rightSession.ctx);

    const expiry = await env.DB.prepare(
      'SELECT expires_at - created_at AS ttl FROM deck_tokens WHERE token_hash = ?1',
    ).bind(await sha256Hex(rawDeckToken)).first<{ ttl: number }>();
    expect(expiry?.ttl).toBe(300);
  });

  it('returns credentialed CORS headers only to an allowed origin', async () => {
    const { response } = await invoke('/api/auth/me', { headers: { origin: allowedOrigin } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('exposes no admin redirect until the Apps Script dashboard URL is configured', async () => {
    const { response } = await invoke('/api/config');
    await expect(response.json()).resolves.toMatchObject({
      data: { adminDashboardUrl: null },
    });
  });

  it('signs the exact Apps Script canonical envelope and rejects a changed signature', async () => {
    const envelope = await createSignedEnvelope('shared-secret', 'projects.list', { projectId: 'project-a' }, 1234567890);
    const canonical = `${envelope.timestamp}\n${envelope.nonce}\n${envelope.operation}\n${envelope.payloadJson}`;
    const expected = await hmacSha256Base64('shared-secret', canonical);
    expect(envelope.payloadJson).toBe('{"projectId":"project-a"}');
    expect(timingSafeBase64Equal(envelope.signature, expected)).toBe(true);
    expect(timingSafeBase64Equal(envelope.signature, await hmacSha256Base64('shared-secret', `${canonical}x`))).toBe(false);
  });

  it('requires the session CSRF token on authenticated mutations', async () => {
    const rawSession = 'csrf-session';
    await insertSession(rawSession, 'line-csrf');
    const missing = await invoke('/api/auth/logout', {
      method: 'POST',
      headers: { origin: allowedOrigin, cookie: `${SESSION_COOKIE}=${rawSession}` },
    });
    expect(missing.response.status).toBe(403);
    await expect(missing.response.json()).resolves.toMatchObject({ error: { code: 'csrf_token_invalid' } });

    const me = await invoke('/api/auth/me', { headers: { cookie: `${SESSION_COOKIE}=${rawSession}` } });
    await expect(me.response.json()).resolves.toMatchObject({ data: { csrfToken: 'csrf-line-csrf' } });
  });
});
