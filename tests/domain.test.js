import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainError,
  assertTransition,
  canAccessProtectedProject,
  createSubscriptionRecord,
  deriveAllocationState,
  deriveFundingState,
  publicProject,
  updateSubscriptionRecord,
  validateAmounts,
} from '../src/domain.js';
import { createSeedData } from '../src/seeds.js';

test('seed contains the agreed Demo volume and only clearly marked demo entities', () => {
  const data = createSeedData();
  assert.equal(data.projects.length, 6);
  assert.equal(data.members.length, 30);
  assert.equal(data.subscriptions.length, 25);
  assert.ok([...data.projects, ...data.members, ...data.subscriptions].every((item) => item.demo === true));
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
