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
    formatDate(_date, _zone, format) { return format === 'yyyy-MM-dd' ? '2026-08-19' : '20260819-070000'; },
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
        everyDays(days) { assert.equal(days, 1); return this; },
        atHour(hour) { assert.equal(hour, 7); return this; },
        inTimezone(zone) { assert.equal(zone, 'Asia/Taipei'); return this; },
        create() {
          const trigger = { getHandlerFunction() { return handler; } };
          projectTriggers.push(trigger);
          return trigger;
        },
      };
    },
    deleteTrigger(trigger) { const index = projectTriggers.indexOf(trigger); if (index >= 0) projectTriggers.splice(index, 1); },
  },
  MailApp: {
    sent: [],
    getRemainingDailyQuota() { return 100; },
    sendEmail(message) { this.sent.push(JSON.parse(JSON.stringify(message))); },
  },
};
vm.createContext(sandbox);
for (const file of ['Domain.gs', 'Gateway.gs', 'Store.gs', 'Notifications.gs', 'Growth.gs', 'Code.gs']) {
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

test('storeAppendMany sends a batch in one Sheets range write', () => {
  const originalSheet = sandbox.sheet_;
  const calls = [];
  sandbox.sheet_ = () => ({
    getLastRow: () => 4,
    getRange(row, column, height, width) {
      calls.push({ type: 'range', row, column, height, width });
      return { setValues(values) { calls.push({ type: 'setValues', values }); throw new Error('Sheets provider failed'); } };
    },
  });
  try {
    assert.throws(() => sandbox.storeAppendMany_('Prospects', [
      { id: 'p-1', displayName: 'One' }, { id: 'p-2', displayName: 'Two' },
    ]), /provider failed/);
    assert.equal(calls.filter((call) => call.type === 'range').length, 1);
    assert.equal(calls.filter((call) => call.type === 'setValues').length, 1);
    assert.equal(calls[0].row, 5);
    assert.equal(calls[0].height, 2);
    assert.equal(calls[1].values.length, 2);
  } finally { sandbox.sheet_ = originalSheet; }
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

test('daily LINE delivery rechecks latest consent and identity before every attempt', () => {
  const originals = {
    list: sandbox.storeList_, put: sandbox.storePut_, linePush: sandbox.linePush_, audit: sandbox.appendAudit_,
  };
  let pushed = 0;
  let saved = null;
  const notification = {
    id: 'daily-1', recipientMemberId: 'm-1', lineUserId: 'U1', eventType: 'daily_digest',
    state: 'retry', attemptCount: 1, nextAttemptAt: '', message: '摘要已更新',
  };
  sandbox.storeList_ = (sheet) => ({
    Notifications: [notification],
    Members: [{ id: 'm-1', lineUserId: 'U1' }],
    NewsletterPreferences: [{ memberId: 'm-1', dailyDigestConsent: false, lineDeliveryConsent: false, deliveryChannels: ['in_app'] }],
  }[sheet] || []);
  sandbox.storePut_ = (_sheet, row) => { saved = JSON.parse(JSON.stringify(row)); return row; };
  sandbox.linePush_ = () => { pushed += 1; };
  sandbox.appendAudit_ = () => {};
  try {
    const summary = sandbox.processNotificationQueue_(1);
    assert.equal(pushed, 0);
    assert.equal(saved.state, 'cancelled_consent');
    assert.equal(saved.attemptCount, 1);
    assert.equal(summary.cancelledConsent, 1);
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storePut_ = originals.put;
    sandbox.linePush_ = originals.linePush; sandbox.appendAudit_ = originals.audit;
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

test('real landing booking DTO is adapted and persists preferred date plus consent evidence', () => {
  const originals = { append: sandbox.storeAppend_, audit: sandbox.appendAudit_, now: sandbox.nowIso_, id: sandbox.createId_ };
  const rows = [];
  sandbox.storeAppend_ = (_sheet, row) => { rows.push(JSON.parse(JSON.stringify(row))); return row; };
  sandbox.appendAudit_ = () => {};
  sandbox.nowIso_ = () => '2026-08-19T01:02:03.000Z';
  sandbox.createId_ = () => 'booking-ui';
  try {
    const result = sandbox.operationCreateBooking_({ booking: {
      role: 'company', name: '王小姐', topic: '企業募資顧問', phone: '0912345678',
      preferredDate: '2026-09-01', preferredTime: '下午', note: '請先以電話聯繫', consent: 'on',
    } }, { role: 'visitor', actorId: 'anonymous', requestId: 'booking-request' });
    assert.equal(result.booking.identityType, 'company');
    assert.equal(result.booking.contactName, '王小姐');
    assert.equal(result.booking.preferredDate, '2026-09-01');
    assert.equal(result.booking.preferredTime, '下午');
    assert.equal(result.booking.consentAt, '2026-08-19T01:02:03.000Z');
    const stored = sandbox.rowToEntity_('Bookings', sandbox.entityToRow_('Bookings', rows[0]));
    assert.equal(stored.preferredDate, '2026-09-01');
    assert.equal(stored.consentAt, '2026-08-19T01:02:03.000Z');
    assert.equal(stored.identityType, 'company');
  } finally {
    sandbox.storeAppend_ = originals.append; sandbox.appendAudit_ = originals.audit;
    sandbox.nowIso_ = originals.now; sandbox.createId_ = originals.id;
  }
});

test('canonical listBookings operation scopes a member to their own rows', () => {
  const originals = { list: sandbox.storeList_, find: sandbox.storeFindById_ };
  sandbox.storeList_ = (sheet) => sheet === 'Bookings' ? [
    { id: 'b-own', memberId: 'member-1' }, { id: 'b-other', memberId: 'member-2' }, { id: 'b-visitor', memberId: '' },
  ] : [];
  sandbox.storeFindById_ = (sheet, id) => sheet === 'Members' && id === 'member-1' ? { id: 'member-1' } : null;
  try {
    const result = sandbox.dispatchOperation_('listBookings', {
      context: { role: 'member', memberId: 'member-1', actorId: 'member-1', requestId: 'bookings-1' },
    });
    assert.deepEqual(result.bookings.map((item) => item.id), ['b-own']);
  } finally { sandbox.storeList_ = originals.list; sandbox.storeFindById_ = originals.find; }
});

test('the Apps Script admin dashboard includes TOTP, evidence, access and valid JavaScript', () => {
  const html = fs.readFileSync(path.join(root, 'Admin.html'), 'utf8');
  for (const marker of ['adminAuthenticateTotp', 'sessionStorage', 'qualificationExpiresAt', 'projectAccess', 'activationEvidence', 'lineFriendshipState', 'sourceCode', 'consentedAt', 'referralEvidence', 'adminPatchCommission', 'defaultCommissionRateBps', 'leadImportDialog', 'leadImportCsvFile', 'leadImportCsvText', 'leadImportPreview', 'adminImportProspects']) {
    assert.match(html, new RegExp(marker));
  }
  assert.match(html, /qualificationState==='approved'[\s\S]*qualificationExpiresAt/);
  assert.doesNotMatch(html, /onclick="(?:editMember|editSubscription|approveNotification)\('\$\{esc\(/);
  assert.match(html, /function jsArg\(value\)/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0], { filename: 'Admin.html:inline-script' });
});

function loadAdminHtmlScript() {
  const html = fs.readFileSync(path.join(root, 'Admin.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const node = {
    hidden: false, textContent: '', innerHTML: '', value: '', checked: false, disabled: false, readOnly: false,
    className: '', options: [],
    classList: { add() {}, remove() {} },
    addEventListener() {}, focus() {}, reset() {}, showModal() {}, close() {}, click() {},
    querySelector() { return node; }, querySelectorAll() { return []; },
  };
  node.elements = new Proxy({}, { get() { return node; } });
  const context = {
    console, Intl, Date, JSON, Math, Number, Object, String, Array, Boolean, Error, Map, Promise, RegExp,
    Blob: function Blob() {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    FormData: function FormData() {}, FileReader: function FileReader() {},
    document: { body: node, querySelector() { return node; }, querySelectorAll() { return []; }, createElement() { return node; } },
    window: { sessionStorage: { getItem() { return ''; }, setItem() {}, removeItem() {} }, confirm() { return false; } },
    google: { script: { run: {} } }, setTimeout,
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'Admin.html:inline-script-runtime' });
  return { context, html };
}

test('admin CSV import parses header aliases, previews invalid rows and rejects row-level owner reassignment', () => {
  const { context } = loadAdminHtmlScript();
  assert.equal(typeof context.parseProspectCsv, 'function');
  const preview = context.parseProspectCsv([
    '\uFEFF姓名,電子郵件,來源管道,來源',
    '王小姐,wang@example.com,OpenChat,"高資產,講座"',
    ',invalid,LINE,社群',
  ].join('\n'));
  assert.equal(preview.total, 2);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.errors.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(preview.rows[0])), {
    displayName: '王小姐', contact: 'wang@example.com', email: 'wang@example.com', channel: 'OpenChat', source: '高資產,講座', status: 'new',
  });
  assert.equal(typeof context.canSubmitProspectImport, 'function');
  assert.equal(context.canSubmitProspectImport(preview), false, 'a mixed valid/error batch must remain atomic and blocked');
  assert.equal(context.canSubmitProspectImport({ total: 1, rows: preview.rows, errors: [] }), true);

  const ownerAttempt = context.parseProspectCsv('name,email,source,owner\nLead,lead@example.com,Event,ref-other');
  assert.equal(ownerAttempt.rows.length, 0);
  assert.match(ownerAttempt.errors[0].message, /導入者.*批次|批次.*導入者/);
  const convertedAttempt = context.parseProspectCsv('姓名,email,來源,status\n待連結會員,member@example.com,活動,converted');
  assert.equal(convertedAttempt.rows.length, 0);
  assert.match(convertedAttempt.errors[0].message, /qualified.*PATCH|PATCH.*qualified/);
  const explicitIdentity = context.parseProspectCsv('姓名,email,phone,來源管道,來源\n雙聯絡,DUAL@Example.com,0912-345-678,OpenChat,社群');
  assert.deepEqual(JSON.parse(JSON.stringify(explicitIdentity.rows[0])), {
    displayName: '雙聯絡', contact: 'DUAL@Example.com', email: 'DUAL@Example.com', phone: '0912-345-678',
    channel: 'OpenChat', source: '社群', status: 'new',
  });
});

test('admin CSV import exposes mobile-safe paste and file controls with the exact audited RPC envelope', () => {
  const { html } = loadAdminHtmlScript();
  assert.match(html, /<dialog id="leadImportDialog"/);
  assert.match(html, /id="leadImportCsvFile"[^>]*accept="\.csv,text\/csv"/);
  assert.match(html, /id="leadImportCsvText"/);
  assert.match(html, /id="leadImportPreview"[^>]*aria-live="polite"/);
  assert.match(html, /onsubmit="submitLeadImport\(event\)"/);
  assert.match(html, /rpc\('adminImportProspects',\{rows,sourceEvidence,privacyEvidence,reason\}\)/);
  assert.match(html, /請先修正全部錯誤/);
  assert.match(html, /leadImportSubmit'\)\.disabled=!canSubmitProspectImport\(leadImportState\)/);
  assert.match(html, /function submitLeadImport[\s\S]*if\(!canSubmitProspectImport\(leadImportState\)\)throw[\s\S]*rpc\('adminImportProspects'/);
  assert.match(html, /匯入[^`'"<]*\$\{[^}]*importedCount[^}]*\}[^`'"<]*筆[^`'"<]*略過[^`'"<]*\$\{[^}]*skippedCount[^}]*\}/);
  assert.match(html, /@media\(max-width:760px\)[\s\S]*lead-import/);
});

test('growth sheets and append-only migration expose the production contract', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.ZF_SCHEMA.Prospects)), [
    'id', 'demo', 'displayName', 'contact', 'email', 'phone', 'sourceContact', 'channel',
    'source', 'sourceReference', 'privacyEvidenceReference', 'privacyConsentedAt',
    'privacyNoticeVersion', 'acquisitionOwnerId', 'linkedMemberId', 'status', 'importBatchId',
    'importedBy', 'importedAt', 'createdAt', 'updatedAt', 'investmentPreferencesJson',
  ]);
  assert.ok(sandbox.ZF_SCHEMA.Members.includes('investmentPreferencesJson'));
  assert.ok(sandbox.ZF_SCHEMA.Members.includes('leadOwnerAttributionJson'));
  assert.ok(sandbox.ZF_SCHEMA.Subscriptions.includes('acquisitionAttributionSnapshotJson'));
  assert.ok(sandbox.ZF_SCHEMA.ContentItems.includes('riskNotice'));
  assert.ok(sandbox.ZF_SCHEMA.NewsletterPreferences.includes('dailyDigestConsent'));
  assert.ok(sandbox.ZF_SCHEMA.NewsletterPreferences.includes('marketingConsent'));
  assert.ok(sandbox.ZF_SCHEMA.NewsletterPreferences.includes('emailDeliveryConsent'));
  assert.ok(sandbox.ZF_SCHEMA.NewsletterPreferences.includes('lineDeliveryConsent'));
  assert.ok(sandbox.ZF_SCHEMA.Bookings.includes('consentAt'));
  assert.ok(sandbox.ZF_SCHEMA.DailyDigests.includes('dedupeKey'));
  assert.equal(typeof sandbox.migrateGrowthSchema_, 'function');
});

test('growth migration appends only missing member/subscription columns and creates new sheets', () => {
  function fakeSheet(initial = []) {
    const sheet = { headers: initial.slice() };
    sheet.getLastRow = () => sheet.headers.length ? 1 : 0;
    sheet.getLastColumn = () => sheet.headers.length;
    sheet.setFrozenRows = () => sheet;
    sheet.getRange = (_row, column, _height, width) => {
      const range = {
        getValues: () => [sheet.headers.slice(column - 1, column - 1 + width)],
        setValues(rows) { for (let index = 0; index < rows[0].length; index += 1) sheet.headers[column - 1 + index] = rows[0][index]; return range; },
        setBackground() { return range; }, setFontColor() { return range; }, setFontWeight() { return range; },
      };
      return range;
    };
    return sheet;
  }
  const sheets = {
    Members: fakeSheet(sandbox.ZF_SCHEMA.Members.slice(0, -1)),
    Subscriptions: fakeSheet(sandbox.ZF_SCHEMA.Subscriptions.slice(0, -1)),
    Bookings: fakeSheet(sandbox.ZF_SCHEMA.Bookings.slice(0, -3)),
    Projects: fakeSheet(sandbox.ZF_SCHEMA.Projects.slice(0, -3)),
  };
  const workbook = {
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) { sheets[name] = fakeSheet(); return sheets[name]; },
  };
  sandbox.migrateGrowthSchema_(workbook);
  assert.deepEqual(JSON.parse(JSON.stringify(sheets.Members.headers)), JSON.parse(JSON.stringify(sandbox.ZF_SCHEMA.Members)));
  assert.deepEqual(JSON.parse(JSON.stringify(sheets.Subscriptions.headers)), JSON.parse(JSON.stringify(sandbox.ZF_SCHEMA.Subscriptions)));
  assert.deepEqual(JSON.parse(JSON.stringify(sheets.Bookings.headers)), JSON.parse(JSON.stringify(sandbox.ZF_SCHEMA.Bookings)));
  assert.deepEqual(JSON.parse(JSON.stringify(sheets.Projects.headers)), JSON.parse(JSON.stringify(sandbox.ZF_SCHEMA.Projects)));
  for (const name of ['Prospects', 'ContentItems', 'NewsletterPreferences', 'DailyDigests']) {
    assert.deepEqual(JSON.parse(JSON.stringify(sheets[name].headers)), JSON.parse(JSON.stringify(sandbox.ZF_SCHEMA[name])));
  }
});

