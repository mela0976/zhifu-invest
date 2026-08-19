/**
 * Pure domain rules for 致富投資.
 *
 * Keep this file free of SpreadsheetApp/UrlFetchApp calls. The same rules are
 * exercised by the Node VM test harness before deployment to Apps Script.
 */

var ZF_STATES = Object.freeze({
  membership: ['pending', 'active', 'rejected', 'disabled'],
  qualification: ['not_applied', 'reviewing', 'needs_information', 'approved', 'rejected', 'expired'],
  subscription: ['draft', 'submitted', 'operations_confirmed', 'partner_review', 'approved', 'rejected', 'cancelled'],
  funding: ['unpaid', 'partial', 'paid', 'refunded'],
  allocation: ['pending', 'partial', 'final'],
  commission: ['not_applicable', 'pending', 'accrued', 'approved', 'paid', 'void']
});

var ZF_AMOUNT_FIELDS = Object.freeze([
  'requestedAmountTwd',
  'approvedAmountTwd',
  'receivedAmountTwd',
  'allocatedAmountTwd',
  'refundedAmountTwd'
]);

var ZF_REFERRER_STATUSES = Object.freeze(['active', 'disabled']);
var ZF_COMMISSION_BASIS = 'allocated_amount';

var ZF_TRANSITIONS = Object.freeze({
  membership: {
    pending: ['active', 'rejected'],
    active: ['disabled'],
    rejected: ['pending'],
    disabled: ['active']
  },
  qualification: {
    not_applied: ['reviewing'],
    reviewing: ['needs_information', 'approved', 'rejected'],
    needs_information: ['reviewing', 'approved', 'rejected'],
    approved: ['expired'],
    rejected: ['reviewing'],
    expired: ['reviewing']
  },
  subscription: {
    draft: ['submitted', 'cancelled'],
    submitted: ['operations_confirmed', 'cancelled'],
    operations_confirmed: ['partner_review', 'cancelled'],
    partner_review: ['approved', 'rejected', 'cancelled'],
    approved: ['cancelled'],
    rejected: ['submitted'],
    cancelled: []
  },
  funding: {
    unpaid: ['partial', 'paid'],
    partial: ['paid', 'refunded'],
    paid: ['refunded'],
    refunded: []
  },
  allocation: {
    pending: ['partial', 'final'],
    partial: ['final'],
    final: []
  },
  commission: {
    not_applicable: [],
    pending: ['accrued', 'void'],
    accrued: ['approved', 'void'],
    approved: ['paid', 'void'],
    paid: [],
    void: []
  }
});

function domainError_(message, code, status) {
  var error = new Error(message);
  error.name = 'DomainError';
  error.code = code || 'invalid_request';
  error.status = status || 400;
  return error;
}

function assertRequiredString_(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw domainError_(field + ' is required', 'validation_error');
  }
  var normalized = value.trim();
  if (normalized.length > (maxLength || 500)) {
    throw domainError_(field + ' is too long', 'validation_error');
  }
  return normalized;
}

function normalizeOptionalString_(value, maxLength) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') throw domainError_('Expected a string', 'validation_error');
  var normalized = value.trim();
  if (normalized.length > (maxLength || 2000)) {
    throw domainError_('Text is too long', 'validation_error');
  }
  return normalized;
}

function assertState_(workflow, state) {
  if (!ZF_STATES[workflow] || ZF_STATES[workflow].indexOf(state) === -1) {
    throw domainError_('Unknown ' + workflow + ' state: ' + state, 'invalid_state');
  }
}

function assertTransition_(workflow, fromState, toState) {
  assertState_(workflow, fromState);
  assertState_(workflow, toState);
  if (fromState === toState) return;
  if ((ZF_TRANSITIONS[workflow][fromState] || []).indexOf(toState) === -1) {
    throw domainError_(
      'Cannot move ' + workflow + ' from ' + fromState + ' to ' + toState,
      'invalid_transition',
      409
    );
  }
}

