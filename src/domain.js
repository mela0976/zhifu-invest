export const STATES = Object.freeze({
  membership: ['pending', 'active', 'rejected', 'disabled'],
  qualification: ['not_applied', 'reviewing', 'needs_information', 'approved', 'rejected', 'expired'],
  subscription: ['draft', 'submitted', 'operations_confirmed', 'partner_review', 'approved', 'rejected', 'cancelled'],
  funding: ['unpaid', 'partial', 'paid', 'refunded'],
  allocation: ['pending', 'partial', 'final'],
});

export const AMOUNT_FIELDS = Object.freeze([
  'requestedAmountTwd',
  'approvedAmountTwd',
  'receivedAmountTwd',
  'allocatedAmountTwd',
  'refundedAmountTwd',
]);

const TRANSITIONS = Object.freeze({
  membership: {
    pending: ['active', 'rejected'],
    active: ['disabled'],
    rejected: ['pending'],
    disabled: ['active'],
  },
  qualification: {
    not_applied: ['reviewing'],
    reviewing: ['needs_information', 'approved', 'rejected'],
    needs_information: ['reviewing', 'approved', 'rejected'],
    approved: ['expired'],
    rejected: ['reviewing'],
    expired: ['reviewing'],
  },
  subscription: {
    draft: ['submitted', 'cancelled'],
    submitted: ['operations_confirmed', 'cancelled'],
    operations_confirmed: ['partner_review', 'cancelled'],
    partner_review: ['approved', 'rejected', 'cancelled'],
    approved: ['cancelled'],
    rejected: ['submitted'],
    cancelled: [],
  },
  funding: {
    unpaid: ['partial', 'paid'],
    partial: ['paid', 'refunded'],
    paid: ['refunded'],
    refunded: [],
  },
  allocation: {
    pending: ['partial', 'final'],
    partial: ['final'],
    final: [],
  },
});

