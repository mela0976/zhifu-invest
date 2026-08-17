import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createSeedData } from '../src/seeds.js';
import { MemoryStore } from '../src/store.js';

const env = {
  DEMO_MODE: 'true',
  APP_ORIGIN: 'http://localhost:4173',
  SESSION_SECRET: 'test-session-secret-that-is-longer-than-32-characters',
  LINE_MESSAGING_CHANNEL_SECRET: 'test-line-signature-secret',
};

async function fixture() {
  const store = await new MemoryStore(createSeedData()).init();
  return { store, app: createApp({ store, env, staticRoot: './public' }) };
}

async function login(app, role, memberId) {
  const response = await app.request('/api/auth/demo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, memberId }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('health and config reveal capability flags but never secrets', async () => {
  const { app } = await fixture();
  for (const path of ['/healthz', '/api/health']) {
    const response = await app.request(path);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  const config = await (await app.request('/api/config')).json();
  assert.equal(config.config.demoMode, true);
  assert.equal(JSON.stringify(config).includes(env.SESSION_SECRET), false);
  assert.equal(JSON.stringify(config).includes(env.LINE_MESSAGING_CHANNEL_SECRET), false);
});

test('visitor project APIs never serialize protected data', async () => {
  const { app } = await fixture();
  const list = await (await app.request('/api/projects')).json();
  assert.equal(list.projects.length, 6);
  assert.ok(list.projects.every((project) => !('protected' in project) && !('memberAllowlist' in project)));
  const detail = await (await app.request('/api/projects/project-01')).json();
  assert.equal('protected' in detail.project, false);
  assert.equal(JSON.stringify(detail).includes('taxId'), false);
});

test('qualified allowlisted member sees protected project while an unqualified member does not', async () => {
  const { app } = await fixture();
  const qualified = await login(app, 'member', 'member-001');
  const allowed = await (await app.request('/api/projects/project-01', { headers: { cookie: qualified } })).json();
  assert.equal(allowed.project.access, 'qualified');
  assert.ok(allowed.project.protected.companyName);

  const unqualified = await login(app, 'member', 'member-025');
  const denied = await (await app.request('/api/projects/project-01', { headers: { cookie: unqualified } })).json();
  assert.equal('protected' in denied.project, false);
});

test('members can only list their own subscriptions', async () => {
  const { app, store } = await fixture();
  const memberOneCookie = await login(app, 'member', 'member-001');
  const memberTwoCookie = await login(app, 'member', 'member-002');
  const one = await (await app.request('/api/subscriptions', { headers: { cookie: memberOneCookie } })).json();
  const two = await (await app.request('/api/subscriptions', { headers: { cookie: memberTwoCookie } })).json();
  assert.ok(one.subscriptions.length > 0);
  assert.ok(two.subscriptions.length > 0);
  assert.ok(one.subscriptions.every((item) => item.memberId === 'member-001'));
  assert.ok(two.subscriptions.every((item) => item.memberId === 'member-002'));
  assert.equal(store.data.subscriptions.length, 25);
});

test('a visitor can submit the public advisory form without gaining member access', async () => {
  const { app, store } = await fixture();
  const response = await app.request('/api/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      role: 'company',
      topic: '企業募資顧問',
      name: '示意聯絡人',
      phone: '0912345678',
      preferredDate: '2026-09-01',
      preferredTime: '13:00–17:00',
      note: '希望討論募資展示方式。',
      consent: 'on',
    }),
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.booking.memberId, null);
  assert.equal(store.data.bookings.length, 1);
  assert.equal(store.data.bookings[0].contactPhone, '0912345678');
  assert.ok(store.data.notifications.some((item) => item.eventType === 'operations.booking_received'));
  assert.equal((await app.request('/api/bookings')).status, 401);
});

test('member activation binds identity and explicit consent to the authenticated member', async () => {
  const { app, store } = await fixture();
  const unverifiedFriend = await login(app, 'member', 'member-025');
  const cookie = await login(app, 'member', 'member-026');
  const input = {
    fullName: 'DEMO 測試姓名', phone: '0912-345-678', sourceCode: 'SF-NORTH',
    sourceName: 'DEMO 北區投資班', lineFriendConfirmed: true, privacyConsent: true,
  };
  const withoutConsent = await app.request('/api/activation', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, privacyConsent: false }),
  });
  assert.equal(withoutConsent.status, 409);

  const spoofedFriend = await app.request('/api/activation', {
    method: 'POST', headers: { cookie: unverifiedFriend, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(spoofedFriend.status, 409);
  assert.equal((await spoofedFriend.json()).error.code, 'line_friendship_required');

  const response = await app.request('/api/activation', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(response.status, 201);
  const activation = (await response.json()).activation;
  assert.equal(activation.memberId, 'member-026');
  assert.equal(activation.privacyConsent, true);
  assert.equal(activation.lineFriendshipEvidence, 'friend');
  assert.match(activation.consentedAt, /^2026-|^20\d{2}-/);
  const member = store.data.members.find((item) => item.id === 'member-026');
  assert.equal(member.legalName, input.fullName);
  assert.equal(member.phone, '0912345678');
  assert.equal(member.sourceGroup, input.sourceName);
});

test('subscription creation is permission-gated and idempotent', async () => {
  const { app, store } = await fixture();
  const cookie = await login(app, 'member', 'member-001');
  const missingRisk = await app.request('/api/subscriptions', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'intent-no-risk' },
    body: JSON.stringify({ projectId: 'project-01', requestedAmountTwd: 500_000 }),
  });
  assert.equal(missingRisk.status, 409);
  const request = () => app.request('/api/subscriptions', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'intent-0001' },
    body: JSON.stringify({ projectId: 'project-01', requestedAmountTwd: 500_000, riskAcknowledged: true }),
  });
  const first = await request();
  const firstBody = await first.json();
  const second = await request();
  const secondBody = await second.json();
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(secondBody.replayed, true);
  assert.equal(firstBody.subscription.id, secondBody.subscription.id);
  assert.equal(store.data.subscriptions.length, 26);

  const unqualified = await login(app, 'member', 'member-025');
  const forbidden = await app.request('/api/subscriptions', {
    method: 'POST', headers: { cookie: unqualified, 'content-type': 'application/json', 'idempotency-key': 'intent-0002' },
    body: JSON.stringify({ projectId: 'project-01', requestedAmountTwd: 500_000, riskAcknowledged: true }),
  });
  assert.equal(forbidden.status, 403);
});