function normalizeTwd_(value, field) {
  var number = Number(value === null || value === undefined || value === '' ? 0 : value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw domainError_((field || 'amount') + ' must be a non-negative TWD integer', 'invalid_amount');
  }
  return number;
}

function normalizeReferralCode_(value) {
  var code = assertRequiredString_(value, 'referrer.code', 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(code)) {
    throw domainError_('code must be 2-64 uppercase letters, numbers, underscores or hyphens', 'invalid_referrer_code');
  }
  return code;
}

function normalizeCommissionRateBps_(value) {
  var number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 10000) {
    throw domainError_('defaultCommissionRateBps must be an integer from 0 to 10000', 'invalid_commission_rate');
  }
  return number;
}

function normalizeIsoTime_(value, field, required) {
  if (!required && (value === null || value === undefined || value === '')) return '';
  var normalized = assertRequiredString_(value, field, 60);
  var time = Date.parse(normalized);
  if (!Number.isFinite(time)) throw domainError_(field + ' must be a valid date-time', 'invalid_effective_period');
  return new Date(time).toISOString();
}

function validateReferrerPeriod_(effectiveAt, expiresAt) {
  var from = normalizeIsoTime_(effectiveAt, 'referrer.effectiveAt', true);
  var to = normalizeIsoTime_(expiresAt, 'referrer.expiresAt', false);
  if (to && Date.parse(to) <= Date.parse(from)) {
    throw domainError_('referrer.expiresAt must be after effectiveAt', 'invalid_referrer_period', 409);
  }
  return { effectiveAt: from, expiresAt: to || null };
}

function createReferrerRecord_(input, id, now) {
  var period = validateReferrerPeriod_(input.effectiveAt, input.expiresAt);
  var status = input.status || 'active';
  if (ZF_REFERRER_STATUSES.indexOf(status) === -1) {
    throw domainError_('status must be active or disabled', 'invalid_referrer_status');
  }
  if (input.commissionBasis !== ZF_COMMISSION_BASIS) {
    throw domainError_('commissionBasis must be allocated_amount', 'invalid_commission_basis');
  }
  var contactEmail = assertRequiredString_(input.contactEmail, 'referrer.contactEmail', 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw domainError_('contactEmail must be valid', 'invalid_referrer_email');
  }
  return {
    id: id,
    demo: Boolean(input.demo),
    code: normalizeReferralCode_(input.code),
    displayName: assertRequiredString_(input.displayName, 'referrer.displayName', 200),
    legalName: assertRequiredString_(input.legalName, 'referrer.legalName', 200),
    contactName: assertRequiredString_(input.contactName, 'referrer.contactName', 200),
    contactEmail: contactEmail,
    status: status,
    defaultCommissionRateBps: normalizeCommissionRateBps_(input.defaultCommissionRateBps),
    commissionBasis: ZF_COMMISSION_BASIS,
    agreementReference: assertRequiredString_(input.agreementReference, 'referrer.agreementReference', 200),
    effectiveAt: period.effectiveAt,
    expiresAt: period.expiresAt,
    createdAt: now,
    updatedAt: now
  };
}

function updateReferrerRecord_(current, patch, now) {
  var allowed = [
    'code', 'displayName', 'legalName', 'contactName', 'contactEmail', 'status',
    'defaultCommissionRateBps', 'commissionBasis', 'agreementReference', 'effectiveAt', 'expiresAt'
  ];
  Object.keys(patch || {}).forEach(function (field) {
    if (allowed.indexOf(field) === -1) {
      throw domainError_('Referrer field cannot be patched: ' + field, 'validation_error');
    }
  });
  var next = Object.assign({}, current, patch || {});
  var validated = createReferrerRecord_(next, current.id, current.createdAt);
  validated.demo = Boolean(current.demo);
  validated.updatedAt = now;
  return validated;
}