test('prospect owner is immutable and member links reject attribution conflicts', () => {
  const created = sandbox.createProspectRecord_({
    displayName: '王小姐', contact: 'wang@example.com', channel: 'email', source: '投資講座',
    sourceEvidence: 'SOURCE-001', privacyEvidenceReference: 'CONSENT-001',
    privacyConsentedAt: '2026-08-18T00:00:00.000Z', privacyNoticeVersion: 'privacy-v1',
    owner: 'ref-1', status: 'new',
  }, 'prospect-1', 'batch-1', '2026-08-19T00:00:00.000Z', 'admin@example.com');
  assert.equal(created.acquisitionOwnerId, 'ref-1');
  assert.equal(created.email, 'wang@example.com');
  assert.equal(created.importedBy, 'admin@example.com');
  assert.throws(() => sandbox.patchProspectRecord_(created, {
    acquisitionOwnerId: 'ref-2',
  }, {}, [], '2026-08-19T01:00:00.000Z'), (error) => error.code === 'acquisition_owner_immutable');
  for (const patch of [
    { source: '另一來源' }, { sourceReference: 'SOURCE-CHANGED' },
    { privacyEvidenceReference: 'CONSENT-CHANGED' }, { privacyConsentedAt: '2026-08-19T02:00:00.000Z' },
    { privacyNoticeVersion: 'privacy-v2' },
  ]) {
    assert.throws(() => sandbox.patchProspectRecord_(created, patch, {}, [], '2026-08-19T01:00:00.000Z'), (error) => error.code === 'prospect_evidence_immutable');
  }
  assert.throws(() => sandbox.patchProspectRecord_(created, {
    linkMemberId: 'member-1',
  }, { 'member-1': { id: 'member-1', referralAttribution: { referrerId: 'ref-2', state: 'verified' } } }, [], '2026-08-19T01:00:00.000Z'), (error) => error.code === 'member_attribution_conflict');
});

