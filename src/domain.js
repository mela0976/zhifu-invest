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
export const LEAD_STATUSES = Object.freeze(['new', 'contacted', 'qualified', 'converted', 'archived']);
export const CONTENT_TYPES = Object.freeze(['video', 'article', 'project_update']);
export const CONTENT_STATUSES = Object.freeze(['draft', 'published']);
export const CONTENT_VISIBILITIES = Object.freeze(['public', 'member', 'qualified']);
export const DIGEST_DELIVERY_CHANNELS = Object.freeze(['in_app', 'email', 'line']);

export function taipeiDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new DomainError('Invalid date', 'invalid_date');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

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

function requiredText(value, field, code = 'missing_referrer_field') {
  const text = String(value ?? '').trim();
  if (!text) throw new DomainError(`${field} is required`, code);
  return text;
}

function optionalText(value, field, maxLength = 500) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) {
    throw new DomainError(`${field} exceeds ${maxLength} characters`, 'field_too_long');
  }
  return text;
}

function validIsoTimestamp(value, field) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) throw new DomainError(`${field} must be a valid timestamp`, 'invalid_timestamp');
  return new Date(timestamp).toISOString();
}

export function normalizePrivacyEvidence(value, now = new Date().toISOString()) {
  const evidence = typeof value === 'string' ? { reference: value } : (value || {});
  const reference = requiredText(
    evidence.reference || evidence.evidenceReference || evidence.sourceEvidence,
    'privacyEvidence.reference',
    'lead_privacy_evidence_required',
  );
  const consentedAtInput = evidence.consentedAt || evidence.capturedAt || evidence.recordedAt;
  const consentedAt = consentedAtInput ? validIsoTimestamp(consentedAtInput, 'privacyEvidence.consentedAt') : now;
  if (Date.parse(consentedAt) > Date.parse(now) + 5 * 60 * 1000) {
    throw new DomainError('privacyEvidence.consentedAt cannot be in the future', 'invalid_privacy_evidence', 409);
  }
  return {
    reference,
    consentedAt,
    noticeVersion: optionalText(evidence.noticeVersion || evidence.privacyNoticeVersion, 'privacyEvidence.noticeVersion', 120) || null,
  };
}