test('admin mutations require external approval evidence and append application audit events', async () => {
  const { app, store } = await fixture();
  const admin = await login(app, 'admin');
  const beforeAuditCount = store.data.audits.length;
  const missingEvidence = await app.request('/api/admin/members/member-019', {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ qualificationState: 'approved' }),
  });
  assert.equal(missingEvidence.status, 409);
  assert.equal(store.data.audits.length, beforeAuditCount);

  const invalidDates = await app.request('/api/admin/members/member-019', {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({
      qualificationState: 'approved',
      qualificationApproval: {
        approver: 'DEMO Partner', approvedAt: '2035-01-01T00:00:00.000Z',
        reference: 'Q-FUTURE', expiresAt: '2036-01-01T00:00:00.000Z',
      },
    }),
  });
  assert.equal(invalidDates.status, 409);
  assert.equal(store.data.audits.length, beforeAuditCount);

  const approved = await app.request('/api/admin/members/member-019', {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({
      qualificationState: 'approved',
      qualificationApproval: {
        approver: 'DEMO Partner', approvedAt: new Date().toISOString(), reference: 'Q-019',
        expiresAt: '2028-08-18T00:00:00.000Z',
      },
      reason: 'Recorded external decision',
    }),
  });
  assert.equal(approved.status, 200);
  assert.ok(store.data.audits.length > beforeAuditCount);
  const frozenSnapshot = store.snapshot();
  frozenSnapshot.audits[0].action = 'tampered';
  assert.notEqual(store.data.audits[0].action, 'tampered');
});

test('deck authorization is expiring, personalized, permission checked and audited', async () => {
  const { app, store } = await fixture();
  const cookie = await login(app, 'member', 'member-001');
  const tokenResponse = await app.request('/api/projects/project-01/deck-token', { method: 'POST', headers: { cookie } });
  assert.equal(tokenResponse.status, 200);
  const { url, expiresInSeconds } = await tokenResponse.json();
  assert.equal(expiresInSeconds, 300);
  const deck = await app.request(url, { headers: { cookie } });
  assert.equal(deck.status, 200);
  assert.equal(deck.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await deck.arrayBuffer());
  assert.ok(bytes.toString('latin1').includes('PERSONALIZED FOR: member-001'));
  assert.ok(store.data.audits.some((event) => event.action === 'deck.downloaded' && event.after.subjectId === 'member-001'));
  assert.equal((await app.request(url)).status, 401);
});

test('LINE webhook rejects unsigned requests and accepts a valid signature', async () => {
  const { app, store } = await fixture();
  const raw = JSON.stringify({ events: [{ type: 'unfollow', source: { userId: 'demo-line-user-001' } }] });
  const unsigned = await app.request('/api/line/webhook', { method: 'POST', body: raw });
  assert.equal(unsigned.status, 401);
  const signature = createHmac('sha256', env.LINE_MESSAGING_CHANNEL_SECRET).update(raw).digest('base64');
  const signed = await app.request('/api/line/webhook', {
    method: 'POST', headers: { 'x-line-signature': signature, 'content-type': 'application/json' }, body: raw,
  });
  assert.equal(signed.status, 200);
  assert.equal(store.data.members[0].lineFriendshipState, 'blocked');
});

test('notification queue makes one initial attempt plus three retries before entering the operations queue', async () => {
  const store = await new MemoryStore(createSeedData()).init();
  const failingLine = {
    demoMode: true,
    loginConfigured: false,
    messagingConfigured: true,
    authorizationUrl: () => '',
    verifyWebhook: () => false,
    push: async () => { throw new Error('simulated provider outage'); },
  };
  const app = createApp({ store, env, staticRoot: './public', lineProvider: failingLine });
  const admin = await login(app, 'admin');
  const queuedResponse = await app.request('/api/admin/notifications', {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: 'member-001', eventType: 'membership.active', confirm: true }),
  });
  assert.equal(queuedResponse.status, 201);
  const notificationId = (await queuedResponse.json()).notification.id;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const processed = await app.request('/api/admin/notifications/process', { method: 'POST', headers: { cookie: admin } });
    assert.equal(processed.status, 200);
  }
  const notification = store.data.notifications.find((item) => item.id === notificationId);
  assert.equal(notification.attempts, 4);
  assert.equal(notification.status, 'failed');
  assert.equal(store.data.audits.filter((item) => item.entityId === notificationId && item.action === 'notification.failed').length, 4);
});

test('admin CSV and audit endpoints are never available to a member', async () => {
  const { app } = await fixture();
  const member = await login(app, 'member', 'member-001');
  assert.equal((await app.request('/api/admin/export/members.csv', { headers: { cookie: member } })).status, 403);
  assert.equal((await app.request('/api/admin/audits', { headers: { cookie: member } })).status, 403);
  const admin = await login(app, 'admin');
  const csv = await app.request('/api/admin/export/subscriptions.csv', { headers: { cookie: admin } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /requestedAmountTwd/);
});