test('prospect lifecycle, identity dedupe and acquisition performance stay independent from commission', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.ZF_PROSPECT_STATUSES)), ['new', 'contacted', 'qualified', 'converted', 'archived']);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizedProspectIdentityKeys_({ channel: 'phone', contact: '0912-345-678' }))), ['phone:0912345678']);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizedProspectIdentityKeys_({ channel: 'community', contact: 'lead@example.com' }))), ['email:lead@example.com']);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizedProspectIdentityKeys_({ channel: 'openchat', contact: '0912-345-678' }))), ['phone:0912345678']);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizedProspectIdentityKeys_({ channel: 'community', contact: 'OpenChat A', email: 'EXPLICIT@Example.com', phone: '0912 345 678' }))), ['email:explicit@example.com', 'phone:0912345678']);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.normalizedProspectIdentityKeys_({ channel: 'community', contact: 'OpenChat A' }))), []);
  const snapshot = sandbox.acquisitionSnapshotForMember_('member-1', [{
    id: 'prospect-1', linkedMemberId: 'member-1', acquisitionOwnerId: 'ref-expired', importedAt: '2025-01-01T00:00:00.000Z',
  }], '2026-08-19T00:00:00.000Z');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), {
    leadId: 'prospect-1', ownerReferrerId: 'ref-expired', capturedAt: '2026-08-19T00:00:00.000Z',
  });
  const expiredReferrer = { id: 'ref-expired', status: 'disabled', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2021-01-01T00:00:00.000Z' };
  const member = { referralAttribution: { state: 'verified', referrerId: 'ref-expired' } };
  assert.equal(sandbox.referralSnapshotForMember_(member, [expiredReferrer], '2026-08-19T00:00:00.000Z'), null);
  const subscription = sandbox.createSubscriptionRecord_({
    id: 's-attr', memberId: 'member-1', projectId: 'p-1', requestedAmountTwd: 500000,
    riskAcknowledged: true, riskAcknowledgedAt: '2026-08-19T00:00:00.000Z', riskDisclosureVersion: 'v1',
    referralSnapshot: null, acquisitionAttributionSnapshot: snapshot,
  }, '2026-08-19T00:00:00.000Z');
  assert.equal(subscription.commissionState, 'not_applicable');
  assert.equal(subscription.acquisitionAttributionSnapshot.ownerReferrerId, 'ref-expired');
  assert.doesNotMatch(JSON.stringify(sandbox.sanitizeSubscriptionForMember_(subscription)), /acquisitionAttribution|owner|referrer|commission/i);
});

