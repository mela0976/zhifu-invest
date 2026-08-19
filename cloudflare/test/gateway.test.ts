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
import { appsScriptErrorStatus } from '../src/errors';

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
  it('maps every canonical referral and commission domain error to 4xx', () => {
    const codes = [
      'invalid_commission_rate', 'invalid_commission_basis', 'invalid_referrer_basis',
      'invalid_referrer_period', 'invalid_referrer_status', 'invalid_referrer_code', 'invalid_referrer_email',
      'commission_reason_required', 'commission_actor_required', 'commission_approval_required',
      'commission_payment_required', 'commission_void_reason_required', 'referrer_not_found',
      'referrer_not_effective', 'duplicate_referrer_code', 'commission_amount_locked',
      'delivery_consent_required', 'lead_owner_attribution_conflict', 'prospect_evidence_immutable',
      'prospect_member_link_required', 'prospect_owner_conflict',
    ];
    for (const code of codes) expect(appsScriptErrorStatus(code)).toBeGreaterThanOrEqual(400);
    for (const code of codes) expect(appsScriptErrorStatus(code)).toBeLessThan(500);
  });
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

  it('adapts the exact public booking form DTO before forwarding it to Apps Script', async () => {
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.toString() !== env.APPS_SCRIPT_URL) throw new Error(`Unexpected outbound request: ${url}`);
      const envelope = JSON.parse(String(init?.body)) as { operation: string; payloadJson: string };
      calls.push({ operation: envelope.operation, payload: JSON.parse(envelope.payloadJson) });
      return Response.json({ ok: true, data: { booking: { id: 'booking-1' } } });
    });

    const response = await invoke('/api/bookings', {
      method: 'POST',
      headers: { origin: allowedOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'company', name: '王小姐', topic: '企業募資顧問', phone: '0912345678',
        preferredDate: '2026-09-01', preferredTime: '下午', note: '請先電話', consent: 'on',
      }),
    });

    expect(response.response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: 'createBooking',
      payload: {
        context: { role: 'visitor', actorId: 'anonymous', memberId: '' },
        booking: {
          displayName: '王小姐', identityType: 'company', advisorType: '企業募資顧問', topic: '企業募資顧問',
          phone: '0912345678', preferredDate: '2026-09-01', preferredTime: '下午', note: '請先電話', consent: true,
        },
      },
    });
  });

  it('maps member booking reads to the member-scoped Apps operation', async () => {
    const memberSession = 'member-bookings-session';
    const adminSession = 'admin-bookings-session';
    await insertSession(memberSession, 'line-bookings');
    await insertAdminSession(adminSession);
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as { operation: string; payloadJson: string };
      calls.push({ operation: envelope.operation, payload: JSON.parse(envelope.payloadJson) });
      return Response.json({ ok: true, data: { bookings: [{ id: 'booking-1', phone: '0912345678', email: 'member@example.com' }] } });
    });
    const result = await invoke('/api/bookings', { headers: { cookie: `${SESSION_COOKIE}=${memberSession}` } });
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).not.toMatch(/0912345678|member@example/);
    const admin = await invoke('/api/bookings', { headers: { cookie: `${SESSION_COOKIE}=${adminSession}` } });
    expect(admin.response.status).toBe(200);
    expect(await admin.response.text()).toMatch(/0912345678|member@example/);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      operation: 'listBookings',
      payload: { context: { role: 'member', memberId: 'member-line-bookings' } },
    });
    expect(calls[1]).toMatchObject({ operation: 'listBookings', payload: { context: { role: 'admin' } } });
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
    expect(calls()).toBe(3); // webhook first/retry plus one idempotent daily-digest maintenance call
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
    expect(calls()).toBe(6); // three webhook attempts plus one digest maintenance call per cron run

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
    const decks = env.DECKS;
    if (!decks) throw new Error('Test requires the production DECKS binding');
    await decks.put('protected/project-a.pdf', new TextEncoder().encode('private deck'), {
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

  it('fails closed on every deck route when staging has no R2 binding', async () => {
    const rawSession = 'staging-no-decks-session';
    await insertSession(rawSession, 'line-no-decks');
    const stagingEnv = { ...env, DECKS: undefined };
    let appsCalls = 0;
    vi.stubGlobal('fetch', async () => {
      appsCalls += 1;
      return Response.json({ ok: true, data: { allowed: true, objectKey: 'unreachable.pdf' } });
    });
    const mutationRequest = new Request('https://gateway.example/api/projects/project-a/deck-token', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${rawSession}`, origin: allowedOrigin,
        'x-csrf-token': 'csrf-line-no-decks', 'content-type': 'application/json',
      },
      body: '{}',
    });
    const mutationContext = createExecutionContext();
    const tokenResponse = await worker.fetch(mutationRequest, stagingEnv, mutationContext);
    expect(tokenResponse.status).toBe(503);
    await expect(tokenResponse.json()).resolves.toMatchObject({ error: { code: 'deck_storage_not_configured' } });

    const downloadRequest = new Request('https://gateway.example/api/decks/unused', {
      headers: { cookie: `${SESSION_COOKIE}=${rawSession}` },
    });
    const downloadContext = createExecutionContext();
    const downloadResponse = await worker.fetch(downloadRequest, stagingEnv, downloadContext);
    expect(downloadResponse.status).toBe(503);
    await expect(downloadResponse.json()).resolves.toMatchObject({ error: { code: 'deck_storage_not_configured' } });
    expect(appsCalls).toBe(0);
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

  it('proxies the canonical referrer and commission admin contracts', async () => {
    const rawSession = 'admin-referral-session';
    await insertAdminSession(rawSession);
    const payloads: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.toString() !== env.APPS_SCRIPT_URL) throw new Error(`Unexpected outbound request: ${url}`);
      const envelope = JSON.parse(String(init?.body)) as { operation: string; payloadJson: string };
      payloads.push({ operation: envelope.operation, payload: JSON.parse(envelope.payloadJson) });
      return Response.json({ ok: true, data: { records: [], total: 0 } });
    });
    const authHeaders = { cookie: `${SESSION_COOKIE}=${rawSession}` };
    const mutationHeaders = {
      ...authHeaders, origin: allowedOrigin, 'x-csrf-token': 'csrf-admin', 'content-type': 'application/json',
    };
    expect((await invoke('/api/admin/referrers', { headers: authHeaders })).response.status).toBe(200);
    expect((await invoke('/api/admin/referrers', {
      method: 'POST', headers: mutationHeaders,
      body: JSON.stringify({
        code: 'GROUP-A', displayName: 'Group A', legalName: 'Group A Ltd', contactName: 'Contact',
        contactEmail: 'contact@example.com', status: 'active', defaultCommissionRateBps: 500,
        commissionBasis: 'allocated_amount', agreementReference: 'AG-1',
        effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: null, reason: 'contract',
      }),
    })).response.status).toBe(200);
    expect((await invoke('/api/admin/referrers/ref-1', {
      method: 'PATCH', headers: mutationHeaders,
      body: JSON.stringify({ code: 'GROUP-B', status: 'disabled', reason: 'expired agreement' }),
    })).response.status).toBe(200);
    expect((await invoke('/api/admin/members/member-1', {
      method: 'PATCH', headers: mutationHeaders,
      body: JSON.stringify({
        referralAttribution: { referrerId: 'ref-1', evidenceReference: 'EV-1' },
        reason: 'matched admin evidence',
      }),
    })).response.status).toBe(200);
    expect((await invoke('/api/admin/commissions', { headers: authHeaders })).response.status).toBe(200);
    expect((await invoke('/api/admin/commissions/sub-1', {
      method: 'PATCH', headers: mutationHeaders,
      body: JSON.stringify({ action: 'approve', approvalReference: 'APP-1', reason: 'evidence matched' }),
    })).response.status).toBe(200);

    expect(payloads.map(({ operation }) => operation)).toEqual([
      'adminList', 'adminCreateReferrer', 'adminPatchReferrer', 'adminPatchMember', 'adminList', 'adminPatchCommission',
    ]);
    expect(payloads[0].payload).toMatchObject({ resource: 'referrers' });
    expect(payloads[1].payload).toMatchObject({
      referrer: { code: 'GROUP-A', status: 'active', defaultCommissionRateBps: 500, commissionBasis: 'allocated_amount' },
      reason: 'contract',
    });
    expect(payloads[2].payload).toMatchObject({ referrerId: 'ref-1', patch: { code: 'GROUP-B', status: 'disabled' }, reason: 'expired agreement' });
    expect(payloads[3].payload).toMatchObject({
      memberId: 'member-1', patch: { referralAttribution: { referrerId: 'ref-1', evidenceReference: 'EV-1' } },
      reason: 'matched admin evidence',
    });
    expect(payloads[4].payload).toMatchObject({ resource: 'commissions' });
    expect(payloads[5].payload).toMatchObject({
      subscriptionId: 'sub-1', action: 'approve', approvalReference: 'APP-1', reason: 'evidence matched',
    });
  });

  it('preserves all canonical dashboard aggregate arrays for admin', async () => {
    const rawSession = 'admin-dashboard-contract';
    await insertAdminSession(rawSession);
    stubAppsScriptSequence([{ ok: true, data: {
      overview: {}, kpis: {}, referrers: [], members: [], subscriptions: [], commissions: [], actions: [],
    } }]);
    const result = await invoke('/api/admin/dashboard', {
      headers: { cookie: `${SESSION_COOKIE}=${rawSession}` },
    });
    expect(result.response.status).toBe(200);
    const body = await result.response.json() as { data: Record<string, unknown> };
    for (const key of ['referrers', 'members', 'subscriptions', 'commissions', 'actions']) {
      expect(Array.isArray(body.data[key])).toBe(true);
    }
    expect(body.data).toHaveProperty('overview');
    expect(body.data).toHaveProperty('kpis');
  });

  it('returns commission CSV as a real admin attachment', async () => {
    const rawSession = 'admin-commission-export';
    await insertAdminSession(rawSession);
    stubAppsScriptSequence([{
      ok: true,
      data: { filename: 'commissions.csv', mimeType: 'text/csv', csv: 'subscriptionId,commissionAccruedAmountTwd\ns-1,5000' },
    }]);
    const result = await invoke('/api/admin/exports/commissions.csv', {
      headers: { cookie: `${SESSION_COOKIE}=${rawSession}` },
    });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(result.response.headers.get('content-disposition')).toContain("filename*=UTF-8''commissions.csv");
    expect(await result.response.text()).toContain('s-1,5000');
  });

  it('strips referral and commission evidence from member routes but preserves admin responses', async () => {
    const memberSession = 'member-private-session';
    const adminSession = 'admin-private-session';
    await insertSession(memberSession, 'line-private');
    await insertAdminSession(adminSession);
    stubAppsScriptSequence([
      { ok: true, data: { subscriptions: [{ id: 's-1', referralSnapshot: { evidenceReference: 'SECRET' }, referralAttribution: { state: 'verified' }, commissionState: 'approved', commissionAccruedAmountTwd: 10, referrerName: 'Private Referrer' }] } },
      { ok: true, data: { records: [{ id: 's-1', referralSnapshot: { evidenceReference: 'SECRET' }, commissionState: 'approved', commissionAccruedAmountTwd: 10, referrerName: 'Private Referrer' }] } },
    ]);
    const member = await invoke('/api/subscriptions', {
      headers: { cookie: `${SESSION_COOKIE}=${memberSession}` },
    });
    const memberText = await member.response.text();
    expect(memberText).not.toMatch(/commission|referralSnapshot|referralAttribution|evidenceReference|referrerName/i);
    const admin = await invoke('/api/admin/commissions', {
      headers: { cookie: `${SESSION_COOKIE}=${adminSession}` },
    });
    const adminText = await admin.response.text();
    expect(adminText).toContain('commissionState');
    expect(adminText).toContain('evidenceReference');
  });

  it('proxies the stable growth routes with canonical payloads and CSV attachment', async () => {
    const memberSession = 'member-growth-session';
    const adminSession = 'admin-growth-session';
    await insertSession(memberSession, 'line-growth');
    await insertAdminSession(adminSession);
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.toString() !== env.APPS_SCRIPT_URL) throw new Error(`Unexpected outbound request: ${url}`);
      const envelope = JSON.parse(String(init?.body)) as { operation: string; payloadJson: string };
      calls.push({ operation: envelope.operation, payload: JSON.parse(envelope.payloadJson) });
      if (envelope.operation === 'adminExportProspects') {
        return Response.json({ ok: true, data: { filename: 'leads.csv', csv: 'id,owner\np-1,r-1' } });
      }
      return Response.json({ ok: true, data: { records: [], matches: [], content: [], preferences: {}, digest: null } });
    });
    const memberHeaders = { cookie: `${SESSION_COOKIE}=${memberSession}` };
    const memberMutation = { ...memberHeaders, origin: allowedOrigin, 'x-csrf-token': 'csrf-line-growth', 'content-type': 'application/json' };
    const adminHeaders = { cookie: `${SESSION_COOKIE}=${adminSession}` };
    const adminMutation = { ...adminHeaders, origin: allowedOrigin, 'x-csrf-token': 'csrf-admin', 'content-type': 'application/json' };

    for (const path of ['/api/newsletter/preferences', '/api/digest/today', '/api/matches', '/api/content/feed']) {
      expect((await invoke(path, { headers: memberHeaders })).response.status).toBe(200);
    }
    expect((await invoke('/api/content/public')).response.status).toBe(200);
    expect((await invoke('/api/newsletter/preferences', {
      method: 'PATCH', headers: memberMutation,
      body: JSON.stringify({
        dailyDigestConsent: true, marketingConsent: false, lineDeliveryConsent: true,
        emailDeliveryConsent: false, deliveryChannels: ['in_app', 'line'],
      }),
    })).response.status).toBe(200);
    expect((await invoke('/api/admin/leads?status=new', { headers: adminHeaders })).response.status).toBe(200);
    expect((await invoke('/api/admin/leads', {
      method: 'POST', headers: adminMutation,
      body: JSON.stringify({
        displayName: 'Lead', contact: 'lead@example.com', channel: 'LINE 社群', status: 'new',
        ownerReferrerId: 'GROUP-A', sourceReference: 'OPENCHAT-001', sourceEvidence: 'CONSENT-001',
        reason: 'consented import',
      }),
    })).response.status).toBe(200);
    expect((await invoke('/api/admin/leads/import', {
      method: 'POST', headers: adminMutation,
      body: JSON.stringify({
        rows: [{ displayName: 'Lead 2', contact: '0912-345-678', channel: 'OpenChat', sourceReference: 'OPENCHAT-002', ownerReferrerId: 'GROUP-A' }],
        sourceEvidence: 'CONSENT-BATCH-002', reason: 'batch',
      }),
    })).response.status).toBe(200);
    expect((await invoke('/api/admin/leads/prospect-1', {
      method: 'PATCH', headers: adminMutation,
      body: JSON.stringify({ status: 'qualified', linkMemberId: 'member-1', reason: 'identity matched' }),
    })).response.status).toBe(200);
    for (const path of ['/api/admin/matches?leadId=prospect-1', '/api/admin/content', '/api/admin/newsletters/preview']) {
      expect((await invoke(path, { headers: adminHeaders })).response.status).toBe(200);
    }
    expect((await invoke('/api/admin/content', {
      method: 'POST', headers: adminMutation,
      body: JSON.stringify({ type: 'video', title: 'Update', url: 'https://example.com/v', riskNotice: '非投資建議', status: 'published', publicSafe: true, reason: 'public editorial approval' }),
    })).response.status).toBe(200);
    expect((await invoke('/api/admin/content/content-1', {
      method: 'PATCH', headers: adminMutation,
      body: JSON.stringify({ status: 'published', visibility: 'member', reason: 'reviewed' }),
    })).response.status).toBe(200);
    expect((await invoke('/api/admin/newsletters/generate', {
      method: 'POST', headers: adminMutation,
      body: JSON.stringify({ date: '2026-08-19', reason: 'preview only', send: false }),
    })).response.status).toBe(200);
    const csv = await invoke('/api/admin/export/leads.csv', { headers: adminHeaders });
    expect(csv.response.status).toBe(200);
    expect(csv.response.headers.get('content-type')).toBe('text/csv; charset=utf-8');

    expect(calls.map((call) => call.operation)).toEqual([
      'getNewsletterPreferences', 'getDailyDigest', 'listMatches', 'listContentFeed', 'listPublicContent', 'patchNewsletterPreferences',
      'adminListProspects', 'adminCreateProspect', 'adminImportProspects', 'adminPatchProspect',
      'adminListMatches', 'adminListContent', 'adminDigestPreview', 'adminCreateContent', 'adminPatchContent',
      'adminDigestGenerate', 'adminExportProspects',
    ]);
    expect(calls[5].payload).toMatchObject({
      preferences: {
        dailyDigestConsent: true, marketingConsent: false, lineDeliveryConsent: true,
        emailDeliveryConsent: false, deliveryChannels: ['in_app', 'line'],
      },
      reason: 'Member updated newsletter preferences',
    });
    expect(calls[7].payload).toMatchObject({
      prospect: {
        acquisitionOwnerId: 'GROUP-A', channel: 'community', source: 'LINE 社群', sourceReference: 'OPENCHAT-001',
        email: 'lead@example.com', privacyEvidence: { reference: 'CONSENT-001', noticeVersion: 'admin-evidence-v1' },
      },
      reason: 'consented import',
    });
    expect(calls[7].payload.prospect).not.toHaveProperty('ownerReferrerId');
    expect(calls[7].payload.prospect).not.toHaveProperty('sourceEvidence');
    expect(calls[8].payload).toMatchObject({
      rows: [{
        acquisitionOwnerId: 'GROUP-A', channel: 'openchat', source: 'OpenChat', sourceReference: 'OPENCHAT-002',
        phone: '0912-345-678',
      }],
      privacyEvidence: { reference: 'CONSENT-BATCH-002', noticeVersion: 'admin-evidence-v1' },
      reason: 'batch',
    });
    expect(calls[9].payload).toMatchObject({ prospectId: 'prospect-1', patch: { status: 'qualified', linkMemberId: 'member-1' }, reason: 'identity matched' });
    expect(calls[10].payload).toMatchObject({ leadId: 'prospect-1' });
    expect(calls[13].payload).toMatchObject({ content: { type: 'video', status: 'published', publicSafe: true } });
    expect(calls[13].payload.content).not.toHaveProperty('visibility');
    expect(calls[15].payload).toMatchObject({ digestDate: '2026-08-19', reason: 'preview only', send: false });
  });

  it('returns authoritative typed lead rows for browser-side XLSX generation to admins only', async () => {
    const adminSession = 'admin-xlsx-data-session';
    await insertAdminSession(adminSession);
    const headers = [
      'schemaVersion', 'id', 'displayName', 'phone', 'email', 'channel', 'sourceReference',
      'privacyEvidenceReference', 'privacyConsentedAt', 'privacyNoticeVersion', 'ownerReferrerId',
      'memberId', 'status', 'importedBy', 'importedAt', 'subscriptionCount',
      'attributableRequestedAmountTwd', 'attributableAllocatedAmountTwd',
    ];
    const data = {
      filename: 'zhifu-leads-20260819-070000.xlsx', schemaVersion: 'lead-export-v1', headers,
      rows: [{
        schemaVersion: 'lead-export-v1', id: 'lead-1', displayName: '=王小姐', phone: '0912345678',
        email: 'wang@example.com', channel: 'email', sourceReference: 'SOURCE-1',
        privacyEvidenceReference: 'PRIVACY-1', privacyConsentedAt: '2026-08-18T00:00:00.000Z',
        privacyNoticeVersion: 'privacy-v1', ownerReferrerId: 'ref-1', memberId: 'member-1', status: 'converted',
        importedBy: 'admin-1', importedAt: '2026-08-18T00:00:00.000Z', subscriptionCount: 1,
        attributableRequestedAmountTwd: 500000, attributableAllocatedAmountTwd: 300000,
      }],
    };
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as { operation: string; payloadJson: string };
      calls.push({ operation: envelope.operation, payload: JSON.parse(envelope.payloadJson) });
      return Response.json({ ok: true, data });
    });

    const unauthenticated = await invoke('/api/admin/export/leads.xlsx-data');
    expect(unauthenticated.response.status).toBe(401);
    const result = await invoke('/api/admin/export/leads.xlsx-data', {
      headers: { cookie: `${SESSION_COOKIE}=${adminSession}` },
    });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    await expect(result.response.json()).resolves.toEqual({ ok: true, data });
    expect(calls).toEqual([{
      operation: 'adminExportProspectRows',
      payload: {
        context: { role: 'admin', actorId: 'admin-1', memberId: 'admin-1', requestId: expect.any(String) },
        reason: 'Admin requested lead Excel export data',
      },
    }]);
  });

  it('rejects malformed XLSX export DTOs instead of forwarding untyped Apps data', async () => {
    const adminSession = 'admin-xlsx-invalid-session';
    await insertAdminSession(adminSession);
    vi.stubGlobal('fetch', async () => Response.json({ ok: true, data: {
      filename: 'leads.xlsx', schemaVersion: 'lead-export-v1', headers: ['id'],
      rows: [{ id: 'lead-1', rawWorkbookBase64: 'UEsDBA==' }],
    } }));
    const result = await invoke('/api/admin/export/leads.xlsx-data', {
      headers: { cookie: `${SESSION_COOKIE}=${adminSession}` },
    });
    expect(result.response.status).toBe(502);
    await expect(result.response.json()).resolves.toMatchObject({ error: { code: 'apps_script_invalid_response' } });
  });

  it('keeps lead imports JSON-only and fails closed above the 64 KiB application limit', async () => {
    const adminSession = 'admin-xlsx-import-limit';
    await insertAdminSession(adminSession);
    let outboundCalls = 0;
    vi.stubGlobal('fetch', async () => {
      outboundCalls += 1;
      return Response.json({ ok: true, data: {} });
    });
    const headers = {
      cookie: `${SESSION_COOKIE}=${adminSession}`, origin: allowedOrigin,
      'x-csrf-token': 'csrf-admin', 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const rawWorkbook = await invoke('/api/admin/leads/import', {
      method: 'POST', headers, body: 'PK\u0003\u0004not-a-json-workbook',
    });
    expect(rawWorkbook.response.status).toBe(415);

    const oversized = await invoke('/api/admin/leads/import', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ rows: [{ displayName: 'Lead', contact: 'lead@example.com', source: 'event' }], reason: 'x'.repeat(66 * 1024) }),
    });
    expect(oversized.response.status).toBe(413);
    await expect(oversized.response.json()).resolves.toMatchObject({ error: { code: 'payload_too_large' } });
    expect(outboundCalls).toBe(0);
  });

  it('member growth responses remove owner/referrer/commission and PII at the gateway', async () => {
    const memberSession = 'member-growth-private';
    await insertSession(memberSession, 'line-growth-private');
    stubAppsScriptSequence([{ ok: true, data: {
      digest: {
        memberId: 'member-line-growth-private', legalName: 'PRIVATE NAME', email: 'private@example.com', phone: '0900',
        acquisitionOwnerId: 'ref-1', referrerName: 'OWNER', commissionState: 'paid',
        privacyEvidenceReference: 'PRIVACY-SECRET', privacyConsentedAt: '2026-08-18T00:00:00.000Z',
        importedBy: 'admin@example.com', importedAt: '2026-08-18T00:00:00.000Z',
        progress: [{ subscriptionId: 's-1', requestedAmountTwd: 100, fundingState: 'paid' }],
      },
    } }]);
    const response = await invoke('/api/digest/today', { headers: { cookie: `${SESSION_COOKIE}=${memberSession}` } });
    const text = await response.response.text();
    expect(text).toContain('requestedAmountTwd');
    expect(text).not.toMatch(/PRIVATE NAME|private@example|0900|acquisitionOwner|referrerName|commissionState|PRIVACY-SECRET|privacyConsented|importedBy|admin@example/i);
  });

  it('scheduled maintenance requests an idempotent Taipei daily digest generation', async () => {
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body)) as { operation: string; payloadJson: string };
      calls.push({ operation: envelope.operation, payload: JSON.parse(envelope.payloadJson) });
      return Response.json({ ok: true, data: { summary: { created: 0, existing: 1 } } });
    });
    await runScheduledMaintenance();
    const digestCall = calls.find((call) => call.operation === 'adminDigestGenerate');
    expect(digestCall).toBeTruthy();
    expect(digestCall?.payload).toMatchObject({ context: { role: 'service', actorId: 'cloudflare-cron' } });
    expect(digestCall?.payload.digestDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