export function normalizeInvestmentPreferences(value = {}) {
  const input = value || {};
  const industriesInput = input.industries ?? input.industryPreferences ?? input.industryPreference ?? [];
  const industries = [...new Set((Array.isArray(industriesInput) ? industriesInput : [industriesInput])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  const range = input.ticketRange || {};
  const ticketMinTwd = normalizeTwd(
    input.ticketMinTwd ?? input.minimumTicketTwd ?? range.minTwd ?? range.min ?? 0,
    'ticketMinTwd',
  );
  const maxInput = input.ticketMaxTwd ?? input.maximumTicketTwd ?? range.maxTwd ?? range.max;
  const ticketMaxTwd = maxInput == null || maxInput === ''
    ? Number.MAX_SAFE_INTEGER
    : normalizeTwd(maxInput, 'ticketMaxTwd');
  if (ticketMaxTwd < ticketMinTwd) {
    throw new DomainError('ticketMaxTwd must be greater than or equal to ticketMinTwd', 'invalid_ticket_range');
  }
  return { industries, ticketMinTwd, ticketMaxTwd };
}

export function validateLead(input, { now = new Date().toISOString() } = {}) {
  const status = String(input.status || 'new').trim();
  if (!LEAD_STATUSES.includes(status)) {
    throw new DomainError(`status must be one of ${LEAD_STATUSES.join(', ')}`, 'invalid_lead_status');
  }
  const contactInput = input.contact && typeof input.contact === 'object' ? input.contact : {};
  const genericContact = typeof input.contact === 'string' ? input.contact.trim() : '';
  const email = optionalText(
    input.email ?? contactInput.email ?? (genericContact.includes('@') ? genericContact : ''),
    'email',
    254,
  ).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DomainError('email must be valid', 'invalid_lead_email');
  }
  const preferences = normalizeInvestmentPreferences(input.investmentPreferences || input);
  const phoneInput = optionalText(
    input.phone ?? contactInput.phone ?? (genericContact && !genericContact.includes('@') ? genericContact : ''),
    'phone',
    40,
  );
  const phoneDigits = phoneInput.replace(/\D/g, '');
  const phone = /^09\d{8}$/.test(phoneDigits) ? phoneDigits : phoneInput;
  return {
    ownerReferrerId: requiredText(input.ownerReferrerId || input.owner, 'ownerReferrerId', 'lead_owner_required'),
    sourceReference: requiredText(input.sourceReference || input.source, 'sourceReference', 'lead_source_required'),
    privacyEvidence: normalizePrivacyEvidence(input.privacyEvidence || input.sourceEvidence, now),
    displayName: optionalText(input.displayName || input.name || contactInput.name, 'displayName', 120),
    phone,
    email,
    companyName: optionalText(input.companyName || input.company, 'companyName', 160),
    channel: optionalText(input.channel, 'channel', 80),
    notes: optionalText(input.notes || input.note, 'notes', 2000),
    investmentPreferences: preferences,
    status,
  };
}

export function assertLeadStatusTransition(from, to) {
  if (!LEAD_STATUSES.includes(from) || !LEAD_STATUSES.includes(to)) {
    throw new DomainError('Unknown lead status', 'invalid_lead_status');
  }
  if (from === to) return;
  const rank = { new: 0, contacted: 1, qualified: 2, converted: 3 };
  if (from === 'archived' || (from === 'converted' && to !== 'archived')
    || (to !== 'archived' && rank[to] < rank[from])) {
    throw new DomainError(`Cannot move lead from ${from} to ${to}`, 'invalid_lead_transition', 409);
  }
}

export function validateContentItem(input, { now = new Date().toISOString() } = {}) {
  const type = String(input.type || '').trim();
  const status = String(input.status || 'draft').trim();
  if (!CONTENT_TYPES.includes(type)) {
    throw new DomainError(`type must be one of ${CONTENT_TYPES.join(', ')}`, 'invalid_content_type');
  }
  if (!CONTENT_STATUSES.includes(status)) {
    throw new DomainError(`status must be one of ${CONTENT_STATUSES.join(', ')}`, 'invalid_content_status');
  }
  const publicSafe = input.publicSafe === true || input.publicSafe === 'true';
  const visibility = String(input.visibility || (publicSafe ? 'public' : type === 'project_update' ? 'qualified' : 'member')).trim();
  if (!CONTENT_VISIBILITIES.includes(visibility)) {
    throw new DomainError(`visibility must be one of ${CONTENT_VISIBILITIES.join(', ')}`, 'invalid_content_visibility');
  }
  const url = optionalText(input.url, 'url', 2048);
  if (url && !/^https:\/\//i.test(url)) {
    throw new DomainError('url must be an HTTPS URL', 'invalid_content_url');
  }
  const videoUrl = optionalText(input.videoUrl || (type === 'video' ? url : ''), 'videoUrl', 2048);
  if (type === 'video' && !/^https:\/\//i.test(videoUrl)) {
    throw new DomainError('videoUrl must be an HTTPS URL for video content', 'invalid_video_url');
  }
  const riskDisclosure = optionalText(input.riskDisclosure || input.riskNotice, 'riskDisclosure', 2000);
  if (status === 'published' && !riskDisclosure) {
    throw new DomainError('riskDisclosure is required before publication', 'risk_disclosure_required', 409);
  }
  const publishedAtInput = status === 'published' ? (input.publishedAt || now) : null;
  const publishedAt = publishedAtInput ? validIsoTimestamp(publishedAtInput, 'publishedAt') : null;
  if (publishedAt && Date.parse(publishedAt) > Date.parse(now) + 5 * 60 * 1000) {
    throw new DomainError('publishedAt cannot be in the future', 'invalid_published_at', 409);
  }
  return {
    type,
    title: requiredText(input.title, 'title', 'content_title_required'),
    summary: optionalText(input.summary || input.body || input.description, 'summary', 5000),
    url: url || null,
    videoUrl: videoUrl || null,
    projectId: optionalText(input.projectId, 'projectId', 120) || null,
    visibility,
    status,
    publicSafe,
    publishedAt,
    riskDisclosure: riskDisclosure || null,
  };
}

export function validateNewsletterPreference(input, current = null) {
  const next = {
    dailyDigestConsent: current?.dailyDigestConsent === true,
    marketingConsent: current?.marketingConsent === true,
    emailDeliveryConsent: current?.emailDeliveryConsent === true,
    lineDeliveryConsent: current?.lineDeliveryConsent === true,
    deliveryChannels: [...(current?.deliveryChannels || ['in_app'])],
  };
  for (const field of ['dailyDigestConsent', 'marketingConsent', 'emailDeliveryConsent', 'lineDeliveryConsent']) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'boolean') throw new DomainError(`${field} must be boolean`, 'invalid_newsletter_preference');
      next[field] = input[field];
    }
  }
  if (input.deliveryChannels !== undefined) {
    if (!Array.isArray(input.deliveryChannels) || input.deliveryChannels.length === 0) {
      throw new DomainError('deliveryChannels must be a non-empty array', 'invalid_delivery_channels');
    }
    next.deliveryChannels = [...new Set(input.deliveryChannels.map((item) => String(item).trim()))];
    if (next.deliveryChannels.some((item) => !DIGEST_DELIVERY_CHANNELS.includes(item))) {
      throw new DomainError('deliveryChannels contains an unsupported channel', 'invalid_delivery_channels');
    }
    if (next.deliveryChannels.includes('email') && (!next.dailyDigestConsent || !next.emailDeliveryConsent)) {
      throw new DomainError('email delivery requires daily digest and email consent', 'delivery_consent_required', 409);
    }
    if (next.deliveryChannels.includes('line') && (!next.dailyDigestConsent || !next.lineDeliveryConsent)) {
      throw new DomainError('LINE delivery requires daily digest and LINE consent', 'delivery_consent_required', 409);
    }
  }
  if (!next.deliveryChannels.includes('in_app')) next.deliveryChannels.unshift('in_app');
  if (!next.dailyDigestConsent || !next.emailDeliveryConsent) {
    next.deliveryChannels = next.deliveryChannels.filter((item) => item !== 'email');
  }
  if (!next.dailyDigestConsent || !next.lineDeliveryConsent) {
    next.deliveryChannels = next.deliveryChannels.filter((item) => item !== 'line');
  }
  return next;
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
  const leadOwner = member?.leadOwnerAttribution;
  const attribution = leadOwner || member?.referralAttribution;
  if (!attribution || (!leadOwner && attribution.state !== 'verified')) return null;
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
    ...(leadOwner ? { leadId: leadOwner.leadId, attributionSource: 'lead_owner' } : {}),
  };
}