test('linking a prospect freezes member lead owner and commission prioritizes that effective owner', () => {
  const originals = { find: sandbox.storeFindById_, list: sandbox.storeList_, put: sandbox.storePut_, audit: sandbox.appendAudit_, now: sandbox.nowIso_ };
  const prospect = {
    id: 'prospect-1', acquisitionOwnerId: 'ref-lead', linkedMemberId: '', status: 'qualified', sourceReference: 'SOURCE-1',
    createdAt: '2026-08-18T00:00:00.000Z', importedAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
  };
  const member = {
    id: 'member-1', referralAttribution: { referrerId: 'ref-other', referralCode: 'OTHER', state: 'claimed', claimedAt: '2026-08-18T00:00:00.000Z' },
    membershipState: 'active', qualificationState: 'not_applied', projectAccess: [],
  };
  const leadOwner = {
    id: 'ref-lead', code: 'LEAD', displayName: 'Lead Owner', status: 'active', defaultCommissionRateBps: 500,
    commissionBasis: 'allocated_amount', agreementReference: 'AGR-LEAD', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const otherOwner = { ...leadOwner, id: 'ref-other', code: 'OTHER', displayName: 'Other Owner', agreementReference: 'AGR-OTHER' };
  const saved = {};
  sandbox.storeFindById_ = (sheet, id) => sheet === 'Prospects' && id === prospect.id ? prospect : sheet === 'Members' && id === member.id ? member : null;
  sandbox.storeList_ = (sheet) => ({ Prospects: [prospect], Members: [member], Referrers: [leadOwner, otherOwner], Projects: [] }[sheet] || []);
  sandbox.storePut_ = (sheet, row) => { saved[sheet] = JSON.parse(JSON.stringify(row)); return row; };
  sandbox.appendAudit_ = () => {};
  sandbox.nowIso_ = () => '2026-08-19T00:00:00.000Z';
  try {
    sandbox.operationAdminPatchProspect_({ prospectId: 'prospect-1', patch: { linkMemberId: 'member-1' }, reason: '已核對會員身份' }, { role: 'admin', actorId: 'admin-1', requestId: 'link-1' });
    assert.deepEqual(saved.Members.leadOwnerAttribution, { leadId: 'prospect-1', referrerId: 'ref-lead', capturedAt: '2026-08-19T00:00:00.000Z' });
    assert.equal(saved.Members.referralAttribution.state, 'verified');
    assert.equal(saved.Members.referralAttribution.referrerId, 'ref-lead');
    const snapshot = sandbox.referralSnapshotForMember_(saved.Members, [leadOwner, otherOwner], '2026-08-19T00:00:00.000Z');
    assert.equal(snapshot.referrerId, 'ref-lead');
    assert.equal(snapshot.leadId, 'prospect-1');
    sandbox.storeFindById_ = (sheet, id) => sheet === 'Members' && id === member.id ? saved.Members : null;
    assert.throws(() => sandbox.operationAdminPatchMember_({ memberId: 'member-1', patch: { referralAttribution: { referrerId: 'ref-other', evidenceReference: 'OTHER-EVIDENCE' } }, reason: '嘗試更改' }, { role: 'admin', actorId: 'admin-1', requestId: 'member-1' }), (error) => error.code === 'lead_owner_attribution_conflict');
  } finally {
    sandbox.storeFindById_ = originals.find; sandbox.storeList_ = originals.list; sandbox.storePut_ = originals.put;
    sandbox.appendAudit_ = originals.audit; sandbox.nowIso_ = originals.now;
  }
});

test('lead import accepts rows and merges batch source plus privacy evidence with an audit reason', () => {
  const originals = { list: sandbox.storeList_, appendMany: sandbox.storeAppendMany_, audit: sandbox.appendAudit_ };
  const saved = [];
  const audits = [];
  sandbox.storeList_ = (sheet) => sheet === 'Referrers' ? [{
    id: 'ref-1', code: 'GROUP-A', status: 'active', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  }] : [];
  sandbox.storeAppendMany_ = (sheet, rows) => { if (sheet === 'Prospects') saved.push(...JSON.parse(JSON.stringify(rows))); return rows; };
  sandbox.appendAudit_ = (audit) => { audits.push(audit); return audit; };
  try {
    const result = sandbox.operationAdminImportProspects_({
      rows: [{ displayName: 'Lead', contact: 'lead@example.com', channel: 'email', source: '講座', owner: 'GROUP-A' }],
      sourceEvidence: 'ATTENDEE-001',
      privacyEvidence: { reference: 'CONSENT-001', consentedAt: '2026-08-18T00:00:00.000Z', noticeVersion: 'privacy-v1' },
      reason: 'consented CSV import',
    }, { role: 'admin', actorId: 'admin@example.com', requestId: 'req-import' });
    assert.equal(result.importedCount, 1);
    assert.equal(saved[0].sourceReference, 'ATTENDEE-001');
    assert.equal(saved[0].privacyEvidenceReference, 'CONSENT-001');
    assert.equal(saved[0].privacyNoticeVersion, 'privacy-v1');
    assert.equal(saved[0].importedBy, 'admin@example.com');
    assert.equal(audits[0].reason, 'consented CSV import');
    assert.throws(() => sandbox.operationAdminImportProspects_({ rows: [{}] }, { role: 'admin', actorId: 'admin' }), /reason/);
    assert.throws(() => sandbox.operationAdminImportProspects_({
      rows: [{ displayName: 'Converted', contact: 'converted@example.com', channel: 'email', source: 'event', owner: 'GROUP-A', status: 'converted' }],
      sourceEvidence: 'ATTENDEE-002',
      privacyEvidence: { reference: 'CONSENT-002', consentedAt: '2026-08-18T00:00:00.000Z', noticeVersion: 'privacy-v1' },
      reason: 'invalid converted batch',
    }, { role: 'admin', actorId: 'admin@example.com', requestId: 'req-converted' }), /linked member/i);
    assert.equal(saved.length, 1, 'invalid converted batch must remain atomic');
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storeAppendMany_ = originals.appendMany; sandbox.appendAudit_ = originals.audit;
  }
});

test('Apps accepts the Worker canonical lead adapter payload from the Pages form', () => {
  const originals = { list: sandbox.storeList_, append: sandbox.storeAppend_, audit: sandbox.appendAudit_, now: sandbox.nowIso_ };
  const saved = [];
  sandbox.storeList_ = (sheet) => sheet === 'Referrers' ? [{
    id: 'ref-1', code: 'GROUP-A', status: 'active', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
  }] : [];
  sandbox.storeAppend_ = (sheet, row) => { if (sheet === 'Prospects') saved.push(JSON.parse(JSON.stringify(row))); return row; };
  sandbox.appendAudit_ = () => {};
  sandbox.nowIso_ = () => '2026-08-19T00:00:00.000Z';
  try {
    const result = sandbox.operationAdminCreateProspect_({
      prospect: {
        displayName: 'Pages Lead', contact: 'pages@example.com', email: 'pages@example.com', channel: 'community',
        source: 'LINE 社群', sourceReference: 'OPENCHAT-001',
        privacyEvidence: { reference: 'CONSENT-001', consentedAt: '2026-08-19T00:00:00.000Z', noticeVersion: 'admin-evidence-v1' },
        acquisitionOwnerId: 'GROUP-A', status: 'new',
      },
      reason: 'Pages admin form',
    }, { role: 'admin', actorId: 'admin-1', requestId: 'worker-adapter-1' });
    assert.equal(result.prospect.acquisitionOwnerId, 'ref-1');
    assert.equal(result.prospect.channel, 'community');
    assert.equal(result.prospect.sourceReference, 'OPENCHAT-001');
    assert.equal(result.prospect.privacyEvidenceReference, 'CONSENT-001');
    assert.equal(saved.length, 1);
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storeAppend_ = originals.append;
    sandbox.appendAudit_ = originals.audit; sandbox.nowIso_ = originals.now;
  }
});

test('lead duplicates conflict across owners and batch writes remain provider-atomic', () => {
  const originals = {
    list: sandbox.storeList_, append: sandbox.storeAppend_, appendMany: sandbox.storeAppendMany_,
    audit: sandbox.appendAudit_, now: sandbox.nowIso_, id: sandbox.createId_,
  };
  const ownerA = { id: 'ref-a', code: 'A', status: 'active', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
  const ownerB = { id: 'ref-b', code: 'B', status: 'active', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
  const existing = {
    id: 'lead-existing', displayName: 'Existing', contact: 'same@example.com', email: 'same@example.com', channel: 'community',
    source: 'LINE', sourceReference: 'S-0', privacyEvidenceReference: 'P-0', privacyConsentedAt: '2026-08-18T00:00:00.000Z',
    privacyNoticeVersion: 'privacy-v1', acquisitionOwnerId: 'ref-a', linkedMemberId: '', status: 'new',
  };
  let appendCalls = 0;
  let auditCalls = 0;
  sandbox.storeList_ = (sheet) => ({ Prospects: [existing], Referrers: [ownerA, ownerB], Members: [] }[sheet] || []);
  sandbox.storeAppend_ = () => { appendCalls += 1; };
  sandbox.appendAudit_ = () => { auditCalls += 1; };
  sandbox.nowIso_ = () => '2026-08-19T00:00:00.000Z';
  try {
    assert.throws(() => sandbox.operationAdminCreateProspect_({
      prospect: {
        displayName: 'Conflict', contact: ' SAME@example.com ', channel: 'community', source: 'LINE', sourceReference: 'S-1',
        privacyEvidenceReference: 'P-1', privacyConsentedAt: '2026-08-18T00:00:00.000Z', privacyNoticeVersion: 'privacy-v1', owner: 'ref-b',
      }, reason: 'new owner claim',
    }, { role: 'admin', actorId: 'admin-1', requestId: 'conflict-1' }), (error) => error.code === 'prospect_owner_conflict');
    assert.equal(appendCalls, 0);

    sandbox.storeList_ = (sheet) => ({ Prospects: [], Referrers: [ownerA], Members: [] }[sheet] || []);
    sandbox.storeAppendMany_ = () => { throw new Error('provider write failed'); };
    assert.throws(() => sandbox.operationAdminImportProspects_({
      rows: [
        { displayName: 'One', contact: 'one@example.com', channel: 'email', source: 'event', owner: 'ref-a' },
        { displayName: 'Two', contact: '0912345678', channel: 'phone', source: 'event', owner: 'ref-a' },
      ],
      sourceEvidence: 'SOURCE-BATCH',
      privacyEvidence: { reference: 'PRIVACY-BATCH', consentedAt: '2026-08-18T00:00:00.000Z', noticeVersion: 'privacy-v1' },
      reason: 'atomic import',
    }, { role: 'admin', actorId: 'admin-1', requestId: 'atomic-1' }), /provider write failed/);
    assert.equal(appendCalls, 0, 'batch import must not fall back to row-by-row append');
    assert.equal(auditCalls, 0, 'failed provider write must not claim an imported audit');
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storeAppend_ = originals.append; sandbox.storeAppendMany_ = originals.appendMany;
    sandbox.appendAudit_ = originals.audit; sandbox.nowIso_ = originals.now; sandbox.createId_ = originals.id;
  }
});

test('single lead creation validates member linking before appending any row', () => {
  const originals = { list: sandbox.storeList_, append: sandbox.storeAppend_, put: sandbox.storePut_, audit: sandbox.appendAudit_, now: sandbox.nowIso_ };
  const owner = { id: 'ref-lead', code: 'LEAD', status: 'active', effectiveAt: '2020-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' };
  const member = { id: 'member-1', referralAttribution: { state: 'verified', referrerId: 'ref-other' } };
  let appended = 0;
  sandbox.storeList_ = (sheet) => ({ Prospects: [], Referrers: [owner], Members: [member] }[sheet] || []);
  sandbox.storeAppend_ = () => { appended += 1; };
  sandbox.appendAudit_ = () => {};
  sandbox.nowIso_ = () => '2026-08-19T00:00:00.000Z';
  try {
    assert.throws(() => sandbox.operationAdminCreateProspect_({ prospect: {
      displayName: 'Lead', contact: 'lead@example.com', channel: 'email', source: 'event', sourceReference: 'S-1',
      privacyEvidenceReference: 'P-1', privacyConsentedAt: '2026-08-18T00:00:00.000Z', privacyNoticeVersion: 'privacy-v1',
      acquisitionOwnerId: 'ref-lead', linkMemberId: 'member-1',
    }, reason: 'link member' }, { role: 'admin', actorId: 'admin-1', requestId: 'single-1' }), (error) => error.code === 'member_attribution_conflict');
    assert.equal(appended, 0, 'link validation failure must not leave an orphan prospect');
    const claimedMember = { id: 'member-1', referralAttribution: { state: 'claimed', referrerId: 'ref-other' } };
    sandbox.storeList_ = (sheet) => ({ Prospects: [], Referrers: [owner], Members: [claimedMember] }[sheet] || []);
    sandbox.storePut_ = () => { throw new Error('member provider failed'); };
    assert.throws(() => sandbox.operationAdminCreateProspect_({ prospect: {
      displayName: 'Lead two', contact: 'lead-two@example.com', channel: 'email', source: 'event', sourceReference: 'S-2',
      privacyEvidenceReference: 'P-2', privacyConsentedAt: '2026-08-18T00:00:00.000Z', privacyNoticeVersion: 'privacy-v1',
      acquisitionOwnerId: 'ref-lead', linkMemberId: 'member-1',
    }, reason: 'link member provider failure' }, { role: 'admin', actorId: 'admin-1', requestId: 'single-2' }), /member provider failed/);
    assert.equal(appended, 0, 'member persistence must succeed before the prospect append');
    const memberWrites = [];
    sandbox.storePut_ = (_sheet, row) => { memberWrites.push(JSON.parse(JSON.stringify(row))); return row; };
    sandbox.storeAppend_ = () => { appended += 1; throw new Error('prospect append failed'); };
    assert.throws(() => sandbox.operationAdminCreateProspect_({ prospect: {
      displayName: 'Lead three', contact: 'lead-three@example.com', channel: 'email', source: 'event', sourceReference: 'S-3',
      privacyEvidenceReference: 'P-3', privacyConsentedAt: '2026-08-18T00:00:00.000Z', privacyNoticeVersion: 'privacy-v1',
      acquisitionOwnerId: 'ref-lead', linkMemberId: 'member-1',
    }, reason: 'append rollback' }, { role: 'admin', actorId: 'admin-1', requestId: 'single-3' }), /prospect append failed/);
    assert.equal(memberWrites.length, 2, 'failed prospect append must restore the original member row');
    assert.deepEqual(memberWrites[1], claimedMember);
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storeAppend_ = originals.append;
    sandbox.storePut_ = originals.put; sandbox.appendAudit_ = originals.audit; sandbox.nowIso_ = originals.now;
  }
});

test('a converted prospect can only be created by linking an audited member', () => {
  assert.throws(() => sandbox.createProspectRecord_({
    displayName: 'Lead', contact: 'lead@example.com', email: 'lead@example.com', channel: 'email', source: 'event',
    sourceReference: 'SOURCE-1', privacyEvidenceReference: 'PRIVACY-1',
    privacyConsentedAt: '2026-08-18T00:00:00.000Z', privacyNoticeVersion: 'privacy-v1',
    acquisitionOwnerId: 'ref-1', status: 'converted',
  }, 'lead-1', 'batch-1', '2026-08-19T00:00:00.000Z', 'admin-1'), /linked member/i);
  const linked = sandbox.createProspectRecord_({
    displayName: 'Linked', contact: 'linked@example.com', email: 'linked@example.com', channel: 'email', source: 'event',
    sourceReference: 'SOURCE-2', privacyEvidenceReference: 'PRIVACY-2',
    privacyConsentedAt: '2026-08-18T00:00:00.000Z', privacyNoticeVersion: 'privacy-v1',
    acquisitionOwnerId: 'ref-1', linkedMemberId: 'member-1', status: 'converted',
  }, 'lead-2', 'batch-1', '2026-08-19T00:00:00.000Z', 'admin-1');
  assert.equal(Boolean(linked.linkedMemberId), linked.status === 'converted');
  assert.throws(() => sandbox.patchProspectRecord_(linked, { status: 'qualified' }, {
    'member-1': { id: 'member-1' },
  }, [linked], '2026-08-19T01:00:00.000Z'), /converted status/i);
});

test('lead CSV v1 uses the canonical 18 columns and acquisition performance totals', () => {
  const lead = {
    id: 'lead-1', displayName: '王小姐', phone: '0912345678', email: 'wang@example.com', channel: 'email',
    sourceReference: 'SOURCE-1', privacyEvidenceReference: 'PRIVACY-1', privacyConsentedAt: '2026-08-18T00:00:00.000Z',
    privacyNoticeVersion: 'privacy-v1', acquisitionOwnerId: 'ref-1', linkedMemberId: 'member-1', status: 'converted',
    importedBy: 'admin-1', importedAt: '2026-08-18T00:00:00.000Z',
  };
  const subscriptions = [
    { acquisitionAttributionSnapshot: { leadId: 'lead-1', ownerReferrerId: 'ref-1' }, requestedAmountTwd: 500000, allocatedAmountTwd: 300000 },
    { acquisitionAttributionSnapshot: { leadId: 'lead-other', ownerReferrerId: 'ref-1' }, requestedAmountTwd: 999999, allocatedAmountTwd: 999999 },
  ];
  const csv = sandbox.prospectRecordsToCsv_([lead], subscriptions).replace(/^\uFEFF/, '');
  const [header, row] = csv.split('\r\n');
  assert.equal(header, [
    'schemaVersion', 'id', 'displayName', 'phone', 'email', 'channel', 'sourceReference',
    'privacyEvidenceReference', 'privacyConsentedAt', 'privacyNoticeVersion', 'ownerReferrerId',
    'memberId', 'status', 'importedBy', 'importedAt', 'subscriptionCount',
    'attributableRequestedAmountTwd', 'attributableAllocatedAmountTwd',
  ].map((field) => `"${field}"`).join(','));
  assert.match(row, /^"lead-export-v1","lead-1"/);
  assert.match(row, /,"1","500000","300000"$/);
  assert.doesNotMatch(header, /acquisitionOwnerId|linkedMemberId|investmentPreferencesJson/);
});

test('Apps CSV exports neutralize spreadsheet formulas after spaces or tabs', () => {
  for (const value of ['=1+1', '+SUM(A1:A2)', '-10+20', '@cmd', '  =HYPERLINK("https://evil.example")', '\t+1']) {
    const cell = sandbox.csvEscape_(value);
    assert.ok(cell.startsWith('"\''), `formula-like cell must be prefixed as text: ${value}`);
  }
  assert.equal(sandbox.csvEscape_('ordinary'), '"ordinary"');
  const csv = sandbox.prospectRecordsToCsv_([{
    id: 'lead-formula', displayName: ' =CMD()', phone: '', email: '', channel: 'other', sourceReference: '@source',
    privacyEvidenceReference: '+privacy', acquisitionOwnerId: 'ref-1', status: 'new',
  }], []);
  assert.doesNotMatch(csv, /,"\s*[=+\-@]/, 'no exported cell may begin with a formula trigger after whitespace');
});

test('admin dashboard reports requested and allocated acquisition performance separately', () => {
  const originals = { list: sandbox.storeList_ };
  sandbox.storeList_ = (sheet) => sheet === 'Subscriptions' ? [{
    id: 's-1', memberId: 'm-1', projectId: 'p-1', acquisitionAttributionSnapshot: { leadId: 'lead-1', ownerReferrerId: 'ref-1' },
    requestedAmountTwd: 500000, approvedAmountTwd: 400000, receivedAmountTwd: 350000,
    allocatedAmountTwd: 300000, refundedAmountTwd: 0, subscriptionState: 'approved', fundingState: 'paid', allocationState: 'partial',
  }] : [];
  try {
    const dashboard = sandbox.operationAdminDashboard_({}, { role: 'admin' });
    assert.equal(dashboard.kpis.attributableRequestedAmountTwd, 500000);
    assert.equal(dashboard.kpis.attributableAllocatedAmountTwd, 300000);
    assert.equal(dashboard.kpis.acquisitionAttributedAllocatedAmountTwd, 300000);
  } finally { sandbox.storeList_ = originals.list; }
});

test('newsletter preferences keep consent separate and require deliverable identities', () => {
  const member = { id: 'm-1', lineUserId: 'U1', email: 'member@example.com' };
  const preference = sandbox.normalizeNewsletterPreference_({
    dailyDigestConsent: true, marketingConsent: false, lineDeliveryConsent: true,
    emailDeliveryConsent: true, deliveryChannels: ['line', 'email'],
  }, member, '2026-08-19T00:00:00.000Z');
  assert.deepEqual(JSON.parse(JSON.stringify(preference.deliveryChannels)), ['in_app', 'line', 'email']);
  assert.equal(preference.marketingConsent, false);
  assert.equal(preference.emailDeliveryConsent, true);
  assert.equal(preference.lineDeliveryConsent, true);
  assert.throws(() => sandbox.normalizeNewsletterPreference_({
    dailyDigestConsent: true, marketingConsent: false, lineDeliveryConsent: true, deliveryChannels: ['line'],
  }, { id: 'm-2', lineUserId: '', email: '' }, '2026-08-19T00:00:00.000Z'), (error) => error.code === 'delivery_identity_missing');
  assert.throws(() => sandbox.normalizeNewsletterPreference_({
    dailyDigestConsent: false, marketingConsent: true, emailDeliveryConsent: true, deliveryChannels: ['email'],
  }, member, '2026-08-19T00:00:00.000Z'), (error) => error.code === 'daily_digest_consent_required');
  assert.throws(() => sandbox.normalizeNewsletterPreference_({
    dailyDigestConsent: true, marketingConsent: false, emailDeliveryConsent: false, deliveryChannels: ['email'],
  }, member, '2026-08-19T00:00:00.000Z'), (error) => error.code === 'delivery_consent_required');
});

test('newsletter self-service uses server audit reason and withdrawal cancels queued daily LINE', () => {
  const originals = { list: sandbox.storeList_, put: sandbox.storePut_, find: sandbox.storeFindById_, audit: sandbox.appendAudit_, now: sandbox.nowIso_ };
  const member = { id: 'm-1', lineUserId: 'U1', email: 'm@example.com' };
  const preferences = [{ id: 'newsletter-m-1', memberId: 'm-1', dailyDigestConsent: true, marketingConsent: false, emailDeliveryConsent: false, lineDeliveryConsent: true, deliveryChannels: ['in_app', 'line'], updatedAt: '2026-08-18T00:00:00.000Z' }];
  const notifications = [
    { id: 'n-digest', recipientMemberId: 'm-1', lineUserId: 'U1', eventType: 'daily_digest', state: 'queued' },
    { id: 'n-transaction', recipientMemberId: 'm-1', lineUserId: 'U1', eventType: 'booking_received', state: 'queued' },
  ];
  const audits = [];
  sandbox.storeList_ = (sheet) => ({ Members: [member], NewsletterPreferences: preferences, Notifications: notifications }[sheet] || []);
  sandbox.storeFindById_ = (sheet, id) => sheet === 'Members' && id === member.id ? member : null;
  sandbox.storePut_ = (sheet, row) => {
    const collection = sheet === 'NewsletterPreferences' ? preferences : notifications;
    const index = collection.findIndex((item) => item.id === row.id);
    if (index >= 0) collection[index] = JSON.parse(JSON.stringify(row)); else collection.push(JSON.parse(JSON.stringify(row)));
    return row;
  };
  sandbox.appendAudit_ = (audit) => audits.push(JSON.parse(JSON.stringify(audit)));
  sandbox.nowIso_ = () => '2026-08-19T00:00:00.000Z';
  try {
    const result = sandbox.operationPatchNewsletterPreferences_({ preferences: {
      dailyDigestConsent: false, marketingConsent: false, emailDeliveryConsent: false,
      lineDeliveryConsent: false, deliveryChannels: ['in_app'],
    } }, { role: 'member', memberId: 'm-1', actorId: 'm-1', requestId: 'prefs-1' });
    assert.equal(result.preference.dailyDigestConsent, false);
    assert.equal(notifications[0].state, 'cancelled_consent');
    assert.equal(notifications[1].state, 'queued');
    assert.ok(audits.some((audit) => audit.action === 'newsletter.preference_updated' && audit.reason === 'Member updated newsletter preferences'));
    assert.ok(audits.some((audit) => audit.action === 'notification.cancelled_consent'));
    const fetched = sandbox.operationGetNewsletterPreferences_({}, { role: 'member', memberId: 'm-1' });
    assert.equal(fetched.preference.memberId, 'm-1');
    assert.equal(fetched.emailAvailable, true);
    assert.equal(fetched.lineAvailable, true);
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storePut_ = originals.put; sandbox.storeFindById_ = originals.find;
    sandbox.appendAudit_ = originals.audit; sandbox.nowIso_ = originals.now;
  }
});

test('published content visibility and project matches are deterministic', () => {
  const items = [
    { id: 'c-draft', status: 'draft', visibility: 'member', publishedAt: '' },
    { id: 'c-public', status: 'published', visibility: 'public', publicSafe: true, riskNotice: '公開風險提示', publishedAt: '2026-08-18T00:00:00.000Z' },
    { id: 'c-future', status: 'published', visibility: 'public', publicSafe: true, riskNotice: '未來內容', publishedAt: '2099-08-18T00:00:00.000Z' },
    { id: 'c-no-risk', status: 'published', visibility: 'public', publicSafe: true, riskNotice: '', publishedAt: '2026-08-18T00:00:00.000Z' },
    { id: 'c-qualified', projectId: 'p-2', status: 'published', visibility: 'qualified', publicSafe: false, riskNotice: '專案風險提示', publishedAt: '2026-08-19T00:00:00.000Z' },
  ];
  const basic = { id: 'm-1', membershipState: 'active', qualificationState: 'not_applied', projectAccess: [] };
  assert.deepEqual(sandbox.visibleContentForMember_(items, basic, []).map((item) => item.id), ['c-public']);
  const qualified = { id: 'm-2', membershipState: 'active', qualificationState: 'approved', projectAccess: ['p-2'], investmentPreferences: { industries: ['半導體', '生技'], minimumTicketTwd: 100000, maximumTicketTwd: 1000000 }, qualificationApproval: { approvedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' } };
  const projects = [
    { id: 'p-2', displayName: 'B', industry: '半導體', stage: 'A', status: 'published', publishedAt: '2026-08-18T00:00:00.000Z', deadline: '2099-12-31', minimumAmountTwd: 500000, targetAmountTwd: 50000000, updatedAt: '2026-08-18T00:00:00.000Z', memberAllowlist: [] },
    { id: 'p-1', displayName: 'A', industry: '生技', stage: 'Seed', status: 'published', publishedAt: '2026-08-18T00:00:00.000Z', deadline: '2099-12-31', minimumAmountTwd: 500000, targetAmountTwd: 30000000, updatedAt: '2026-08-19T00:00:00.000Z', memberAllowlist: ['m-2'] },
    { id: 'p-draft', displayName: 'Draft', industry: '生技', status: 'draft', minimumAmountTwd: 500000, targetAmountTwd: 30000000, memberAllowlist: ['m-2'] },
    { id: 'p-withdrawn', displayName: 'Withdrawn', industry: '生技', status: 'published', withdrawnAt: '2026-08-18T00:00:00.000Z', minimumAmountTwd: 500000, targetAmountTwd: 30000000, memberAllowlist: ['m-2'] },
    { id: 'p-expired', displayName: 'Expired', industry: '生技', status: 'published', deadline: '2025-12-31', minimumAmountTwd: 500000, targetAmountTwd: 30000000, memberAllowlist: ['m-2'] },
    { id: 'p-no-status', displayName: 'No status', industry: '生技', publishedAt: '2026-08-18T00:00:00.000Z', deadline: '2099-12-31', minimumAmountTwd: 500000, targetAmountTwd: 30000000, memberAllowlist: ['m-2'] },
    { id: 'p-no-published-at', displayName: 'No published time', industry: '生技', status: 'published', deadline: '2099-12-31', minimumAmountTwd: 500000, targetAmountTwd: 30000000, memberAllowlist: ['m-2'] },
    { id: 'p-invalid-deadline', displayName: 'Invalid deadline', industry: '生技', status: 'published', publishedAt: '2026-08-18T00:00:00.000Z', deadline: '2026-02-31', minimumAmountTwd: 500000, targetAmountTwd: 30000000, memberAllowlist: ['m-2'] },
    { id: 'p-closed', displayName: 'Closed', industry: '生技', status: 'published', publishedAt: '2026-08-18T00:00:00.000Z', deadline: '2099-12-31', closedAt: '2026-08-19T00:00:00.000Z', minimumAmountTwd: 500000, targetAmountTwd: 30000000, memberAllowlist: ['m-2'] },
  ];
  assert.deepEqual(sandbox.visibleContentForMember_(items, qualified, projects).map((item) => item.id), ['c-qualified', 'c-public']);
  assert.deepEqual(sandbox.deterministicProjectMatches_(qualified, projects).map((match) => match.projectId), ['p-1', 'p-2']);
  assert.equal(sandbox.deterministicProjectMatches_(qualified, projects)[0].projectName, 'A');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.deterministicProjectMatches_(qualified, projects)[0].reasons)), [
    { code: 'industry_match', label: '符合產業偏好' },
    { code: 'ticket_range_match', label: '符合投資金額範圍' },
    { code: 'qualification_approved', label: '投資資格有效' },
    { code: 'project_access_granted', label: '已具專案存取權' },
  ]);
  assert.deepEqual(sandbox.visiblePublicContent_(items).map((item) => item.id), ['c-public']);
  const publicVideo = sandbox.normalizeContentRecord_({
    id: 'video-ui', type: 'video', title: '公開影音', url: 'https://example.com/video',
    status: 'published', publicSafe: true, riskNotice: '非投資建議',
  }, null, 'admin', '2026-08-19T00:00:00.000Z');
  assert.equal(publicVideo.visibility, 'public');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.visiblePublicContent_([publicVideo])[0])), {
    id: 'video-ui', type: 'video', title: '公開影音', summary: '', url: 'https://example.com/video',
    projectId: '', visibility: 'public', publishedAt: '2026-08-19T00:00:00.000Z',
    riskNotice: '非投資建議', status: 'published', publicSafe: true,
  });
  assert.throws(() => sandbox.normalizeContentRecord_({
    id: 'market', type: 'market_update', title: 'Market', url: 'https://example.com/market',
    status: 'draft', riskNotice: '非投資建議',
  }, null, 'admin', '2026-08-19T00:00:00.000Z'), /Invalid content type/);
  assert.throws(() => sandbox.normalizeContentRecord_({
    id: 'archived', type: 'article', title: 'Archived', url: 'https://example.com/archive',
    status: 'archived', riskNotice: '非投資建議',
  }, null, 'admin', '2026-08-19T00:00:00.000Z'), /Invalid content status/);
});

