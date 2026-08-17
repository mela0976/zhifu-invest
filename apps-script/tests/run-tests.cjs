const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.gs'))) {
  new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}
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
  Utilities: {
    Charset: { UTF_8: 'UTF-8' },
    computeHmacSha256Signature(value, secret) {
      return [...crypto.createHmac('sha256', secret).update(value, 'utf8').digest()];
    },
    base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); },
  },
};
vm.createContext(sandbox);
for (const file of ['Domain.gs', 'Gateway.gs', 'Notifications.gs']) {
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

test('subscription state is independent and approval needs partner evidence', () => {
  const current = sandbox.createSubscriptionRecord_({
    id: 's-1', memberId: 'm-1', projectId: 'p-1', requestedAmountTwd: 1000000,
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

test('role and per-project rules never leak protected project fields', () => {
  const project = { id: 'p-1', slug: 'demo', demo: true, displayName: 'DEMO', publicVisibility: 'anonymous',
    industry: 'bio', stage: 'seed', region: 'TW', summary: 'public', highlights: [], updatedAt: 'now',
    companyName: 'SECRET COMPANY', targetAmountTwd: 100, minimumAmountTwd: 10, incrementAmountTwd: 10,
    memberAllowlist: ['m-2'], reports: [], risks: [], useOfFunds: [], deck: { id: 'd-1' } };
  const denied = { id: 'm-1', membershipState: 'active', qualificationState: 'approved', projectAccess: [] };
  const allowed = { id: 'm-1', membershipState: 'active', qualificationState: 'approved', projectAccess: ['p-1'] };
  assert.equal(sandbox.projectViewForActor_(project, denied, 'qualified').protected, undefined);
  assert.equal(sandbox.projectViewForActor_(project, allowed, 'qualified').protected.companyName, 'SECRET COMPANY');
  assert.throws(() => sandbox.assertOwnMemberScope_({ role: 'member', memberId: 'm-1' }, 'm-2'), /private/i);
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

test('every Worker Apps Script operation is registered by the Apps Script dispatcher', () => {
  const workerSource = [
    fs.readFileSync(path.resolve(root, '..', 'cloudflare', 'src', 'index.ts'), 'utf8'),
    fs.readFileSync(path.resolve(root, '..', 'cloudflare', 'src', 'auth.ts'), 'utf8'),
  ].join('\n');
  const operations = new Set([
    ...[...workerSource.matchAll(/operation:\s*'([A-Za-z][A-Za-z0-9.]*)'/g)].map((match) => match[1]),
    ...[...workerSource.matchAll(/callAppsScript(?:<[^>]+>)?\(env,\s*'([A-Za-z][A-Za-z0-9.]*)'/g)].map((match) => match[1]),
  ]);
  const dispatcher = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
  assert.ok(operations.size >= 15, 'expected to discover the Worker operation allowlist');
  for (const operation of operations) {
    const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(dispatcher, new RegExp(`(?:^|\\s|['"])${escaped}(?:['"])?\\s*:`), `missing Apps Script operation ${operation}`);
  }
});

test('the Apps Script admin dashboard inline JavaScript parses', () => {
  const html = fs.readFileSync(path.join(root, 'Admin.html'), 'utf8');
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
