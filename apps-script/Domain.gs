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
  allocation: ['pending', 'partial', 'final']
});

var ZF_AMOUNT_FIELDS = Object.freeze([
  'requestedAmountTwd',
  'approvedAmountTwd',
  'receivedAmountTwd',
  'allocatedAmountTwd',
  'refundedAmountTwd'
]);

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
  return {
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
  };
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
  next.updatedAt = now;
  return next;
}

function sanitizeMemberForSelf_(member) {
  return {
    id: member.id,
    demo: Boolean(member.demo),
    displayName: member.displayName,
    legalName: member.legalName || '',
    phone: member.phone,
    email: member.email,
    lineFriendshipState: member.lineFriendshipState,
    sourceGroup: member.sourceGroup,
    membershipState: member.membershipState,
    qualificationState: member.qualificationState,
    qualificationApproval: member.qualificationApproval || null,
    tier: member.tier,
    projectAccess: member.projectAccess || [],
    createdAt: member.createdAt,
    updatedAt: member.updatedAt
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
