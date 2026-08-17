import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM deck_tokens'),
    env.DB.prepare('DELETE FROM oauth_states'),
    env.DB.prepare('DELETE FROM webhook_events'),
    env.DB.prepare('DELETE FROM sessions'),
  ]);
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
      'SELECT webhook_event_id, attempts FROM webhook_events WHERE webhook_event_id = ?1',
    ).bind('event-001').first<{ webhook_event_id: string; attempts: number }>();
    expect(stored?.webhook_event_id).toBe('event-001');
    expect(stored?.attempts).toBe(1);

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
