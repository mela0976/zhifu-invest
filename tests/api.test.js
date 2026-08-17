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
  const me = await (await app.request('/api/auth/me', { headers: { cookie: memberOneCookie } })).json();
  const memberSerialization = JSON.stringify({ me, one, two });
  for (const privateField of [
    'commissionState', 'commissionBasisAmountTwd', 'commissionAccruedAmountTwd',
    'commissionApproval', 'commissionPayment', 'commissionVoidReason',
    'referralSnapshot', 'referralAttribution', 'evidenceReference', 'referrerName',
  ]) assert.equal(memberSerialization.includes(privateField), false, `${privateField} must remain admin-only`);
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

test('activation only claims a matching effective referral code and never self-verifies it', async () => {
  const { app, store } = await fixture();
  const known = await login(app, 'member', 'member-026');
  const unknown = await login(app, 'member', 'member-027');
  const activation = (cookie, sourceCode) => app.request('/api/activation', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      fullName: 'DEMO 引薦測試', phone: '0912345678', sourceCode,
      sourceName: '轉傳或群組來源', lineFriendConfirmed: true, privacyConsent: true,
    }),
  });

  const claimed = await activation(known, 'xuefen');
  assert.equal(claimed.status, 201);
  const claimedBody = await claimed.json();
  assert.equal(claimedBody.activation.referralClaimed, true);
  assert.equal(JSON.stringify(claimedBody).includes('referralAttribution'), false);
  assert.equal(JSON.stringify(claimedBody).includes('evidenceReference'), false);
  assert.equal(store.data.members.find((item) => item.id === 'member-026').referralAttribution.state, 'claimed');

  const noMatch = await activation(unknown, 'SHARED-UNKNOWN-CODE');
  assert.equal(noMatch.status, 201);
  assert.equal(store.data.members.find((item) => item.id === 'member-027').referralAttribution, null);
});

test('admin referrer registry enforces unique codes, valid rules, audit events and role isolation', async () => {
  const { app, store } = await fixture();
  const member = await login(app, 'member', 'member-001');
  const admin = await login(app, 'admin');
  for (const [method, path] of [
    ['GET', '/api/admin/referrers'],
    ['POST', '/api/admin/referrers'],
    ['PATCH', '/api/admin/referrers/referrer-01'],
    ['GET', '/api/admin/commissions'],
  ]) assert.equal((await app.request(path, { method, headers: { cookie: member } })).status, 403);

  const input = {
    code: 'new-circle', displayName: '新高階投資圈', legalName: '新高階投資圈有限公司',
    contactName: '示意窗口', contactEmail: 'partner@example.com', status: 'active',
    defaultCommissionRateBps: 425, commissionBasis: 'allocated_amount', agreementReference: 'AGR-NEW-01',
    effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: null, reason: '完成合作方建檔',
  };
  const missingCreateReason = await app.request('/api/admin/referrers', {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, reason: '   ' }),
  });
  assert.equal(missingCreateReason.status, 409);
  assert.equal((await missingCreateReason.json()).error.code, 'referrer_reason_required');
  const createdResponse = await app.request('/api/admin/referrers', {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).referrer;
  assert.equal(created.code, 'NEW-CIRCLE');
  assert.equal(created.defaultCommissionRateBps, 425);

  const missingPatchReason = await app.request(`/api/admin/referrers/${created.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '不應寫入' }),
  });
  assert.equal(missingPatchReason.status, 409);
  assert.equal((await missingPatchReason.json()).error.code, 'referrer_reason_required');
  assert.equal(store.data.referrers.find((item) => item.id === created.id).displayName, input.displayName);

  const duplicate = await app.request('/api/admin/referrers', {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, code: 'NEW-CIRCLE' }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'duplicate_referrer_code');

  const disabledResponse = await app.request(`/api/admin/referrers/${created.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'disabled', reason: '合作到期' }),
  });
  assert.equal(disabledResponse.status, 200);
  assert.equal((await disabledResponse.json()).referrer.status, 'disabled');
  const cannotVerifyDisabled = await app.request('/api/admin/members/member-025', {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({
      referralAttribution: { referrerId: created.id, evidenceReference: 'DISABLED-REF' },
      reason: 'Should be rejected because agreement is disabled',
    }),
  });
  assert.equal(cannotVerifyDisabled.status, 409);
  assert.equal((await cannotVerifyDisabled.json()).error.code, 'referrer_not_effective');
  assert.equal((await app.request('/api/admin/export/referrers.csv', { headers: { cookie: member } })).status, 403);
  assert.equal((await app.request('/api/admin/export/commissions.csv', { headers: { cookie: member } })).status, 403);
  assert.ok(store.data.audits.some((item) => item.entityType === 'referrer' && item.entityId === created.id));
});