function isReferrerEffective_(referrer, at) {
  if (!referrer || referrer.status !== 'active') return false;
  var atMs = Date.parse(at || nowIso_());
  var fromMs = Date.parse(String(referrer.effectiveAt || ''));
  var toMs = referrer.expiresAt ? Date.parse(String(referrer.expiresAt)) : Infinity;
  return Number.isFinite(atMs) && Number.isFinite(fromMs) && (Number.isFinite(toMs) || toMs === Infinity) &&
    fromMs <= atMs && atMs < toMs;
}

function referralClaim_(referrer, claimedAt) {
  return {
    referrerId: referrer.id,
    referralCode: referrer.code,
    state: 'claimed',
    evidenceReference: null,
    claimedAt: normalizeIsoTime_(claimedAt, 'referral.claimedAt', true),
    verifiedAt: null,
    verifiedBy: null
  };
}

function verifyReferralAttribution_(currentAttribution, input, referrers, actor, now) {
  if (input === null) return null;
  if (!input || typeof input !== 'object') {
    throw domainError_('referralAttribution must contain admin evidence', 'referral_evidence_required', 409);
  }
  var referrerId = assertRequiredString_(input.referrerId, 'referralAttribution.referrerId', 100);
  var referrer = (referrers || []).filter(function (record) { return record.id === referrerId; })[0];
  if (!referrer) throw domainError_('Referrer record not found', 'referrer_not_found', 404);
  if (!isReferrerEffective_(referrer, now)) {
    throw domainError_('Referrer must be active and effective', 'referrer_not_effective', 409);
  }
  return {
    referrerId: referrer.id,
    referralCode: referrer.code,
    state: 'verified',
    evidenceReference: assertRequiredString_(input.evidenceReference, 'referralAttribution.evidenceReference', 200),
    claimedAt: currentAttribution && currentAttribution.referrerId === referrer.id ?
      currentAttribution.claimedAt || now : now,
    verifiedBy: assertRequiredString_(actor && actor.id, 'referralAttribution.verifiedBy', 200),
    verifiedAt: normalizeIsoTime_(now, 'referralAttribution.verifiedAt', true)
  };
}

function referralSnapshotForMember_(member, referrers, capturedAt) {
  var leadOwner = member && member.leadOwnerAttribution;
  var attribution = leadOwner ? { referrerId: leadOwner.referrerId, state: 'verified' } : member && member.referralAttribution;
  if (!attribution || (!leadOwner && attribution.state !== 'verified')) {
    return null;
  }
  var referrer = (referrers || []).filter(function (record) {
    return record.id === attribution.referrerId;
  })[0];
  if (!isReferrerEffective_(referrer, capturedAt)) return null;
  var snapshot = {
    referrerId: referrer.id,
    referrerName: referrer.displayName,
    referralCode: referrer.code,
    commissionRateBps: normalizeCommissionRateBps_(referrer.defaultCommissionRateBps),
    commissionBasis: ZF_COMMISSION_BASIS,
    agreementReference: referrer.agreementReference,
    capturedAt: normalizeIsoTime_(capturedAt, 'referralSnapshot.capturedAt', true)
  };
  if (leadOwner) {
    snapshot.leadId = leadOwner.leadId;
    snapshot.attributionSource = 'lead_owner';
  }
  return snapshot;
}

function calculateCommissionAmount_(allocatedAmountTwd, commissionRateBps) {
  var allocated = normalizeTwd_(allocatedAmountTwd, 'allocatedAmountTwd');
  var bps = normalizeCommissionRateBps_(commissionRateBps);
  // Split quotient and remainder so the intermediate product stays within
  // Number.MAX_SAFE_INTEGER even for a large but valid TWD ledger value.
  return Math.floor(allocated / 10000) * bps + Math.floor((allocated % 10000) * bps / 10000);
}

