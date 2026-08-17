const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.gs'))) {
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}

function propertyStore(map) {
  return {
    getProperty(key) { return map.has(key) ? map.get(key) : null; },
    setProperty(key, value) { map.set(key, String(value)); return this; },
    deleteProperty(key) { map.delete(key); return this; },
  };
}

const scriptPropertyMap = new Map();
const userPropertyMap = new Map();
const lockEvents = [];
let activeEmail = 'admin1@example.com';
let uuidCounter = 0;
const projectTriggers = [];
const sandbox = {
  console,
  Date,
  JSON,
  Math,
  Number,
  Object,
  String,
  Array,
  Boolean,
  Error,
  encodeURIComponent,
  Utilities: {
    Charset: { UTF_8: 'UTF-8' },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeHmacSha256Signature(value, secret) {
      return [...crypto.createHmac('sha256', secret).update(value, 'utf8').digest()];
    },
    computeHmacSha1Signature(value, secret) {
      return [...crypto.createHmac('sha1', Buffer.from(secret)).update(Buffer.from(value)).digest()];
    },
    computeDigest(algorithm, value) {
      assert.equal(algorithm, 'SHA_256');
      return [...crypto.createHash('sha256').update(String(value), 'utf8').digest()];
    },
    base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); },
    getUuid() { uuidCounter += 1; return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`; },
    formatDate() { return '20260818-120000'; },
  },
  PropertiesService: {
    getScriptProperties() { return propertyStore(scriptPropertyMap); },
    getUserProperties() { return propertyStore(userPropertyMap); },
  },
  Session: {
    getActiveUser() { return { getEmail() { return activeEmail; } }; },
    getEffectiveUser() { return { getEmail() { return activeEmail; } }; },
  },
  LockService: {
    getScriptLock() {
      return {
        waitLock() { lockEvents.push('locked'); },
        releaseLock() { lockEvents.push('released'); },
      };
    },
  },
  SpreadsheetApp: { flush() { lockEvents.push('flushed'); } },
  ScriptApp: {
    getProjectTriggers() { return projectTriggers.slice(); },
    newTrigger(handler) {
      return {
        timeBased() { return this; },
        everyMinutes(minutes) { assert.equal(minutes, 5); return this; },
        create() {
          const trigger = { getHandlerFunction() { return handler; } };
          projectTriggers.push(trigger);
          return trigger;
        },
      };
    },
  },
};
vm.createContext(sandbox);
for (const file of ['Domain.gs', 'Gateway.gs', 'Store.gs', 'Notifications.gs', 'Code.gs']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('gateway canonical string and HMAC match Worker contract', () => {
  const envelope = {
    timestamp: 1786982400000,
    nonce: 'ABCDEFGHIJKLMNOPQRSTUVWX',
    operation: 'subscriptions.create',
    payloadJson: '{"requestId":"req-1","requestedAmountTwd":500000}',
  };
  const canonical = '1786982400000\nABCDEFGHIJKLMNOPQRSTUVWX\nsubscriptions.create\n{"requestId":"req-1","requestedAmountTwd":500000}';
  assert.equal(sandbox.canonicalEnvelopeString_(envelope), canonical);
  const expected = crypto.createHmac('sha256', 'x'.repeat(32)).update(canonical).digest('base64');
  assert.equal(sandbox.computeGatewaySignature_(envelope, 'x'.repeat(32)), expected);
  envelope.signature = expected;
  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.verifyGatewayEnvelope_(envelope, 'x'.repeat(32), envelope.timestamp))),
    { requestId: 'req-1', requestedAmountTwd: 500000 },
  );
});

test('gateway rejects expired and tampered envelopes', () => {
  const envelope = {
    timestamp: '1786982400000', nonce: 'ABCDEFGHIJKLMNOPQRSTUVWX', operation: 'projects.list',
    payloadJson: '{}', signature: 'invalid',
  };
  assert.throws(() => sandbox.verifyGatewayEnvelope_(envelope, 'x'.repeat(32), Number(envelope.timestamp)), /signature/i);
  envelope.signature = sandbox.computeGatewaySignature_(envelope, 'x'.repeat(32));
  assert.throws(() => sandbox.verifyGatewayEnvelope_(envelope, 'x'.repeat(32), Number(envelope.timestamp) + 300001), /expired/i);
});

test('store flushes spreadsheet writes before releasing the script lock', () => {
  lockEvents.length = 0;
  assert.equal(sandbox.withStoreLock_(() => { lockEvents.push('write'); return 'ok'; }), 'ok');
  assert.deepEqual(lockEvents, ['locked', 'write', 'flushed', 'released']);
});

test('five TWD ledgers enforce financial invariants', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.validateAmounts_({
    requestedAmountTwd: 1000000, approvedAmountTwd: 900000, receivedAmountTwd: 700000,
    allocatedAmountTwd: 500000, refundedAmountTwd: 100000,
  }))), {
    requestedAmountTwd: 1000000, approvedAmountTwd: 900000, receivedAmountTwd: 700000,
    allocatedAmountTwd: 500000, refundedAmountTwd: 100000,
  });
  assert.throws(() => sandbox.validateAmounts_({
    requestedAmountTwd: 100, approvedAmountTwd: 101, receivedAmountTwd: 0,
    allocatedAmountTwd: 0, refundedAmountTwd: 0,
  }), /Approved amount/);
  assert.throws(() => sandbox.validateAmounts_({
    requestedAmountTwd: 100, approvedAmountTwd: 100, receivedAmountTwd: 80,
    allocatedAmountTwd: 71, refundedAmountTwd: 10,
  }), /Allocated amount/);
});

test('derived amount states cannot reverse paid or final workflows', () => {
  const current = sandbox.createSubscriptionRecord_({
    id: 's-amount', memberId: 'm-1', projectId: 'p-1', requestedAmountTwd: 100,
    riskAcknowledged: true, riskAcknowledgedAt: '2026-08-18T00:00:00.000Z', riskDisclosureVersion: 'test-v1',
  }, '2026-08-18T00:00:00.000Z');
  const settled = sandbox.updateSubscriptionRecord_(current, {
    approvedAmountTwd: 100, receivedAmountTwd: 100, allocatedAmountTwd: 100,
  }, '2026-08-18T01:00:00.000Z');
  assert.equal(settled.fundingState, 'paid');
  assert.equal(settled.allocationState, 'final');
  assert.throws(() => sandbox.updateSubscriptionRecord_(settled, {
    receivedAmountTwd: 0, allocatedAmountTwd: 0,
  }, '2026-08-18T02:00:00.000Z'), /paid to unpaid/i);
  assert.throws(() => sandbox.updateSubscriptionRecord_(settled, {
    allocatedAmountTwd: 0,
  }, '2026-08-18T02:00:00.000Z'), /final to pending/i);
});

test('subscription state is independent and approval needs partner evidence', () => {
  const current = sandbox.createSubscriptionRecord_({
    id: 's-1', memberId: 'm-1', projectId: 'p-1', requestedAmountTwd: 1000000,
    riskAcknowledged: true, riskAcknowledgedAt: '2026-08-18T00:00:00.000Z', riskDisclosureVersion: 'test-v1',
  }, '2026-08-18T00:00:00.000Z');
  const confirmed = sandbox.updateSubscriptionRecord_(current, {
    subscriptionState: 'operations_confirmed', approvedAmountTwd: 1000000,
  }, '2026-08-18T01:00:00.000Z');
  const review = sandbox.updateSubscriptionRecord_(confirmed, { subscriptionState: 'partner_review' }, '2026-08-18T02:00:00.000Z');
  assert.throws(() => sandbox.updateSubscriptionRecord_(review, { subscriptionState: 'approved' }, '2026-08-18T03:00:00.000Z'), /approval evidence/i);
  const approved = sandbox.updateSubscriptionRecord_(review, {
    subscriptionState: 'approved',
    partnerApproval: { approver: 'Licensed Partner', approvedAt: '2026-08-18T03:00:00.000Z', reference: 'REF-1' },
  }, '2026-08-18T03:00:00.000Z');
  assert.equal(approved.subscriptionState, 'approved');
  assert.equal(approved.fundingState, 'unpaid');
});

test('qualification evidence requires valid chronology and an unexpired end date', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z');
  const base = { approver: 'Real licensed approver', approvedAt: '2026-08-18T10:00:00.000Z', reference: 'Q-100', expiresAt: '2027-08-18T00:00:00.000Z' };
  const valid = sandbox.assertQualificationEvidence_('approved', base, now);
  assert.equal(valid.expiresAt, '2027-08-18T00:00:00.000Z');
  assert.throws(() => sandbox.assertQualificationEvidence_('approved', { ...base, approvedAt: 'not-a-date' }, now), /approval time/i);
  assert.throws(() => sandbox.assertQualificationEvidence_('approved', { ...base, approvedAt: '2026-08-18T12:06:00.000Z' }, now), /future/i);
  assert.throws(() => sandbox.assertQualificationEvidence_('approved', { ...base, expiresAt: '' }, now), /expiresAt|required/i);
  assert.throws(() => sandbox.assertQualificationEvidence_('approved', { ...base, expiresAt: '2026-08-18T11:59:59.000Z' }, now), /future date/i);
  assert.throws(() => sandbox.assertQualificationEvidence_('approved', { ...base, approvedAt: '2027-08-18T00:00:00.000Z', expiresAt: '2026-08-19T00:00:00.000Z' }, Date.parse('2027-08-18T00:00:00.000Z')), /future date/i);
});

test('member roles fail closed without identity and expired qualification cannot unlock projects', () => {
  const project = { id: 'p-1', slug: 'demo', demo: true, displayName: 'DEMO', publicVisibility: 'anonymous',
    industry: 'bio', stage: 'seed', region: 'TW', summary: 'public', highlights: [], updatedAt: 'now',
    companyName: 'SECRET COMPANY', targetAmountTwd: 100, minimumAmountTwd: 10, incrementAmountTwd: 10,
    memberAllowlist: ['m-2'], reports: [], risks: [], useOfFunds: [], deck: { id: 'd-1' } };
  const denied = { id: 'm-1', membershipState: 'active', qualificationState: 'approved', projectAccess: ['p-1'], qualificationApproval: { approvedAt: '2019-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:00.000Z' } };
  const allowed = { id: 'm-1', membershipState: 'active', qualificationState: 'approved', projectAccess: ['p-1'], qualificationApproval: { approvedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' } };
  assert.equal(sandbox.projectViewForActor_(project, denied, 'qualified').protected, undefined);
  assert.equal(sandbox.projectViewForActor_(project, allowed, 'qualified').protected.companyName, 'SECRET COMPANY');
  assert.throws(() => sandbox.assertOwnMemberScope_({ role: 'member', memberId: '' }, ''), (error) => error.code === 'identity_not_linked');
  assert.throws(() => sandbox.assertOwnMemberScope_({ role: 'qualified' }, undefined), (error) => error.code === 'identity_not_linked');
  assert.throws(() => sandbox.assertRole_({ role: 'member' }, ['member']), (error) => error.code === 'identity_not_linked');
  assert.throws(() => sandbox.assertOwnMemberScope_({ role: 'member', memberId: 'm-1' }, 'm-2'), /private/i);
});

test('activation cannot trust the client LINE friendship checkbox', () => {
  const originalFind = sandbox.storeFindById_;
  sandbox.storeFindById_ = () => ({ id: 'm-1', lineUserId: 'U1', displayName: 'Member', lineFriendshipState: 'not_friend' });
  try {
    assert.throws(() => sandbox.operationCreateActivation_({ activation: {
      fullName: '王小明', phone: '0912345678', sourceCode: 'GROUP-A', sourceName: '社群 A',
      lineFriendConfirmed: true, privacyConsent: true,
    } }, { role: 'member', memberId: 'm-1', actorId: 'm-1' }), (error) => error.code === 'line_friendship_required');
  } finally {
    sandbox.storeFindById_ = originalFind;
  }
});

test('source codes remain claimed until admin evidence verifies an effective referrer', () => {
  const active = sandbox.createReferrerRecord_({
    code: 'group-a', displayName: '社群 A', legalName: '社群 A 有限公司',
    contactName: '王窗口', contactEmail: 'group-a@example.com', status: 'active',
    defaultCommissionRateBps: 375, commissionBasis: 'allocated_amount', agreementReference: 'AG-1',
    effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
  }, 'referrer-1', '2026-01-01T00:00:00.000Z');
  const claimed = sandbox.referralClaim_(active, '2026-08-18T00:00:00.000Z');
  const member = { referralAttribution: claimed };
  assert.equal(sandbox.referralSnapshotForMember_(member, [active], '2026-08-18T00:00:00.000Z'), null);
  member.referralAttribution = sandbox.verifyReferralAttribution_(
    member.referralAttribution,
    { referrerId: active.id, evidenceReference: 'EVIDENCE-1' },
    [active], { id: 'admin@example.com' }, '2026-08-18T01:00:00.000Z',
  );
  const snapshot = sandbox.referralSnapshotForMember_(member, [active], '2026-08-18T02:00:00.000Z');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    referrerId: 'referrer-1', referrerName: '社群 A', referralCode: 'GROUP-A',
    commissionRateBps: 375, commissionBasis: 'allocated_amount', agreementReference: 'AG-1',
    capturedAt: '2026-08-18T02:00:00.000Z',
  });
  assert.equal(sandbox.referralSnapshotForMember_(member, [{ ...active, status: 'disabled' }], '2026-08-18T02:00:00.000Z'), null);
  assert.equal(sandbox.referralSnapshotForMember_(member, [active], '2027-01-01T00:00:00.000Z'), null);
});

test('activation only claims an active effective code and never clears a verified attribution', () => {
  const referrer = sandbox.createReferrerRecord_({
    code: 'GROUP-A', displayName: 'Group A', legalName: 'Group A Ltd', contactName: 'Contact',
    contactEmail: 'contact@example.com', status: 'active', defaultCommissionRateBps: 500,
    commissionBasis: 'allocated_amount', agreementReference: 'AG-1',
    effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  }, 'ref-1', '2020-01-01T00:00:00.000Z');
  const verified = {
    referrerId: 'ref-verified', referralCode: 'VERIFIED', state: 'verified', evidenceReference: 'EV-1',
    claimedAt: '2026-01-01T00:00:00.000Z', verifiedAt: '2026-01-02T00:00:00.000Z', verifiedBy: 'admin',
  };
  const originals = {
    find: sandbox.storeFindById_, list: sandbox.storeList_, append: sandbox.storeAppend_,
    put: sandbox.storePut_, audit: sandbox.appendAudit_,
  };
  let member;
  let saved;
  sandbox.storeFindById_ = () => member;
  sandbox.storeList_ = (sheet) => sheet === 'Referrers' ? [referrer] : [];
  sandbox.storeAppend_ = () => {};
  sandbox.storePut_ = (_sheet, record) => { saved = JSON.parse(JSON.stringify(record)); };
  sandbox.appendAudit_ = () => {};
  const activate = (sourceCode) => sandbox.operationCreateActivation_({ activation: {
    fullName: '王小明', phone: '0912345678', sourceCode, sourceName: '社群',
    lineFriendConfirmed: true, privacyConsent: true,
  } }, { role: 'member', memberId: 'm-1', actorId: 'm-1', requestId: 'req-1' });
  try {
    member = { id: 'm-1', lineUserId: 'U1', displayName: 'Member', lineFriendshipState: 'friend', referralAttribution: null };
    activate('GROUP-A');
    assert.equal(saved.referralAttribution.state, 'claimed');
    assert.equal(saved.referralAttribution.referrerId, 'ref-1');
    member = { id: 'm-1', lineUserId: 'U1', displayName: 'Member', lineFriendshipState: 'friend', referralAttribution: null };
    activate('UNKNOWN');
    assert.equal(saved.referralAttribution, null);
    member = { id: 'm-1', lineUserId: 'U1', displayName: 'Member', lineFriendshipState: 'friend', referralAttribution: verified };
    const response = activate('UNKNOWN');
    assert.deepEqual(saved.referralAttribution, verified);
    assert.doesNotMatch(JSON.stringify(response), /referralAttribution|evidenceReference|referrerName|commission/i);
  } finally {
    sandbox.storeFindById_ = originals.find;
    sandbox.storeList_ = originals.list;
    sandbox.storeAppend_ = originals.append;
    sandbox.storePut_ = originals.put;
    sandbox.appendAudit_ = originals.audit;
  }
});

test('commission uses floor allocation math and requires evidence for approve pay and void', () => {
  const snapshot = { referrerId: 'r-1', referrerName: 'Referrer', referralCode: 'R1', commissionRateBps: 333,
    commissionBasis: 'allocated_amount', agreementReference: 'AG-1', capturedAt: '2026-08-18T00:00:00.000Z' };
  assert.equal(sandbox.calculateCommissionAmount_(10001, 333), 333);
  const base = sandbox.createSubscriptionRecord_({
    id: 's-commission', memberId: 'm-1', projectId: 'p-1', requestedAmountTwd: 100000,
    riskAcknowledged: true, riskAcknowledgedAt: '2026-08-18T00:00:00.000Z',
    riskDisclosureVersion: 'v1', referralSnapshot: snapshot,
  }, '2026-08-18T00:00:00.000Z');
  const allocated = sandbox.updateSubscriptionRecord_(base, {
    approvedAmountTwd: 100000, receivedAmountTwd: 33333, allocatedAmountTwd: 33333,
  }, '2026-08-18T01:00:00.000Z');
  assert.equal(allocated.commissionState, 'accrued');
  assert.equal(allocated.commissionBasisAmountTwd, 33333);
  assert.equal(allocated.commissionAccruedAmountTwd, Math.floor(33333 * 333 / 10000));
  assert.throws(() => sandbox.patchCommissionRecord_(allocated, { action: 'approve', reason: 'checked' }, { id: 'admin' }, '2026-08-18T02:00:00.000Z'), /approvalReference/);
  const approved = sandbox.patchCommissionRecord_(allocated, {
    action: 'approve', approvalReference: 'APP-1', reason: 'matched evidence',
  }, { id: 'admin' }, '2026-08-18T02:00:00.000Z');
  assert.throws(() => sandbox.patchCommissionRecord_(approved, { action: 'pay', reason: 'paid' }, { id: 'admin' }, '2026-08-18T03:00:00.000Z'), /payoutReference/);
  const paid = sandbox.patchCommissionRecord_(approved, {
    action: 'pay', payoutReference: 'PAY-1', reason: 'bank transfer confirmed',
  }, { id: 'admin' }, '2026-08-18T03:00:00.000Z');
  assert.equal(paid.commissionState, 'paid');
  assert.throws(() => sandbox.patchCommissionRecord_(paid, {
    action: 'void', voidReason: 'mistake', reason: 'attempt reversal',
  }, { id: 'admin' }, '2026-08-18T04:00:00.000Z'), /paid to void/i);
  assert.throws(() => sandbox.updateSubscriptionRecord_(paid, {
    receivedAmountTwd: 30000, allocatedAmountTwd: 30000,
  }, '2026-08-18T04:00:00.000Z'), (error) => error.code === 'commission_amount_locked');

  const voided = sandbox.patchCommissionRecord_(allocated, {
    action: 'void', voidReason: 'duplicate attribution', reason: 'evidence review',
  }, { id: 'admin' }, '2026-08-18T02:00:00.000Z');
  assert.equal(voided.commissionState, 'void');
  assert.equal(voided.commissionVoidReason, 'duplicate attribution');
  const afterVoidLedgerChange = sandbox.updateSubscriptionRecord_(voided, {
    approvedAmountTwd: 100000, receivedAmountTwd: 50000, allocatedAmountTwd: 50000,
  }, '2026-08-18T05:00:00.000Z');
  assert.equal(afterVoidLedgerChange.allocatedAmountTwd, 50000);
  assert.equal(afterVoidLedgerChange.commissionBasisAmountTwd, voided.commissionBasisAmountTwd);
  assert.equal(afterVoidLedgerChange.commissionAccruedAmountTwd, voided.commissionAccruedAmountTwd);
});

test('member serializers exclude all referral and commission evidence fields', () => {
  const member = sandbox.sanitizeMemberForSelf_({
    id: 'm-1', displayName: 'Member', sourceGroup: 'claimed source', membershipState: 'active',
    qualificationState: 'approved', referralAttribution: { verified: { evidenceReference: 'SECRET' } },
    projectAccess: [], createdAt: 'now', updatedAt: 'now',
  });
  const subscription = sandbox.sanitizeSubscriptionForMember_({
    id: 's-1', memberId: 'm-1', projectId: 'p-1', membershipState: 'active',
    qualificationState: 'approved', subscriptionState: 'submitted', fundingState: 'unpaid',
    allocationState: 'pending', requestedAmountTwd: 1, approvedAmountTwd: 0,
    receivedAmountTwd: 0, allocatedAmountTwd: 0, refundedAmountTwd: 0,
    referralSnapshot: { referrerName: 'SECRET' }, commissionState: 'pending',
    commissionBasisAmountTwd: 1, commissionAccruedAmountTwd: 99, createdAt: 'now', updatedAt: 'now',
  });
  const serialized = JSON.stringify({ member, subscription });
  assert.doesNotMatch(serialized, /commission|referralSnapshot|referralAttribution|evidenceReference|referrerName/i);
});

test('referral and commission sheets expose the production column contract', () => {
  assert.ok(sandbox.ZF_SCHEMA.Members.includes('referralAttributionJson'));
  assert.ok(sandbox.ZF_SCHEMA.Subscriptions.includes('referralSnapshotJson'));
  for (const field of ['commissionState', 'commissionBasisAmountTwd', 'commissionAccruedAmountTwd', 'commissionApprovalJson', 'commissionPaymentJson', 'commissionVoidReason']) {
    assert.ok(sandbox.ZF_SCHEMA.Subscriptions.includes(field));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.ZF_SCHEMA.Referrers)), [
    'id', 'demo', 'code', 'displayName', 'legalName', 'contactName', 'contactEmail',
    'status', 'defaultCommissionRateBps', 'commissionBasis', 'agreementReference',
    'effectiveAt', 'expiresAt', 'createdAt', 'updatedAt',
  ]);
});

test('commission CSV exposes admin evidence columns without changing subscription rows', () => {
  const csv = sandbox.commissionRecordsToCsv_([{
    id: 's-1', memberId: 'm-1', memberName: 'Member', projectId: 'p-1', projectName: 'Project',
    referralSnapshot: { referrerId: 'r-1', referrerName: 'Group A', referralCode: 'GROUP-A', commissionRateBps: 500,
      commissionBasis: 'allocated_amount', agreementReference: 'AG-1', capturedAt: 'now' },
    allocatedAmountTwd: 100000, commissionBasisAmountTwd: 100000,
    commissionAccruedAmountTwd: 5000, commissionState: 'approved',
    commissionApproval: { approvedBy: 'admin', reference: 'APP-1', approvedAt: 'now' },
    updatedAt: 'now',
  }]);
  assert.match(csv, /"subscriptionId"/);
  assert.match(csv, /"agreementReference"/);
  assert.match(csv, /"commissionPayment"/);
  assert.match(csv, /"AG-1"/);
  assert.match(csv, /"5000"/);
});

test('TOTP sessions hash tokens, reject replay, expire, and lock repeated failures', () => {
  const secrets = {
    'admin1@example.com': 'JBSWY3DPEHPK3PXP',
    'admin2@example.com': 'JBSWY3DPEHPK3PXQ',
  };
  scriptPropertyMap.set('ADMIN_EMAILS', 'admin1@example.com,admin2@example.com');
  scriptPropertyMap.set('ADMIN_TOTP_SECRETS_JSON', JSON.stringify(secrets));
  scriptPropertyMap.delete('ADMIN_AUTH_STATES_JSON');
  userPropertyMap.clear();
  activeEmail = 'admin1@example.com';
  const now = Date.parse('2026-08-18T12:00:00.000Z');
  const counter = Math.floor(now / 30000);
  const code = sandbox.totpCode_(secrets[activeEmail], counter);
  assert.equal(sandbox.authenticateAdminTotpForEmail_(activeEmail, code, now), counter);
  assert.throws(() => sandbox.authenticateAdminTotpForEmail_(activeEmail, code, now), (error) => error.code === 'admin_two_factor_replayed');

  const session = sandbox.issueAdminSession_({ email: activeEmail }, now);
  const persisted = userPropertyMap.get('ADMIN_HTML_SESSION_JSON');
  assert.ok(persisted);
  assert.ok(!persisted.includes(session.token), 'raw session token must never be persisted server-side');
  assert.equal(sandbox.assertAdminSession_(session.token, now + 1000).email, activeEmail);
  assert.throws(() => sandbox.assertAdminSession_(session.token, now + sandbox.ZF_ADMIN_SESSION_TTL_MS + 1), (error) => error.code === 'admin_session_required');

  scriptPropertyMap.delete('ADMIN_AUTH_STATES_JSON');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.throws(() => sandbox.authenticateAdminTotpForEmail_(activeEmail, '000000', now + attempt), (error) => error.code === 'admin_two_factor_invalid');
  }
  assert.throws(() => sandbox.authenticateAdminTotpForEmail_(activeEmail, '000000', now + 5), (error) => error.code === 'admin_two_factor_locked');
});

test('admin configuration preflight requires at least two allowlisted accounts', () => {
  const previous = scriptPropertyMap.get('ADMIN_EMAILS');
  scriptPropertyMap.set('ADMIN_EMAILS', 'admin1@example.com');
  assert.throws(() => sandbox.adminConfiguration_(), /at least two/i);
  scriptPropertyMap.set('ADMIN_EMAILS', previous);
});

test('production preflight reports configuration without secrets and installs one trigger idempotently', () => {
  scriptPropertyMap.set('SPREADSHEET_ID', 'sheet-1');
  scriptPropertyMap.set('GATEWAY_SHARED_SECRET', 'g'.repeat(32));
  scriptPropertyMap.set('LINE_MESSAGING_ACCESS_TOKEN', 'line-token-test-only');
  scriptPropertyMap.set('MEMBER_APP_BASE_URL', 'https://member.example');
  projectTriggers.length = 0;
  const first = sandbox.installNotificationQueueTrigger();
  const second = sandbox.installNotificationQueueTrigger();
  assert.equal(first.triggerCreated, true);
  assert.equal(second.triggerCreated, false);
  assert.equal(projectTriggers.length, 1);
  assert.equal(JSON.stringify(second).includes('line-token-test-only'), false);
  assert.equal(second.administratorCount, 2);
});

test('notification policy requires manual approval for rejections refunds and bulk', () => {
  for (const event of ['membership_rejected', 'qualification_rejected', 'subscription_rejected', 'subscription_refunded', 'bulk_announcement']) {
    assert.equal(sandbox.notificationPolicyForEvent_(event), 'manual');
  }
  for (const event of ['membership_activated', 'subscription_submitted', 'subscription_approved']) {
    assert.equal(sandbox.notificationPolicyForEvent_(event), 'auto');
  }
  for (const event of Object.keys(sandbox.ZF_NOTIFICATION_COPY)) {
    assert.doesNotMatch(sandbox.notificationMessageForEvent_(event), /NT\$|TWD|新台幣|\$[\d,]|金額[:：]?\s*\d/);
  }
});

test('LINE delivery gets three retries before entering the failed queue', () => {
  const originals = {
    storeList: sandbox.storeList_, storePut: sandbox.storePut_, linePush: sandbox.linePush_, audit: sandbox.appendAudit_,
  };
  let saved;
  sandbox.storePut_ = (sheet, record) => { saved = record; };
  sandbox.linePush_ = () => { throw sandbox.domainError_('provider unavailable', 'line_push_failed', 502); };
  sandbox.appendAudit_ = () => {};
  try {
    for (const [priorAttempts, expected] of [[0, 'retry'], [1, 'retry'], [2, 'retry'], [3, 'failed']]) {
      saved = null;
      sandbox.storeList_ = () => [{
        id: 'n-1', state: priorAttempts ? 'retry' : 'queued', attemptCount: priorAttempts,
        nextAttemptAt: '', updatedAt: '', lineUserId: 'U1', message: '狀態已更新',
      }];
      sandbox.processNotificationQueue_(1);
      assert.equal(saved.state, expected);
      assert.equal(saved.attemptCount, priorAttempts + 1);
    }
  } finally {
    sandbox.storeList_ = originals.storeList;
    sandbox.storePut_ = originals.storePut;
    sandbox.linePush_ = originals.linePush;
    sandbox.appendAudit_ = originals.audit;
  }
});

test('every Worker Apps Script operation is registered by the Apps Script dispatcher', () => {
  const workerSource = ['index.ts', 'auth.ts', 'webhook.ts'].map((name) =>
    fs.readFileSync(path.resolve(root, '..', 'cloudflare', 'src', name), 'utf8')).join('\n');
  const operations = new Set([
    ...[...workerSource.matchAll(/operation:\s*'([A-Za-z][A-Za-z0-9.]*)'/g)].map((match) => match[1]),
    ...[...workerSource.matchAll(/,\s*'([A-Za-z][A-Za-z0-9.]*)',\s*'(?:public|member|admin)'/g)].map((match) => match[1]),
    ...[...workerSource.matchAll(/callAppsScript(?:<[^>]+>)?\(env,\s*'([A-Za-z][A-Za-z0-9.]*)'/g)].map((match) => match[1]),
  ]);
  const dispatcher = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
  assert.ok(operations.size >= 20, `expected Worker operation allowlist, found ${operations.size}`);
  for (const operation of operations) {
    const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(dispatcher, new RegExp(`(?:^|\\s|['"])${escaped}(?:['"])?\\s*:`), `missing Apps Script operation ${operation}`);
  }
});