export class DomainError extends Error {
  constructor(message, code = 'invalid_request', status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function assertState(workflow, state) {
  if (!STATES[workflow]?.includes(state)) {
    throw new DomainError(`Unknown ${workflow} state: ${state}`, 'invalid_state');
  }
}

export function assertTransition(workflow, from, to) {
  assertState(workflow, from);
  assertState(workflow, to);
  if (from === to) return;
  if (!TRANSITIONS[workflow]?.[from]?.includes(to)) {
    throw new DomainError(
      `Cannot move ${workflow} from ${from} to ${to}`,
      'invalid_transition',
      409,
    );
  }
}

export function normalizeTwd(value, field = 'amount') {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new DomainError(`${field} must be a non-negative TWD integer`, 'invalid_amount');
  }
  return number;
}

export function validateAmounts(input) {
  const values = Object.fromEntries(
    AMOUNT_FIELDS.map((field) => [field, normalizeTwd(input[field], field)]),
  );

  if (values.approvedAmountTwd > values.requestedAmountTwd) {
    throw new DomainError('Approved amount cannot exceed requested amount', 'invalid_amounts', 409);
  }
  if (values.receivedAmountTwd > values.approvedAmountTwd) {
    throw new DomainError('Received amount cannot exceed approved amount', 'invalid_amounts', 409);
  }
  if (values.refundedAmountTwd > values.receivedAmountTwd) {
    throw new DomainError('Refunded amount cannot exceed received amount', 'invalid_amounts', 409);
  }
  if (values.allocatedAmountTwd > values.receivedAmountTwd - values.refundedAmountTwd) {
    throw new DomainError('Allocated amount cannot exceed net received amount', 'invalid_amounts', 409);
  }
  return values;
}

export function deriveFundingState(amounts) {
  const { receivedAmountTwd, approvedAmountTwd, refundedAmountTwd } = validateAmounts(amounts);
  if (refundedAmountTwd > 0 && refundedAmountTwd === receivedAmountTwd) return 'refunded';
  if (receivedAmountTwd === 0) return 'unpaid';
  if (receivedAmountTwd < approvedAmountTwd) return 'partial';
  return 'paid';
}

export function deriveAllocationState(amounts) {
  const { allocatedAmountTwd, receivedAmountTwd, refundedAmountTwd } = validateAmounts(amounts);
  const available = receivedAmountTwd - refundedAmountTwd;
  if (allocatedAmountTwd === 0) return 'pending';
  if (allocatedAmountTwd < available) return 'partial';
  return 'final';
}

export function canAccessProtectedProject(member, project) {
  if (!member || member.membershipState !== 'active') return false;
  if (member.qualificationState !== 'approved') return false;
  const qualificationExpiresAt = Date.parse(member.qualificationApproval?.expiresAt || '');
  if (!Number.isFinite(qualificationExpiresAt) || qualificationExpiresAt <= Date.now()) return false;
  const directAccess = member.projectAccess?.includes(project.id);
  const allowlisted = project.memberAllowlist?.includes(member.id);
  return Boolean(directAccess || allowlisted);
}

export function publicProject(project) {
  const { protected: _protected, memberAllowlist: _memberAllowlist, ...safe } = project;
  return safe;
}

export function memberProject(project, member) {
  const safe = publicProject(project);
  if (!canAccessProtectedProject(member, project)) return safe;
  return { ...safe, protected: project.protected, access: 'qualified' };
}

export function createSubscriptionRecord({
  id, memberId, projectId, requestedAmountTwd, riskAcknowledged, riskAcknowledgedAt, riskDisclosureVersion, now,
}) {
  if (riskAcknowledged !== true || !riskAcknowledgedAt || !riskDisclosureVersion) {
    throw new DomainError('Risk acknowledgement, timestamp and disclosure version are required', 'risk_acknowledgement_required', 409);
  }
  return {
    id,
    memberId,
    projectId,
    membershipState: 'active',
    qualificationState: 'approved',
    subscriptionState: 'submitted',
    fundingState: 'unpaid',
    allocationState: 'pending',
    requestedAmountTwd: normalizeTwd(requestedAmountTwd, 'requestedAmountTwd'),
    approvedAmountTwd: 0,
    receivedAmountTwd: 0,
    allocatedAmountTwd: 0,
    refundedAmountTwd: 0,
    riskAcknowledged: true,
    riskAcknowledgedAt,
    riskDisclosureVersion,
    partnerApproval: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateSubscriptionRecord(current, patch, now) {
  const next = { ...current };
  for (const workflow of ['subscription', 'funding', 'allocation']) {
    const field = `${workflow}State`;
    if (patch[field] !== undefined) {
      assertTransition(workflow, current[field], patch[field]);
      next[field] = patch[field];
    }
  }
  for (const field of AMOUNT_FIELDS) {
    if (patch[field] !== undefined) next[field] = normalizeTwd(patch[field], field);
  }
  Object.assign(next, validateAmounts(next));

  if (patch.partnerApproval !== undefined) {
    const approval = patch.partnerApproval;
    if (!approval?.approver || !approval?.approvedAt || !approval?.reference) {
      throw new DomainError('Partner approval requires approver, approvedAt and reference', 'approval_required');
    }
    next.partnerApproval = approval;
  }
  if (next.subscriptionState === 'approved' && !next.partnerApproval) {
    throw new DomainError('Partner approval evidence is required before approval', 'approval_required', 409);
  }
  const derivedFundingState = deriveFundingState(next);
  const derivedAllocationState = deriveAllocationState(next);
  if (patch.fundingState !== undefined && patch.fundingState !== derivedFundingState) {
    throw new DomainError('fundingState does not match the amount ledger', 'state_amount_mismatch', 409);
  }
  if (patch.allocationState !== undefined && patch.allocationState !== derivedAllocationState) {
    throw new DomainError('allocationState does not match the amount ledger', 'state_amount_mismatch', 409);
  }
  assertTransition('funding', current.fundingState, derivedFundingState);
  assertTransition('allocation', current.allocationState, derivedAllocationState);
  next.fundingState = derivedFundingState;
  next.allocationState = derivedAllocationState;
  next.updatedAt = now;
  return next;
}

export function redactMember(member) {
  const tail = member.phone?.slice(-3) ?? '';
  return {
    id: member.id,
    displayName: member.displayName,
    legalName: member.legalName || '',
    phoneMasked: tail ? `09**-***-${tail}` : '',
    membershipState: member.membershipState,
    qualificationState: member.qualificationState,
    lineFriendshipState: member.lineFriendshipState,
    tier: member.tier,
  };
}