function initializeCommissionFields_(record, referralSnapshot, now) {
  record.referralSnapshot = referralSnapshot || null;
  record.commissionState = referralSnapshot ? 'pending' : 'not_applicable';
  record.commissionBasisAmountTwd = 0;
  record.commissionAccruedAmountTwd = 0;
  record.commissionApproval = null;
  record.commissionPayment = null;
  record.commissionVoidReason = null;
  return record;
}

function refreshCommissionAmount_(current, next, now) {
  var snapshot = next.referralSnapshot || null;
  var calculated = snapshot ? calculateCommissionAmount_(next.allocatedAmountTwd, snapshot.commissionRateBps) : 0;
  var currentState = current.commissionState || (snapshot ? 'pending' : 'not_applicable');
  var currentAmount = normalizeTwd_(current.commissionAccruedAmountTwd, 'commissionAccruedAmountTwd');
  if ((currentState === 'approved' || currentState === 'paid') && calculated !== currentAmount) {
    throw domainError_('Allocated amount cannot change an approved or paid commission', 'commission_amount_locked', 409);
  }
  next.commissionState = currentState;
  next.commissionApproval = current.commissionApproval || null;
  next.commissionPayment = current.commissionPayment || null;
  next.commissionVoidReason = current.commissionVoidReason || null;
  if (currentState === 'pending' || currentState === 'accrued') {
    next.commissionBasisAmountTwd = next.allocatedAmountTwd;
    next.commissionAccruedAmountTwd = calculated;
    if (currentState === 'pending' && next.allocationState === 'final' && next.allocatedAmountTwd > 0) {
      assertTransition_('commission', 'pending', 'accrued');
      next.commissionState = 'accrued';
    }
  } else {
    next.commissionBasisAmountTwd = normalizeTwd_(current.commissionBasisAmountTwd, 'commissionBasisAmountTwd');
    next.commissionAccruedAmountTwd = currentAmount;
  }
  return next;
}

function patchCommissionRecord_(current, input, actor, now) {
  var action = assertRequiredString_(input.action, 'action', 20);
  if (['approve', 'pay', 'void'].indexOf(action) === -1) {
    throw domainError_('action must be approve, pay or void', 'invalid_commission_action');
  }
  if (!normalizeOptionalString_(input.reason, 1000)) {
    throw domainError_('reason is required', 'commission_reason_required', 409);
  }
  var next = Object.assign({}, current);
  var actorId = normalizeOptionalString_(actor && actor.id, 200);
  if (!actorId) throw domainError_('Authenticated actor is required', 'commission_actor_required', 409);
  if (action === 'approve') {
    assertTransition_('commission', current.commissionState, 'approved');
    next.commissionState = 'approved';
    var approvalReference = normalizeOptionalString_(input.approvalReference, 200);
    if (!approvalReference) throw domainError_('approvalReference is required', 'commission_approval_required', 409);
    next.commissionApproval = {
      approvedBy: actorId,
      reference: approvalReference,
      approvedAt: now
    };
  } else if (action === 'pay') {
    assertTransition_('commission', current.commissionState, 'paid');
    if (!current.commissionApproval) {
      throw domainError_('Commission must be approved before payment', 'commission_approval_required', 409);
    }
    var payoutReference = normalizeOptionalString_(input.payoutReference, 200);
    if (!payoutReference) throw domainError_('payoutReference is required', 'commission_payment_required', 409);
    next.commissionState = 'paid';
    next.commissionPayment = {
      paidBy: actorId,
      reference: payoutReference,
      paidAt: now
    };
  } else {
    assertTransition_('commission', current.commissionState, 'void');
    var voidReason = normalizeOptionalString_(input.voidReason, 1000);
    if (!voidReason) throw domainError_('voidReason is required', 'commission_void_reason_required', 409);
    next.commissionState = 'void';
    next.commissionVoidReason = voidReason;
  }
  next.updatedAt = now;
  return next;
}