test('verified member attribution affects only future immutable subscription snapshots', async () => {
  const { app, store } = await fixture();
  const admin = await login(app, 'admin');
  const member = await login(app, 'member', 'member-001');
  const historical = structuredClone(store.data.subscriptions.find((item) => item.memberId === 'member-001'));

  const verified = await app.request('/api/admin/members/member-001', {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({
      referralAttribution: { referrerId: 'referrer-02', evidenceReference: 'INTRO-MAIL-2026-001' },
      reason: '核對引薦郵件與雙方確認紀錄',
    }),
  });
  assert.equal(verified.status, 200);
  const attribution = (await verified.json()).member.referralAttribution;
  assert.equal(attribution.state, 'verified');
  assert.equal(attribution.verifiedBy, 'admin-xuefen-demo');
  assert.equal((await app.request('/api/admin/members/member-001', {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ referralAttribution: null }),
  })).status, 409);

  const createdResponse = await app.request('/api/subscriptions', {
    method: 'POST',
    headers: { cookie: member, 'content-type': 'application/json', 'idempotency-key': 'referral-snapshot-001' },
    body: JSON.stringify({ projectId: 'project-01', requestedAmountTwd: 500_000, riskAcknowledged: true }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).subscription;
  assert.equal('referralSnapshot' in created, false);
  assert.equal('commissionState' in created, false);
  const createdStored = store.data.subscriptions.find((item) => item.id === created.id);
  assert.equal(createdStored.referralSnapshot.referrerId, 'referrer-02');
  assert.equal(createdStored.referralSnapshot.commissionRateBps, 250);
  assert.equal(createdStored.commissionState, 'pending');

  await app.request('/api/admin/referrers/referrer-02', {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ defaultCommissionRateBps: 999, displayName: '更名後 Alpha', reason: '新約僅適用未來成交' }),
  });
  await app.request('/api/admin/members/member-001', {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({
      referralAttribution: { referrerId: 'referrer-03', evidenceReference: 'TRANSFER-2026-002' },
      reason: '未來案件改由其他合作方引薦',
    }),
  });
  const stored = store.data.subscriptions.find((item) => item.id === created.id);
  assert.equal(stored.referralSnapshot.referrerId, 'referrer-02');
  assert.equal(stored.referralSnapshot.referrerName, '高階投資人 Alpha 會');
  assert.equal(stored.referralSnapshot.commissionRateBps, 250);
  assert.deepEqual(store.data.subscriptions.find((item) => item.id === historical.id).referralSnapshot, historical.referralSnapshot);
});

test('commission actions are server-stamped, evidence-gated, forward-only and lock approved amounts', async () => {
  const { app, store } = await fixture();
  const admin = await login(app, 'admin');
  const member = await login(app, 'member', 'member-001');
  const accrued = store.data.subscriptions.find((item) => item.commissionState === 'accrued' && item.allocationState === 'final');
  assert.ok(accrued);

  assert.equal((await app.request(`/api/admin/commissions/${accrued.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', approvalReference: 'APP-API-1' }),
  })).status, 409);
  const approvedResponse = await app.request(`/api/admin/commissions/${accrued.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', approvalReference: 'APP-API-1', reason: '財務覆核完成' }),
  });
  assert.equal(approvedResponse.status, 200);
  const approved = (await approvedResponse.json()).commission;
  assert.deepEqual(approved.commissionApproval, {
    approvedBy: 'admin-xuefen-demo', reference: 'APP-API-1', approvedAt: approved.commissionApproval.approvedAt,
  });

  const changedAmount = accrued.requestedAmountTwd + 100_000;
  const locked = await app.request(`/api/admin/subscriptions/${accrued.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestedAmountTwd: changedAmount, approvedAmountTwd: changedAmount,
      receivedAmountTwd: changedAmount, allocatedAmountTwd: changedAmount,
      reason: '嘗試調整已核准分潤的配置金額',
    }),
  });
  assert.equal(locked.status, 409);
  assert.equal((await locked.json()).error.code, 'commission_amount_locked');

  assert.equal((await app.request(`/api/admin/commissions/${accrued.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pay', reason: '準備付款' }),
  })).status, 409);
  const paid = await app.request(`/api/admin/commissions/${accrued.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'pay', payoutReference: 'BANK-API-1', reason: '匯款完成' }),
  });
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).commission.commissionPayment.paidBy, 'admin-xuefen-demo');
  assert.equal((await app.request(`/api/admin/commissions/${accrued.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'void', voidReason: '不應允許', reason: '嘗試作廢已付款分潤' }),
  })).status, 409);

  const voidable = store.data.subscriptions.find((item) => item.id !== accrued.id && item.commissionState === 'accrued');
  assert.ok(voidable);
  assert.equal((await app.request(`/api/admin/commissions/${voidable.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'void', reason: '成交撤回' }),
  })).status, 409);
  const voided = await app.request(`/api/admin/commissions/${voidable.id}`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'void', voidReason: '合作方確認成交撤回', reason: '附上撤回紀錄' }),
  });
  assert.equal(voided.status, 200);
  assert.equal((await voided.json()).commission.commissionState, 'void');
  assert.equal((await app.request('/api/admin/commissions', { headers: { cookie: member } })).status, 403);
});

test('dashboard and CSV exports include auditable referral and commission data', async () => {
  const { app, store } = await fixture();
  const admin = await login(app, 'admin');
  const dashboard = (await (await app.request('/api/admin/dashboard', { headers: { cookie: admin } })).json()).dashboard;
  assert.equal(dashboard.kpis.referrerCount, 4);
  assert.equal(dashboard.kpis.attributedMemberCount, 24);
  assert.equal(dashboard.referrers.length, 4);
  assert.equal(dashboard.commissions.length, 25);
  assert.equal(
    dashboard.kpis.commissionPaidAmountTwd,
    store.data.subscriptions.filter((item) => item.commissionState === 'paid')
      .reduce((sum, item) => sum + item.commissionAccruedAmountTwd, 0),
  );
  for (const [resource, expected] of [
    ['referrers', 'agreementReference'],
    ['commissions', 'commissionAccruedAmountTwd'],
  ]) {
    const response = await app.request(`/api/admin/export/${resource}.csv`, { headers: { cookie: admin } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(expected));
  }
});