test('Apps Admin exposes only canonical content types and statuses', () => {
  const { html } = loadAdminHtmlScript();
  assert.doesNotMatch(html, /<option value="market_update">/);
  assert.doesNotMatch(html, /<option value="archived">封存<\/option>/);
  for (const value of ['video', 'article', 'project_update', 'draft', 'published']) {
    assert.match(html, new RegExp(`<option value="${value}">`));
  }
});

test('admin matches accepts leadId and returns canonical reason objects', () => {
  const originals = { list: sandbox.storeList_ };
  const lead = { id: 'lead-1', linkedMemberId: '', investmentPreferences: { industries: ['生技'], minimumTicketTwd: 500000, maximumTicketTwd: 1000000 } };
  sandbox.storeList_ = (sheet) => ({
    Prospects: [lead], Members: [], Subscriptions: [],
    Projects: [
      { id: 'project-live', displayName: 'Live Project', industry: '生技', status: 'published', publishedAt: '2026-01-01T00:00:00.000Z', deadline: '2027-12-31', minimumAmountTwd: 500000, targetAmountTwd: 5000000, memberAllowlist: [] },
      { id: 'project-draft', displayName: 'Draft Project', industry: '生技', status: 'draft', minimumAmountTwd: 500000, targetAmountTwd: 5000000, memberAllowlist: [] },
    ],
  }[sheet] || []);
  try {
    const result = sandbox.operationAdminListMatches_({ leadId: 'lead-1' }, { role: 'admin' });
    assert.equal(result.subjectType, 'lead');
    assert.equal(result.subjectId, 'lead-1');
    assert.deepEqual(result.matches.map((item) => item.projectId), ['project-live']);
    assert.equal(result.matches[0].projectName, 'Live Project');
    assert.ok(result.matches[0].reasons.every((reason) => reason.code && reason.label));
    const all = sandbox.operationAdminListMatches_({}, { role: 'admin' });
    assert.ok(Array.isArray(all.matches));
    assert.deepEqual(all.matches.map((item) => item.subjectId), ['lead-1']);
    assert.ok(Array.isArray(all.matches[0].matches));
  } finally { sandbox.storeList_ = originals.list; }
});