function validateAmounts_(record) {
  var values = {};
  ZF_AMOUNT_FIELDS.forEach(function (field) {
    values[field] = normalizeTwd_(record[field], field);
  });
  if (values.approvedAmountTwd > values.requestedAmountTwd) {
    throw domainError_('Approved amount cannot exceed requested amount', 'invalid_amounts', 409);
  }
  if (values.receivedAmountTwd > values.approvedAmountTwd) {
    throw domainError_('Received amount cannot exceed approved amount', 'invalid_amounts', 409);
  }
  if (values.refundedAmountTwd > values.receivedAmountTwd) {
    throw domainError_('Refunded amount cannot exceed received amount', 'invalid_amounts', 409);
  }
  if (values.allocatedAmountTwd > values.receivedAmountTwd - values.refundedAmountTwd) {
    throw domainError_('Allocated amount cannot exceed net received amount', 'invalid_amounts', 409);
  }
  return values;
}

function deriveFundingState_(amounts) {
  var values = validateAmounts_(amounts);
  if (values.refundedAmountTwd > 0 && values.refundedAmountTwd === values.receivedAmountTwd) return 'refunded';
  if (values.receivedAmountTwd === 0) return 'unpaid';
  if (values.receivedAmountTwd < values.approvedAmountTwd) return 'partial';
  return 'paid';
}

function deriveAllocationState_(amounts) {
  var values = validateAmounts_(amounts);
  var available = values.receivedAmountTwd - values.refundedAmountTwd;
  if (values.allocatedAmountTwd === 0) return 'pending';
  if (values.allocatedAmountTwd < available) return 'partial';
  return 'final';
}

function hasProjectAccess_(member, project) {
  if (!member || !project || member.membershipState !== 'active') return false;
  if (member.qualificationState !== 'approved') return false;
  var approval = member.qualificationApproval || {};
  var now = Date.now();
  var approvedAtMs = Date.parse(String(approval.approvedAt || ''));
  var expiryMs = Date.parse(String(approval.expiresAt || ''));
  if (!Number.isFinite(approvedAtMs) || approvedAtMs > now + 5 * 60 * 1000 ||
      !Number.isFinite(expiryMs) || expiryMs <= now || expiryMs <= approvedAtMs) return false;
  var direct = (member.projectAccess || []).indexOf(project.id) !== -1;
  var allowlisted = (project.memberAllowlist || []).indexOf(member.id) !== -1;
  return direct || allowlisted;
}

function publicProjectView_(project) {
  return {
    id: project.id,
    slug: project.slug,
    demo: Boolean(project.demo),
    publicVisibility: project.publicVisibility,
    displayName: project.displayName,
    industry: project.industry,
    stage: project.stage,
    region: project.region,
    summary: project.summary,
    highlights: project.highlights || [],
    videoUrl: project.videoUrl || '',
    updatedAt: project.updatedAt
  };
}

function protectedProjectView_(project) {
  var result = publicProjectView_(project);
  result.access = 'qualified';
  result.protected = {
    companyName: project.companyName,
    taxId: project.taxId,
    round: project.round,
    targetAmountTwd: normalizeTwd_(project.targetAmountTwd, 'targetAmountTwd'),
    minimumAmountTwd: normalizeTwd_(project.minimumAmountTwd, 'minimumAmountTwd'),
    incrementAmountTwd: normalizeTwd_(project.incrementAmountTwd, 'incrementAmountTwd'),
    deadline: project.deadline,
    valuationNote: project.valuationNote,
    useOfFunds: project.useOfFunds || [],
    teamSummary: project.teamSummary,
    financialSummary: project.financialSummary,
    risks: project.risks || [],
    reports: project.reports || [],
    deck: project.deck || null
  };
  return result;
}

function projectViewForActor_(project, member, role) {
  if (role === 'admin') return protectedProjectView_(project);
  return hasProjectAccess_(member, project) ? protectedProjectView_(project) : publicProjectView_(project);
}

function filterProjectsForActor_(projects, member, role) {
  return projects.map(function (project) {
    return projectViewForActor_(project, member, role);
  });
}

