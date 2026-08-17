export const STATES = Object.freeze({
  membership: ['pending', 'active', 'rejected', 'disabled'],
  qualification: ['not_applied', 'reviewing', 'needs_information', 'approved', 'rejected', 'expired'],
  subscription: ['draft', 'submitted', 'operations_confirmed', 'partner_review', 'approved', 'rejected', 'cancelled'],
  funding: ['unpaid', 'partial', 'paid', 'refunded'],
  allocation: ['pending', 'partial', 'final'],
  commission: ['not_applicable', 'pending', 'accrued', 'approved', 'paid', 'void'],
});

export const REFERRER_STATUSES = Object.freeze(['active', 'disabled']);
export const REFERRAL_ATTRIBUTION_STATES = Object.freeze(['claimed', 'verified', 'rejected']);
export const COMMISSION_BASIS = 'allocated_amount';

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
  commission: {
    not_applicable: [],
    pending: ['accrued', 'void'],
    accrued: ['approved', 'void'],
    approved: ['paid', 'void'],
    paid: [],
    void: [],
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

export function normalizeCommissionRateBps(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000) {
    throw new DomainError('defaultCommissionRateBps must be an integer from 0 to 10000', 'invalid_commission_rate');
  }
  return number;
}

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new DomainError(`${field} is required`, 'missing_referrer_field');
  return text;
}

export function validateReferrer(input) {
  const effectiveAt = Date.parse(input.effectiveAt || '');
  const expiresAt = input.expiresAt == null || input.expiresAt === '' ? null : Date.parse(input.expiresAt);
  const status = String(input.status || '');
  const code = requiredText(input.code, 'code').toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(code)) {
    throw new DomainError('code must be 2-64 uppercase letters, numbers, underscores or hyphens', 'invalid_referrer_code');
  }
  if (!REFERRER_STATUSES.includes(status)) {
    throw new DomainError('status must be active or disabled', 'invalid_referrer_status');
  }
  if (input.commissionBasis !== COMMISSION_BASIS) {
    throw new DomainError(`commissionBasis must be ${COMMISSION_BASIS}`, 'invalid_commission_basis');
  }
  if (!Number.isFinite(effectiveAt) || (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= effectiveAt))) {
    throw new DomainError('effectiveAt must be valid and expiresAt must be later when provided', 'invalid_referrer_period');
  }
  const contactEmail = requiredText(input.contactEmail, 'contactEmail').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new DomainError('contactEmail must be valid', 'invalid_referrer_email');
  }
  return {
    code,
    displayName: requiredText(input.displayName, 'displayName'),
    legalName: requiredText(input.legalName, 'legalName'),
    contactName: requiredText(input.contactName, 'contactName'),
    contactEmail,
    status,
    defaultCommissionRateBps: normalizeCommissionRateBps(input.defaultCommissionRateBps),
    commissionBasis: COMMISSION_BASIS,
    agreementReference: requiredText(input.agreementReference, 'agreementReference'),
    effectiveAt: new Date(effectiveAt).toISOString(),
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  };
}

export function isReferrerEffective(referrer, now = new Date().toISOString()) {
  if (!referrer || referrer.status !== 'active') return false;
  const at = Date.parse(now);
  const effectiveAt = Date.parse(referrer.effectiveAt || '');
  const expiresAt = referrer.expiresAt == null ? null : Date.parse(referrer.expiresAt);
  return Number.isFinite(at) && Number.isFinite(effectiveAt) && effectiveAt <= at
    && (expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > at));
}

export function captureReferralSnapshot(member, referrers, now) {
  const attribution = member?.referralAttribution;
  if (!attribution || attribution.state !== 'verified') return null;
  const referrer = referrers.find((item) => item.id === attribution.referrerId);
  if (!isReferrerEffective(referrer, now)) return null;
  return {
    referrerId: referrer.id,
    referrerName: referrer.displayName,
    referralCode: referrer.code,
    commissionRateBps: referrer.defaultCommissionRateBps,
    commissionBasis: referrer.commissionBasis,
    agreementReference: referrer.agreementReference,
    capturedAt: now,
  };
}

