import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainError,
  assertTransition,
  calculateCommissionAmount,
  captureReferralSnapshot,
  canAccessProtectedProject,
  createSubscriptionRecord,
  deriveAllocationState,
  deriveFundingState,
  publicProject,
  updateCommissionRecord,
  updateSubscriptionRecord,
  validateReferrer,
  validateAmounts,
} from '../src/domain.js';
import { createSeedData } from '../src/seeds.js';

test('seed contains the agreed Demo volume and only clearly marked demo entities', () => {
  const data = createSeedData();
  assert.equal(data.projects.length, 6);
  assert.equal(data.members.length, 30);
  assert.equal(data.subscriptions.length, 25);
  assert.equal(data.referrers.length, 4);
  assert.ok([...data.projects, ...data.referrers, ...data.members, ...data.subscriptions].every((item) => item.demo === true));
  assert.equal(new Set(data.referrers.map((item) => item.code)).size, 4);
  assert.ok(data.subscriptions.every((item) => item.referralSnapshot && item.commissionState));
});

test('referrer rules use uppercase unique-ready codes, fixed basis and effective periods', () => {
  const valid = validateReferrer({
    code: 'alpha-01', displayName: 'Alpha', legalName: 'Alpha Ltd', contactName: 'Owner',
    contactEmail: 'OWNER@EXAMPLE.COM', status: 'active', defaultCommissionRateBps: 375,
    commissionBasis: 'allocated_amount', agreementReference: 'AGR-001',
    effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: null,
  });
  assert.equal(valid.code, 'ALPHA-01');
  assert.equal(valid.contactEmail, 'owner@example.com');
  assert.throws(() => validateReferrer({ ...valid, defaultCommissionRateBps: 10_001 }), /0 to 10000/);
  assert.throws(() => validateReferrer({ ...valid, commissionBasis: 'received_amount' }), /allocated_amount/);
  assert.throws(() => validateReferrer({ ...valid, expiresAt: valid.effectiveAt }), /later/);
});

test('verified attribution snapshots current referrer terms and exact commission floors', () => {
  const data = createSeedData();
  const member = data.members[0];
  const now = '2026-08-18T12:00:00.000Z';
  const snapshot = captureReferralSnapshot(member, data.referrers, now);
  assert.equal(snapshot.referrerId, member.referralAttribution.referrerId);
  assert.equal(snapshot.capturedAt, now);
  assert.equal(calculateCommissionAmount(333_333, 333), 11_099);
  assert.equal(captureReferralSnapshot({ ...member, referralAttribution: { ...member.referralAttribution, state: 'claimed' } }, data.referrers, now), null);
});

test('commission stays pending for partial allocation, accrues only at final, then locks the amount', () => {
  const now = '2026-08-18T12:00:00.000Z';
  const snapshot = {
    referrerId: 'ref-1', referrerName: 'Referrer', referralCode: 'REF-1', commissionRateBps: 333,
    commissionBasis: 'allocated_amount', agreementReference: 'AGR-1', capturedAt: now,
  };
  const submitted = createSubscriptionRecord({
    id: 'sub-commission', memberId: 'member-001', projectId: 'project-01', requestedAmountTwd: 1_000_000,
    riskAcknowledged: true, riskAcknowledgedAt: now, riskDisclosureVersion: 'v1', referralSnapshot: snapshot, now,
  });
  assert.throws(() => updateCommissionRecord(submitted, {
    action: 'approve', approvalReference: 'TOO-EARLY', actorId: 'admin-1', reason: 'Allocation not final',
  }, now), (error) => error instanceof DomainError && error.code === 'invalid_transition');
  const partial = updateSubscriptionRecord(submitted, {
    approvedAmountTwd: 1_000_000, receivedAmountTwd: 1_000_000, allocatedAmountTwd: 333_333,
  }, now);
  assert.equal(partial.allocationState, 'partial');
  assert.equal(partial.commissionState, 'pending');
  assert.equal(partial.commissionAccruedAmountTwd, 11_099);

  const final = updateSubscriptionRecord(partial, { allocatedAmountTwd: 1_000_000 }, now);
  assert.equal(final.allocationState, 'final');
  assert.equal(final.commissionState, 'accrued');
  assert.equal(final.commissionAccruedAmountTwd, 33_300);

  assert.throws(() => updateCommissionRecord(final, {
    action: 'approve', approvalReference: 'APP-1', actorId: 'admin-1', reason: '',
  }, now), (error) => error instanceof DomainError && error.code === 'commission_reason_required');
  const approved = updateCommissionRecord(final, {
    action: 'approve', approvalReference: 'APP-1', actorId: 'admin-1', reason: 'Finance approved',
  }, now);
  assert.deepEqual(approved.commissionApproval, { approvedBy: 'admin-1', reference: 'APP-1', approvedAt: now });
  assert.throws(() => updateSubscriptionRecord(approved, {
    requestedAmountTwd: 1_200_000, approvedAmountTwd: 1_200_000,
    receivedAmountTwd: 1_200_000, allocatedAmountTwd: 1_200_000,
  }, now), (error) => error instanceof DomainError && error.code === 'commission_amount_locked');
  const paid = updateCommissionRecord(approved, {
    action: 'pay', payoutReference: 'PAY-1', actorId: 'admin-1', reason: 'Paid by bank transfer',
  }, now);
  assert.equal(paid.commissionState, 'paid');
  assert.throws(() => updateCommissionRecord(paid, {
    action: 'void', voidReason: 'Reversed', actorId: 'admin-1', reason: 'Try void',
  }, now), (error) => error instanceof DomainError && error.code === 'invalid_transition');

  const voided = updateCommissionRecord(final, {
    action: 'void', voidReason: 'Deal withdrawn', actorId: 'admin-1', reason: 'Documented cancellation',
  }, now);
  const changedAfterVoid = updateSubscriptionRecord(voided, {
    requestedAmountTwd: 1_200_000, approvedAmountTwd: 1_200_000,
    receivedAmountTwd: 1_200_000, allocatedAmountTwd: 1_200_000,
  }, now);
  assert.equal(changedAfterVoid.commissionState, 'void');
  assert.equal(changedAfterVoid.commissionBasisAmountTwd, 1_000_000);
  assert.equal(changedAfterVoid.commissionAccruedAmountTwd, 33_300);
});