function assertRole_(context, allowedRoles) {
  var role = context && context.role ? context.role : 'visitor';
  if (allowedRoles.indexOf(role) === -1) {
    throw domainError_('This operation is not available for role ' + role, 'forbidden', 403);
  }
  if ((role === 'member' || role === 'qualified') && (!context || !context.memberId)) {
    throw domainError_('Member identity is not linked', 'identity_not_linked', 403);
  }
  return role;
}

function assertOwnMemberScope_(context, requestedMemberId) {
  var role = assertRole_(context, ['member', 'qualified', 'admin', 'service']);
  if ((role === 'member' || role === 'qualified') &&
      (!context.memberId || !requestedMemberId)) {
    throw domainError_('Member identity is not linked', 'identity_not_linked', 403);
  }
  if (role !== 'admin' && role !== 'service' && context.memberId !== requestedMemberId) {
    throw domainError_('Member records are private', 'forbidden', 403);
  }
}

function createSubscriptionRecord_(input, now) {
  var requestedAmountTwd = normalizeTwd_(input.requestedAmountTwd, 'requestedAmountTwd');
  if (requestedAmountTwd <= 0) {
    throw domainError_('requestedAmountTwd must be greater than zero', 'invalid_amount');
  }
  if (input.riskAcknowledged !== true || !input.riskAcknowledgedAt || !input.riskDisclosureVersion) {
    throw domainError_('Risk acknowledgement, timestamp and disclosure version are required', 'risk_acknowledgement_required', 409);
  }
  var record = initializeCommissionFields_({
    id: input.id,
    demo: Boolean(input.demo),
    memberId: input.memberId,
    projectId: input.projectId,
    membershipState: 'active',
    qualificationState: 'approved',
    subscriptionState: 'submitted',
    fundingState: 'unpaid',
    allocationState: 'pending',
    requestedAmountTwd: requestedAmountTwd,
    approvedAmountTwd: 0,
    receivedAmountTwd: 0,
    allocatedAmountTwd: 0,
    refundedAmountTwd: 0,
    riskAcknowledged: true,
    riskAcknowledgedAt: input.riskAcknowledgedAt,
    riskDisclosureVersion: input.riskDisclosureVersion,
    partnerApproval: null,
    createdAt: now,
    updatedAt: now
  }, input.referralSnapshot || null, now);
  record.acquisitionAttributionSnapshot = input.acquisitionAttributionSnapshot || null;
  return record;
}

function validatePartnerApproval_(approval) {
  if (!approval || !approval.approver || !approval.approvedAt || !approval.reference) {
    throw domainError_(
      'Partner approval requires approver, approvedAt and reference',
      'approval_required',
      409
    );
  }
  return {
    approver: assertRequiredString_(approval.approver, 'partnerApproval.approver', 200),
    approvedAt: assertRequiredString_(approval.approvedAt, 'partnerApproval.approvedAt', 60),
    reference: assertRequiredString_(approval.reference, 'partnerApproval.reference', 200)
  };
}

function updateSubscriptionRecord_(current, patch, now) {
  var next = Object.assign({}, current);
  ['subscription', 'funding', 'allocation'].forEach(function (workflow) {
    var field = workflow + 'State';
    if (patch[field] !== undefined) {
      assertTransition_(workflow, current[field], patch[field]);
      next[field] = patch[field];
    }
  });
  ZF_AMOUNT_FIELDS.forEach(function (field) {
    if (patch[field] !== undefined) next[field] = normalizeTwd_(patch[field], field);
  });
  var amounts = validateAmounts_(next);
  Object.assign(next, amounts);

  if (patch.partnerApproval !== undefined) {
    next.partnerApproval = validatePartnerApproval_(patch.partnerApproval);
  }
  if (next.subscriptionState === 'approved' && !next.partnerApproval) {
    throw domainError_('Partner approval evidence is required before approval', 'approval_required', 409);
  }

  // Funding/allocation are derived from the five amount ledgers. A supplied
  // state must agree with the ledger, so the dashboard can never drift.
  var fundingState = deriveFundingState_(next);
  var allocationState = deriveAllocationState_(next);
  if (patch.fundingState !== undefined && patch.fundingState !== fundingState) {
    throw domainError_('fundingState does not match the amount ledger', 'state_amount_mismatch', 409);
  }
  if (patch.allocationState !== undefined && patch.allocationState !== allocationState) {
    throw domainError_('allocationState does not match the amount ledger', 'state_amount_mismatch', 409);
  }
  // A derived state is still a workflow transition. Checking it here prevents
  // amount edits from silently reversing paid -> unpaid or final -> pending.
  assertTransition_('funding', current.fundingState, fundingState);
  assertTransition_('allocation', current.allocationState, allocationState);
  next.fundingState = fundingState;
  next.allocationState = allocationState;
  refreshCommissionAmount_(current, next, now);
  next.updatedAt = now;
  return next;
}