export function captureAcquisitionAttributionSnapshot(member, now) {
  const leadOwner = member?.leadOwnerAttribution;
  if (!leadOwner?.leadId || !leadOwner?.referrerId) return null;
  return {
    leadId: leadOwner.leadId,
    ownerReferrerId: leadOwner.referrerId,
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

export function canAccessProtectedProject(member, project, now = new Date().toISOString()) {
  if (!member || member.membershipState !== 'active') return false;
  if (member.qualificationState !== 'approved') return false;
  const qualificationExpiresAt = Date.parse(member.qualificationApproval?.expiresAt || '');
  if (!Number.isFinite(qualificationExpiresAt) || qualificationExpiresAt <= Date.parse(now)) return false;
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

function qualificationApproved(member, now) {
  if (!member || member.membershipState !== 'active' || member.qualificationState !== 'approved') return false;
  const expiresAt = Date.parse(member.qualificationApproval?.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt > Date.parse(now);
}

const PROJECT_INACTIVE_STATES = new Set([
  'draft', 'unpublished', 'withdrawn', 'closed', 'cancelled', 'canceled', 'archived', 'disabled', 'rejected',
]);
const PROJECT_HIDDEN_VISIBILITIES = new Set([
  'draft', 'unpublished', 'hidden', 'private', 'withdrawn', 'closed', 'archived', 'disabled', 'none',
]);

function projectBoundaryTime(value, endOfDate = false) {
  if (!value) return null;
  const text = String(value).trim();
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? Date.parse(`${text}T${endOfDate ? '23:59:59.999' : '00:00:00.000'}+08:00`)
    : Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isProjectMatchCandidate(project, now = new Date().toISOString()) {
  const nowMs = Date.parse(now);
  if (!project || !Number.isFinite(nowMs)) return false;
  const states = [project.status, project.publicationStatus, project.publicationState, project.fundraisingState]
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim().toLowerCase());
  if (states.some((state) => PROJECT_INACTIVE_STATES.has(state))) return false;
  if (project.publicVisibility === false) return false;
  const visibility = String(project.publicVisibility || '').trim().toLowerCase();
  if (PROJECT_HIDDEN_VISIBILITIES.has(visibility)) return false;
  if (project.isWithdrawn === true || project.isClosed === true) return false;
  const withdrawnAt = projectBoundaryTime(project.withdrawnAt);
  const closedAt = projectBoundaryTime(project.closedAt);
  if ((withdrawnAt !== null && withdrawnAt <= nowMs) || (closedAt !== null && closedAt <= nowMs)) return false;
  const publishedAt = projectBoundaryTime(project.publishedAt);
  const opensAt = projectBoundaryTime(project.opensAt || project.openingAt || project.effectiveAt);
  if ((publishedAt !== null && publishedAt > nowMs) || (opensAt !== null && opensAt > nowMs)) return false;
  const deadline = projectBoundaryTime(
    project.protected?.deadline || project.deadline || project.closesAt || project.closingAt,
    true,
  );
  return deadline === null || deadline >= nowMs;
}

export function projectMatches({ subject, member = null, projects, now = new Date().toISOString() }) {
  const preferences = normalizeInvestmentPreferences(subject?.investmentPreferences || subject || {});
  const qualified = qualificationApproved(member, now);
  return projects.filter((project) => isProjectMatchCandidate(project, now)).map((project) => {
    const projectMinimum = normalizeTwd(project.protected?.minimumAmountTwd ?? 0, 'project.minimumAmountTwd');
    const projectTarget = normalizeTwd(project.protected?.targetAmountTwd ?? Number.MAX_SAFE_INTEGER, 'project.targetAmountTwd');
    const industryMatch = preferences.industries.length === 0 || preferences.industries.includes(project.industry);
    const ticketRangeMatch = preferences.ticketMaxTwd >= projectMinimum && preferences.ticketMinTwd <= projectTarget;
    const accessMatch = Boolean(member && canAccessProtectedProject(member, project, now));
    const eligible = industryMatch && ticketRangeMatch && qualified && accessMatch;
    const score = (industryMatch ? 40 : 0) + (ticketRangeMatch ? 30 : 0) + (qualified ? 15 : 0) + (accessMatch ? 15 : 0);
    const reasons = [
      industryMatch
        ? { code: 'industry_match', label: '符合產業偏好' }
        : { code: 'industry_mismatch', label: '不符合產業偏好' },
      ticketRangeMatch
        ? { code: 'ticket_range_match', label: '符合投資金額範圍' }
        : { code: 'ticket_range_mismatch', label: '不符合投資金額範圍' },
      qualified
        ? { code: 'qualification_approved', label: '投資資格有效' }
        : { code: 'qualification_required', label: '尚需有效投資資格' },
      accessMatch
        ? { code: 'project_access_granted', label: '已具專案存取權' }
        : { code: 'project_access_required', label: '尚需專案存取授權' },
    ];
    return {
      projectId: project.id,
      projectName: project.displayName,
      industry: project.industry,
      industryMatch,
      ticketRangeMatch,
      qualificationMatch: qualified,
      accessMatch,
      eligible,
      score,
      reasons,
    };
  }).sort((left, right) => right.score - left.score || left.projectId.localeCompare(right.projectId));
}

export function canViewContentItem(item, {
  member = null, project = null, publicOnly = false, now = new Date().toISOString(),
} = {}) {
  const publishedAt = Date.parse(item.publishedAt || '');
  if (item.status !== 'published' || !Number.isFinite(publishedAt) || publishedAt > Date.parse(now) || !item.riskDisclosure) return false;
  const visibility = CONTENT_VISIBILITIES.includes(item.visibility)
    ? item.visibility
    : item.publicSafe === true ? 'public' : item.type === 'project_update' ? 'qualified' : 'member';
  if (visibility === 'public') return item.publicSafe === true;
  if (publicOnly || !member || member.membershipState !== 'active') return false;
  if (visibility === 'member') return true;
  if (!qualificationApproved(member, now)) return false;
  return item.projectId ? Boolean(project && canAccessProtectedProject(member, project, now)) : true;
}

export function createSubscriptionRecord({
  id, memberId, projectId, requestedAmountTwd, riskAcknowledged, riskAcknowledgedAt, riskDisclosureVersion, now,
  referralSnapshot = null, acquisitionAttributionSnapshot = null,
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
    acquisitionAttributionSnapshot: acquisitionAttributionSnapshot
      ? structuredClone(acquisitionAttributionSnapshot)
      : null,
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