export function calculateCommissionAmount(allocatedAmountTwd, commissionRateBps) {
  const amount = normalizeTwd(allocatedAmountTwd, 'allocatedAmountTwd');
  const rate = normalizeCommissionRateBps(commissionRateBps);
  return Number((BigInt(amount) * BigInt(rate)) / 10_000n);
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
  referralSnapshot = null,
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
    referralSnapshot: referralSnapshot ? structuredClone(referralSnapshot) : null,
    commissionState: referralSnapshot ? 'pending' : 'not_applicable',
    commissionBasisAmountTwd: 0,
    commissionAccruedAmountTwd: 0,
    commissionApproval: null,
    commissionPayment: null,
    commissionVoidReason: null,
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
  const currentCommissionState = current.commissionState || (current.referralSnapshot ? 'pending' : 'not_applicable');
  const currentCommissionAmount = Number(current.commissionAccruedAmountTwd || 0);
  const nextCommissionAmount = next.referralSnapshot
    ? calculateCommissionAmount(next.allocatedAmountTwd, next.referralSnapshot.commissionRateBps)
    : 0;
  if (['approved', 'paid'].includes(currentCommissionState) && nextCommissionAmount !== currentCommissionAmount) {
    throw new DomainError('Allocated amount cannot change an approved or paid commission', 'commission_amount_locked', 409);
  }
  next.commissionState = currentCommissionState;
  next.commissionApproval = current.commissionApproval || null;
  next.commissionPayment = current.commissionPayment || null;
  next.commissionVoidReason = current.commissionVoidReason || null;
  if (['pending', 'accrued'].includes(currentCommissionState)) {
    next.commissionBasisAmountTwd = next.allocatedAmountTwd;
    next.commissionAccruedAmountTwd = nextCommissionAmount;
    if (currentCommissionState === 'pending' && next.allocationState === 'final' && next.allocatedAmountTwd > 0) {
      next.commissionState = 'accrued';
    }
  } else {
    next.commissionBasisAmountTwd = current.commissionBasisAmountTwd || 0;
    next.commissionAccruedAmountTwd = currentCommissionAmount;
  }
  next.updatedAt = now;
  return next;
}

export function updateCommissionRecord(current, patch, now) {
  const from = current.commissionState || (current.referralSnapshot ? 'pending' : 'not_applicable');
  const action = String(patch.action || '');
  const reason = String(patch.reason || '').trim();
  const actorId = String(patch.actorId || '').trim();
  const targets = { approve: 'approved', pay: 'paid', void: 'void' };
  const to = targets[action];
  if (!to) throw new DomainError('action must be approve, pay or void', 'invalid_commission_action');
  if (!reason) throw new DomainError('reason is required', 'commission_reason_required', 409);
  if (!actorId) throw new DomainError('Authenticated actor is required', 'commission_actor_required', 409);
  assertTransition('commission', from, to);
  const next = { ...current, commissionState: to, updatedAt: now };
  if (to === 'approved') {
    const reference = String(patch.approvalReference || '').trim();
    if (!reference) throw new DomainError('approvalReference is required', 'commission_approval_required', 409);
    next.commissionApproval = { approvedBy: actorId, reference, approvedAt: now };
  }
  if (to === 'paid') {
    if (!current.commissionApproval) {
      throw new DomainError('Commission must be approved before payment', 'commission_approval_required', 409);
    }
    const reference = String(patch.payoutReference || '').trim();
    if (!reference) throw new DomainError('payoutReference is required', 'commission_payment_required', 409);
    next.commissionPayment = { paidBy: actorId, reference, paidAt: now };
  }
  if (to === 'void') {
    const voidReason = String(patch.voidReason || '').trim();
    if (!voidReason) throw new DomainError('voidReason is required', 'commission_void_reason_required', 409);
    next.commissionVoidReason = voidReason;
  }
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