test('canonical Worker member referral payload succeeds through the Apps dispatcher', () => {
  const referrer = sandbox.createReferrerRecord_({
    code: 'GROUP-A', displayName: 'Group A', legalName: 'Group A Ltd', contactName: 'Contact',
    contactEmail: 'contact@example.com', status: 'active', defaultCommissionRateBps: 500,
    commissionBasis: 'allocated_amount', agreementReference: 'AG-1',
    effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  }, 'ref-1', '2020-01-01T00:00:00.000Z');
  const current = {
    id: 'm-1', displayName: 'Member', membershipState: 'active', qualificationState: 'not_applied',
    lineFriendshipState: 'friend', tier: 'free', projectAccess: [], referralAttribution: null,
  };
  const originals = {
    find: sandbox.storeFindById_, list: sandbox.storeList_, put: sandbox.storePut_,
    audit: sandbox.appendAudit_, notify: sandbox.enqueueMemberNotification_,
  };
  let saved;
  sandbox.storeFindById_ = (sheet) => sheet === 'Members' ? current : null;
  sandbox.storeList_ = (sheet) => sheet === 'Referrers' ? [referrer] : [];
  sandbox.storePut_ = (_sheet, record) => { saved = JSON.parse(JSON.stringify(record)); };
  sandbox.appendAudit_ = () => {};
  sandbox.enqueueMemberNotification_ = () => {};
  try {
    const workerPayload = {
      memberId: 'm-1',
      patch: { referralAttribution: { referrerId: 'ref-1', evidenceReference: 'EV-100' } },
      reason: 'matched admin evidence',
      context: { role: 'admin', actorId: 'admin@example.com', requestId: 'req-worker' },
    };
    const result = sandbox.dispatchOperation_('adminPatchMember', workerPayload);
    assert.equal(result.member.referralAttribution.state, 'verified');
    assert.equal(saved.referralAttribution.evidenceReference, 'EV-100');
    assert.equal(saved.referralAttribution.verifiedBy, 'admin@example.com');
  } finally {
    sandbox.storeFindById_ = originals.find;
    sandbox.storeList_ = originals.list;
    sandbox.storePut_ = originals.put;
    sandbox.appendAudit_ = originals.audit;
    sandbox.enqueueMemberNotification_ = originals.notify;
  }
});

test('the Apps Script admin dashboard includes TOTP, evidence, access and valid JavaScript', () => {
  const html = fs.readFileSync(path.join(root, 'Admin.html'), 'utf8');
  for (const marker of ['adminAuthenticateTotp', 'sessionStorage', 'qualificationExpiresAt', 'projectAccess', 'activationEvidence', 'lineFriendshipState', 'sourceCode', 'consentedAt', 'referralEvidence', 'adminPatchCommission', 'defaultCommissionRateBps']) {
    assert.match(html, new RegExp(marker));
  }
  assert.match(html, /qualificationState==='approved'[\s\S]*qualificationExpiresAt/);
  assert.doesNotMatch(html, /onclick="(?:editMember|editSubscription|approveNotification)\('\$\{esc\(/);
  assert.match(html, /function jsArg\(value\)/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0], { filename: 'Admin.html:inline-script' });
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}\n${error.stack}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} Apps Script tests passed`);
if (failed) process.exit(1);