test('public-safe UI content payload defaults public and is returned by the public operation', () => {
  const originals = {
    list: sandbox.storeList_, append: sandbox.storeAppend_, find: sandbox.storeFindById_, audit: sandbox.appendAudit_, now: sandbox.nowIso_, id: sandbox.createId_,
  };
  const contentItems = [{
    id: 'unsafe-legacy', type: 'video', title: 'Unsafe', url: 'https://example.com/unsafe', visibility: 'public',
    status: 'published', publicSafe: false, publishedAt: '2026-08-18T00:00:00.000Z', riskNotice: '非投資建議',
  }];
  sandbox.storeList_ = (sheet) => sheet === 'ContentItems' ? contentItems : [];
  sandbox.storeAppend_ = (_sheet, row) => { contentItems.push(JSON.parse(JSON.stringify(row))); return row; };
  sandbox.storeFindById_ = () => null;
  sandbox.appendAudit_ = () => {};
  sandbox.nowIso_ = () => '2026-08-19T00:00:00.000Z';
  sandbox.createId_ = () => 'content-ui';
  try {
    const created = sandbox.operationAdminCreateContent_({
      content: {
        type: 'video', title: '公開影音', url: 'https://example.com/video', status: 'published',
        publicSafe: true, riskNotice: '非投資建議',
      },
      reason: '公開內容完成法遵審核',
    }, { role: 'admin', actorId: 'admin-1', requestId: 'request-1' });
    assert.equal(created.content.visibility, 'public');
    const publicFeed = sandbox.operationListPublicContent_({}, { role: 'visitor' });
    assert.deepEqual(publicFeed.content.map((item) => item.id), ['content-ui']);
    assert.equal(publicFeed.content[0].status, 'published');
    assert.equal(publicFeed.content[0].publicSafe, true);
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storeAppend_ = originals.append; sandbox.storeFindById_ = originals.find;
    sandbox.appendAudit_ = originals.audit; sandbox.nowIso_ = originals.now; sandbox.createId_ = originals.id;
  }
});