test('independent workflow transitions reject illegal shortcuts', () => {
  assert.doesNotThrow(() => assertTransition('membership', 'pending', 'active'));
  assert.throws(
    () => assertTransition('subscription', 'submitted', 'approved'),
    (error) => error instanceof DomainError && error.code === 'invalid_transition',
  );
  assert.throws(() => assertTransition('funding', 'unpaid', 'refunded'), DomainError);
});

test('five amount fields enforce the accounting invariants', () => {
  const amounts = validateAmounts({
    requestedAmountTwd: 1_000_000,
    approvedAmountTwd: 900_000,
    receivedAmountTwd: 700_000,
    allocatedAmountTwd: 600_000,
    refundedAmountTwd: 100_000,
  });
  assert.equal(deriveFundingState(amounts), 'partial');
  assert.equal(deriveAllocationState(amounts), 'final');
  assert.throws(() => validateAmounts({ ...amounts, allocatedAmountTwd: 600_001 }), /net received/);
  assert.throws(() => validateAmounts({ ...amounts, refundedAmountTwd: 700_001 }), /received/);
  assert.throws(() => validateAmounts({ ...amounts, requestedAmountTwd: 1.5 }), /integer/);
});

test('a qualified member also needs per-project access', () => {
  const data = createSeedData();
  const member = data.members[0];
  assert.equal(canAccessProtectedProject(member, data.projects[0]), true);
  const deniedProject = data.projects.find((project) => (
    !member.projectAccess.includes(project.id) && !project.memberAllowlist.includes(member.id)
  ));
  assert.ok(deniedProject);
  assert.equal(canAccessProtectedProject(member, deniedProject), false);
  assert.equal('protected' in publicProject(data.projects[0]), false);
  assert.equal(canAccessProtectedProject({
    ...member,
    qualificationApproval: { ...member.qualificationApproval, expiresAt: '2020-01-01T00:00:00.000Z' },
  }, data.projects[0]), false);
  assert.equal(canAccessProtectedProject({ ...member, qualificationApproval: null }, data.projects[0]), false);
});

test('partner evidence is mandatory before an interest can be approved', () => {
  const now = new Date().toISOString();
  const submitted = createSubscriptionRecord({
    id: 'sub-test', memberId: 'member-001', projectId: 'project-01', requestedAmountTwd: 500_000,
    riskAcknowledged: true, riskAcknowledgedAt: now, riskDisclosureVersion: 'test-v1', now,
  });
  const confirmed = updateSubscriptionRecord(submitted, { subscriptionState: 'operations_confirmed' }, now);
  const review = updateSubscriptionRecord(confirmed, { subscriptionState: 'partner_review' }, now);
  assert.throws(() => updateSubscriptionRecord(review, {
    subscriptionState: 'approved', approvedAmountTwd: 500_000,
  }, now), /Partner approval/);
  const approved = updateSubscriptionRecord(review, {
    subscriptionState: 'approved',
    approvedAmountTwd: 500_000,
    partnerApproval: { approver: 'Partner', approvedAt: now, reference: 'REF-1' },
  }, now);
  assert.equal(approved.subscriptionState, 'approved');
});

test('derived funding and allocation states cannot reverse through amount edits', () => {
  const now = new Date().toISOString();
  const paid = {
    id: 'sub-paid', memberId: 'member-001', projectId: 'project-01',
    subscriptionState: 'approved', fundingState: 'paid', allocationState: 'final',
    requestedAmountTwd: 500_000, approvedAmountTwd: 500_000, receivedAmountTwd: 500_000,
    allocatedAmountTwd: 500_000, refundedAmountTwd: 0,
    partnerApproval: { approver: 'Partner', approvedAt: now, reference: 'REF-PAID' },
  };
  assert.throws(
    () => updateSubscriptionRecord(paid, { receivedAmountTwd: 0, allocatedAmountTwd: 0 }, now),
    (error) => error instanceof DomainError && error.code === 'invalid_transition',
  );
});