function sanitizeMemberForSelf_(member) {
  return {
    id: member.id,
    demo: Boolean(member.demo),
    displayName: member.displayName,
    lineFriendshipState: member.lineFriendshipState,
    membershipState: member.membershipState,
    qualificationState: member.qualificationState,
    qualificationApproval: member.qualificationApproval || null,
    tier: member.tier,
    projectAccess: member.projectAccess || [],
    investmentPreferences: member.investmentPreferences || null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt
  };
}

function sanitizeSubscriptionForMember_(record) {
  return {
    id: record.id,
    demo: Boolean(record.demo),
    memberId: record.memberId,
    projectId: record.projectId,
    membershipState: record.membershipState,
    qualificationState: record.qualificationState,
    subscriptionState: record.subscriptionState,
    fundingState: record.fundingState,
    allocationState: record.allocationState,
    requestedAmountTwd: normalizeTwd_(record.requestedAmountTwd, 'requestedAmountTwd'),
    approvedAmountTwd: normalizeTwd_(record.approvedAmountTwd, 'approvedAmountTwd'),
    receivedAmountTwd: normalizeTwd_(record.receivedAmountTwd, 'receivedAmountTwd'),
    allocatedAmountTwd: normalizeTwd_(record.allocatedAmountTwd, 'allocatedAmountTwd'),
    refundedAmountTwd: normalizeTwd_(record.refundedAmountTwd, 'refundedAmountTwd'),
    riskAcknowledged: Boolean(record.riskAcknowledged),
    riskAcknowledgedAt: record.riskAcknowledgedAt,
    riskDisclosureVersion: record.riskDisclosureVersion,
    partnerApproval: record.partnerApproval || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function assertQualificationEvidence_(state, approval, nowMs) {
  if (state !== 'approved') return null;
  if (!approval || !approval.approver || !approval.approvedAt || !approval.reference) {
    throw domainError_('Qualification approval evidence is required', 'approval_required', 409);
  }
  var now = nowMs === undefined ? Date.now() : nowMs;
  var approvedAt = assertRequiredString_(approval.approvedAt, 'qualificationApproval.approvedAt', 60);
  var approvedAtMs = Date.parse(approvedAt);
  if (!Number.isFinite(approvedAtMs) || approvedAtMs > now + 5 * 60 * 1000) {
    throw domainError_('Qualification approval time is invalid or in the future', 'invalid_qualification_approval_time', 409);
  }
  var expiresAt = assertRequiredString_(approval.expiresAt, 'qualificationApproval.expiresAt', 60);
  var expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now || expiresAtMs <= approvedAtMs) {
    throw domainError_('Qualification expiry must be a valid future date', 'invalid_qualification_expiry', 409);
  }
  return {
    approver: assertRequiredString_(approval.approver, 'qualificationApproval.approver', 200),
    approvedAt: new Date(approvedAtMs).toISOString(),
    reference: assertRequiredString_(approval.reference, 'qualificationApproval.reference', 200),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
}