test('daily digest generation is Taipei-date idempotent and pushes no amount or PII', () => {
  const originals = {
    list: sandbox.storeList_, append: sandbox.storeAppend_, put: sandbox.storePut_, audit: sandbox.appendAudit_,
    notify: sandbox.enqueueNotification_, now: sandbox.nowIso_,
  };
  const rows = { DailyDigests: [], Notifications: [] };
  const members = [{
    id: 'm-1', displayName: 'Member', legalName: 'Secret Name', email: 'member@example.com', lineUserId: 'U1',
    membershipState: 'active', qualificationState: 'approved', projectAccess: ['p-1'],
    qualificationApproval: { approvedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
  }];
  const preferences = [{ memberId: 'm-1', dailyDigestConsent: true, marketingConsent: false, lineDeliveryConsent: true, emailDeliveryConsent: true, deliveryChannels: ['in_app', 'line', 'email'] }];
  sandbox.MailApp.sent.length = 0;
  sandbox.storeList_ = (sheet) => ({
    Members: members,
    NewsletterPreferences: preferences,
    DailyDigests: rows.DailyDigests,
    ContentItems: [{ id: 'c-1', title: '今日專案更新', status: 'published', visibility: 'public', publicSafe: true, publishedAt: '2026-08-19T00:00:00.000Z' }],
    Projects: [{ id: 'p-1', displayName: 'Project', industry: 'bio', stage: 'seed', updatedAt: '2026-08-19T00:00:00.000Z', memberAllowlist: [] }],
    Subscriptions: [{
      id: 's-1', memberId: 'm-1', projectId: 'p-1', subscriptionState: 'approved', fundingState: 'paid', allocationState: 'final',
      requestedAmountTwd: 999999, approvedAmountTwd: 900000, receivedAmountTwd: 800000,
      refundedAmountTwd: 50000, allocatedAmountTwd: 700000,
    }],
  }[sheet] || []);
  sandbox.storeAppend_ = (sheet, row) => { if (rows[sheet]) rows[sheet].push(JSON.parse(JSON.stringify(row))); return row; };
  sandbox.storePut_ = (sheet, row) => {
    if (!rows[sheet]) return row;
    const index = rows[sheet].findIndex((record) => record.id === row.id);
    if (index >= 0) rows[sheet][index] = JSON.parse(JSON.stringify(row));
    return row;
  };
  sandbox.appendAudit_ = () => {};
  sandbox.enqueueNotification_ = (input) => { rows.Notifications.push(input); return input; };
  sandbox.nowIso_ = () => '2026-08-19T00:30:00.000Z';
  try {
    const first = sandbox.generateDailyDigests_('2026-08-19', { type: 'system', id: 'test' }, 'req-1', 'daily test');
    const second = sandbox.generateDailyDigests_('2026-08-19', { type: 'system', id: 'test' }, 'req-2', 'daily test rerun');
    assert.equal(first.created, 1);
    assert.equal(second.created, 0);
    assert.equal(rows.DailyDigests.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(rows.DailyDigests[0].progress[0])), {
      subscriptionId: 's-1', projectId: 'p-1', subscriptionState: 'approved', fundingState: 'paid', allocationState: 'final',
      requestedAmountTwd: 999999, approvedAmountTwd: 900000, depositPaidAmountTwd: 800000,
      accountRecordedAmountTwd: 750000, allocatedAmountTwd: 700000, updatedAt: '',
    });
    assert.equal(rows.DailyDigests[0].deliveryState.email, 'submitted');
    assert.equal(rows.Notifications.length, 1);
    assert.equal(sandbox.MailApp.sent.length, 1);
    const outboundContent = JSON.stringify({
      lineEvent: rows.Notifications.map((item) => ({ eventType: item.eventType, deepLinkPath: item.deepLinkPath })),
      email: sandbox.MailApp.sent.map((item) => ({ subject: item.subject, body: item.body })),
    });
    assert.doesNotMatch(outboundContent, /999999|Secret Name|member@example\.com/);
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storeAppend_ = originals.append;
    sandbox.storePut_ = originals.put; sandbox.appendAudit_ = originals.audit;
    sandbox.enqueueNotification_ = originals.notify; sandbox.nowIso_ = originals.now;
  }
});

test('digest generation with send false creates in-app data without LINE or email', () => {
  const originals = {
    list: sandbox.storeList_, append: sandbox.storeAppend_, put: sandbox.storePut_, audit: sandbox.appendAudit_,
    notify: sandbox.enqueueNotification_, send: sandbox.MailApp.sendEmail,
  };
  const digests = [];
  let lineQueued = 0;
  let emails = 0;
  sandbox.storeList_ = (sheet) => ({
    Members: [{ id: 'm-1', membershipState: 'active', lineUserId: 'U1', email: 'member@example.com', projectAccess: [] }],
    NewsletterPreferences: [{ memberId: 'm-1', dailyDigestConsent: true, lineDeliveryConsent: true, emailDeliveryConsent: true, deliveryChannels: ['in_app', 'line', 'email'] }],
    DailyDigests: digests, ContentItems: [], Projects: [], Subscriptions: [],
  }[sheet] || []);
  sandbox.storeAppend_ = (_sheet, row) => { digests.push(JSON.parse(JSON.stringify(row))); return row; };
  sandbox.storePut_ = (_sheet, row) => { const index = digests.findIndex((item) => item.id === row.id); if (index >= 0) digests[index] = JSON.parse(JSON.stringify(row)); return row; };
  sandbox.appendAudit_ = () => {};
  sandbox.enqueueNotification_ = () => { lineQueued += 1; };
  sandbox.MailApp.sendEmail = () => { emails += 1; };
  try {
    const summary = sandbox.generateDailyDigests_('2026-08-19', { type: 'admin', id: 'admin-1' }, 'request-1', 'preview only', false);
    assert.equal(summary.created, 1);
    assert.equal(lineQueued, 0);
    assert.equal(emails, 0);
    assert.deepEqual(digests[0].deliveryState, { in_app: 'available' });
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storeAppend_ = originals.append; sandbox.storePut_ = originals.put;
    sandbox.appendAudit_ = originals.audit; sandbox.enqueueNotification_ = originals.notify; sandbox.MailApp.sendEmail = originals.send;
  }
});

test('digest today computes an in-app digest when the scheduler has not stored one', () => {
  const originals = { list: sandbox.storeList_ };
  const member = { id: 'm-1', membershipState: 'active', qualificationState: 'not_applied', projectAccess: [] };
  sandbox.storeList_ = (sheet) => ({
    Members: [member], DailyDigests: [], ContentItems: [], Projects: [],
    Subscriptions: [{ id: 's-1', memberId: 'm-1', projectId: 'p-1', subscriptionState: 'submitted', fundingState: 'unpaid', allocationState: 'pending', requestedAmountTwd: 500000, approvedAmountTwd: 0, receivedAmountTwd: 0, allocatedAmountTwd: 0, refundedAmountTwd: 0 }],
    NewsletterPreferences: [],
  }[sheet] || []);
  try {
    const result = sandbox.operationGetDailyDigest_({}, { role: 'member', memberId: 'm-1' });
    assert.equal(result.generated, false);
    assert.equal(result.digest.memberId, 'm-1');
    assert.equal(result.digest.progress[0].requestedAmountTwd, 500000);
    assert.deepEqual(JSON.parse(JSON.stringify(result.digest.deliveryState)), { in_app: 'available' });
  } finally { sandbox.storeList_ = originals.list; }
});

test('daily digest email quota defers safely and resumes without duplicate LINE or email', () => {
  const originals = {
    list: sandbox.storeList_, append: sandbox.storeAppend_, put: sandbox.storePut_, audit: sandbox.appendAudit_,
    notify: sandbox.enqueueNotification_, quota: sandbox.MailApp.getRemainingDailyQuota, send: sandbox.MailApp.sendEmail,
  };
  const members = ['m-1', 'm-2'].map((id) => ({ id, email: `${id}@example.com`, lineUserId: `U-${id}`, membershipState: 'active', qualificationState: 'not_applied', projectAccess: [] }));
  const preferences = members.map((member) => ({ memberId: member.id, dailyDigestConsent: true, marketingConsent: false, lineDeliveryConsent: true, emailDeliveryConsent: true, deliveryChannels: ['in_app', 'line', 'email'] }));
  const digests = [];
  const line = [];
  const email = [];
  let quota = 1;
  sandbox.MailApp.getRemainingDailyQuota = () => quota;
  sandbox.MailApp.sendEmail = (message) => email.push(message.to);
  sandbox.storeList_ = (sheet) => ({ Members: members, NewsletterPreferences: preferences, DailyDigests: digests, ContentItems: [], Projects: [], Subscriptions: [] }[sheet] || []);
  sandbox.storeAppend_ = (sheet, row) => { if (sheet === 'DailyDigests') digests.push(JSON.parse(JSON.stringify(row))); return row; };
  sandbox.storePut_ = (_sheet, row) => { const index = digests.findIndex((record) => record.id === row.id); if (index >= 0) digests[index] = JSON.parse(JSON.stringify(row)); return row; };
  sandbox.appendAudit_ = () => {};
  sandbox.enqueueNotification_ = (input) => { line.push(input.recipientMemberId); return input; };
  try {
    const first = sandbox.generateDailyDigests_('2026-08-19', { type: 'system', id: 'test' }, 'req-1', 'quota test');
    assert.equal(first.emailSubmitted, 1);
    assert.equal(first.emailDeferred, 1);
    assert.equal(line.length, 2);
    quota = 1;
    const resumed = sandbox.generateDailyDigests_('2026-08-19', { type: 'system', id: 'test' }, 'req-2', 'quota continuation');
    assert.equal(resumed.created, 0);
    assert.equal(resumed.emailSubmitted, 1);
    assert.equal(line.length, 2);
    assert.equal(email.length, 2);
  } finally {
    sandbox.storeList_ = originals.list; sandbox.storeAppend_ = originals.append; sandbox.storePut_ = originals.put;
    sandbox.appendAudit_ = originals.audit; sandbox.enqueueNotification_ = originals.notify;
    sandbox.MailApp.getRemainingDailyQuota = originals.quota; sandbox.MailApp.sendEmail = originals.send;
  }
});

test('daily Apps Script trigger reconciles to one and computes the Taipei date in code', () => {
  projectTriggers.length = 0;
  const first = sandbox.installDailyDigestTrigger();
  const second = sandbox.installDailyDigestTrigger();
  assert.equal(first.dailyDigestTriggerCreated, true);
  assert.equal(second.dailyDigestTriggerCreated, false);
  assert.equal(projectTriggers.filter((trigger) => trigger.getHandlerFunction() === 'runDailyDigestSchedule').length, 1);
  assert.equal(sandbox.taipeiDigestDate_(new Date()), '2026-08-19');
});

test('member growth serializers never disclose prospect owner referrer commission or PII', () => {
  const member = sandbox.sanitizeMemberForSelf_({
    id: 'm-1', displayName: 'Visible name', legalName: 'LEGAL SECRET', phone: '0900', email: 'secret@example.com',
    sourceGroup: 'OWNER SECRET', acquisitionOwnerId: 'ref-1', referralAttribution: { referrerId: 'ref-1' },
    commissionAccruedAmountTwd: 500, membershipState: 'active', qualificationState: 'approved', tier: 'free', projectAccess: [],
  });
  const serialized = JSON.stringify(member);
  assert.doesNotMatch(serialized, /LEGAL SECRET|0900|secret@example|OWNER SECRET|owner|referr|commission/i);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}\n${error.stack}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} Apps Script tests passed`);
if (failed) process.exit(1);
