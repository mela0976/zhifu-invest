import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  AMOUNT_FIELDS,
  DomainError,
  assertLeadStatusTransition,
  assertTransition,
  canViewContentItem,
  captureAcquisitionAttributionSnapshot,
  captureReferralSnapshot,
  canAccessProtectedProject,
  createSubscriptionRecord,
  isReferrerEffective,
  memberProject,
  normalizeInvestmentPreferences,
  projectMatches,
  publicProject,
  redactMember,
  taipeiDate,
  updateCommissionRecord,
  updateSubscriptionRecord,
  validateContentItem,
  validateLead,
  validateNewsletterPreference,
  validateReferrer,
} from './domain.js';
import { createSessionManager, parseCookies, requireRole } from './auth.js';
import {
  LEAD_EXPORT_FIELDS,
  LEAD_EXPORT_SCHEMA_VERSION,
  createLeadXlsx,
  leadExportRows,
  leadXlsxFilename,
} from './lead-xlsx.js';
import { createLineProvider, statusMessage } from './line.js';
import { createDemoDeckPdf } from './pdf.js';

const ADMIN_ROLE = 'admin';
const NOTIFICATION_MAX_ATTEMPTS = 4;
const LEAD_IMPORT_MAX_BYTES = 64 * 1024;

function error(c, status, code, message, details) {
  return c.json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, status);
}

function bodyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function jsonBody(c) {
  try {
    return bodyObject(await c.req.json());
  } catch {
    throw new DomainError('Request body must be valid JSON', 'invalid_json');
  }
}

function actorFrom(c) {
  const session = c.get('session');
  if (!session) return { type: 'visitor', id: 'anonymous' };
  return { type: session.role, id: session.memberId || session.adminId || session.sub || 'unknown' };
}

function sessionMember(c, data) {
  const session = c.get('session');
  if (session?.role !== 'member') return null;
  return data.members.find((member) => member.id === session.memberId) || null;
}

function gate(c, roles) {
  const failure = requireRole(c.get('session'), roles);
  return failure ? error(c, failure.status, failure.code, failure.message) : null;
}

function csvCell(value) {
  const string = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safeString = /^[\t ]*[=+@-]/.test(string) ? `'${string}` : string;
  return `"${safeString.replaceAll('"', '""')}"`;
}

function toCsv(rows, fields) {
  return [fields.map(csvCell).join(','), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))].join('\r\n');
}

function publicMemberView(member) {
  return {
    ...redactMember(member),
    email: member.email,
    sourceGroup: member.sourceGroup,
    projectAccess: member.projectAccess,
    qualificationApproval: member.qualificationApproval,
  };
}

function enrichedSubscription(subscription, data) {
  const member = data.members.find((item) => item.id === subscription.memberId);
  const project = data.projects.find((item) => item.id === subscription.projectId);
  return {
    ...subscription,
    memberName: member?.legalName || member?.displayName || '未知會員',
    projectName: project?.displayName || '未知專案',
    requestedAmount: subscription.requestedAmountTwd,
    approvedAmount: subscription.approvedAmountTwd,
    receivedAmount: subscription.receivedAmountTwd,
    allocatedAmount: subscription.allocatedAmountTwd,
    refundedAmount: subscription.refundedAmountTwd,
    subscriptionStatus: subscription.subscriptionState,
    fundingStatus: subscription.fundingState,
    allocationStatus: subscription.allocationState,
  };
}

function memberSubscription(subscription, data) {
  const visible = enrichedSubscription(subscription, data);
  for (const field of [
    'acquisitionAttributionSnapshot', 'referralSnapshot', 'commissionState', 'commissionBasisAmountTwd', 'commissionAccruedAmountTwd',
    'commissionApproval', 'commissionPayment', 'commissionVoidReason',
  ]) delete visible[field];
  return visible;
}

function enrichedMember(member, data) {
  const subscriptions = data.subscriptions.filter((item) => item.memberId === member.id);
  const referrer = (data.referrers || []).find((item) => item.id === member.referralAttribution?.referrerId);
  return {
    ...member,
    name: member.legalName || member.displayName,
    source: member.sourceGroup,
    membership: member.membershipState,
    qualification: member.qualificationState,
    lineFriend: member.lineFriendshipState === 'friend',
    referrerName: referrer?.displayName || null,
    requested: subscriptions.reduce((sum, item) => sum + item.requestedAmountTwd, 0),
    received: subscriptions.reduce((sum, item) => sum + item.receivedAmountTwd, 0),
  };
}

function enrichedCommission(subscription, data) {
  const enriched = enrichedSubscription(subscription, data);
  return {
    ...enriched,
    referrerName: subscription.referralSnapshot?.referrerName || null,
  };
}

function enrichedLead(lead, data) {
  const owner = (data.referrers || []).find((item) => item.id === lead.ownerReferrerId);
  const subscriptions = data.subscriptions.filter((item) => (
    item.acquisitionAttributionSnapshot?.leadId === lead.id
    && item.acquisitionAttributionSnapshot.ownerReferrerId === lead.ownerReferrerId
  ));
  return {
    ...lead,
    ownerReferrerName: owner?.displayName || null,
    subscriptionCount: subscriptions.length,
    attributableRequestedAmountTwd: subscriptions.reduce((sum, item) => sum + item.requestedAmountTwd, 0),
    attributableAllocatedAmountTwd: subscriptions.reduce((sum, item) => sum + item.allocatedAmountTwd, 0),
  };
}

function dashboardOverview(data) {
  const sums = Object.fromEntries(AMOUNT_FIELDS.map((field) => [field, data.subscriptions.reduce((sum, item) => sum + item[field], 0)]));
  const commissions = data.subscriptions.filter((item) => item.referralSnapshot);
  const leads = data.leads || [];
  const activeLeads = leads.filter((item) => item.status !== 'archived');
  const convertedLeads = leads.filter((item) => item.status === 'converted');
  const leadSubscriptions = data.subscriptions.filter((item) => item.acquisitionAttributionSnapshot?.leadId);
  return {
    memberCount: data.members.length,
    pendingMemberCount: data.members.filter((item) => item.membershipState === 'pending').length,
    needsInformationCount: data.members.filter((item) => item.qualificationState === 'needs_information').length,
    pendingPartnerReviewCount: data.subscriptions.filter((item) => item.subscriptionState === 'partner_review').length,
    notificationAttentionCount: data.notifications.filter((item) => ['awaiting_confirmation', 'configuration_required', 'failed'].includes(item.status)).length,
    referrerCount: (data.referrers || []).length,
    attributedMemberCount: data.members.filter((item) => item.referralAttribution?.state === 'verified').length,
    commissionAccruedAmountTwd: commissions
      .filter((item) => item.commissionState === 'accrued')
      .reduce((sum, item) => sum + (item.commissionAccruedAmountTwd || 0), 0),
    commissionApprovedAmountTwd: commissions
      .filter((item) => item.commissionState === 'approved')
      .reduce((sum, item) => sum + (item.commissionAccruedAmountTwd || 0), 0),
    commissionPaidAmountTwd: commissions
      .filter((item) => item.commissionState === 'paid')
      .reduce((sum, item) => sum + (item.commissionAccruedAmountTwd || 0), 0),
    leadCount: leads.length,
    activeLeadCount: activeLeads.length,
    convertedLeadCount: convertedLeads.length,
    leadConversionRateBps: activeLeads.length === 0
      ? 0
      : Math.floor((convertedLeads.length * 10_000) / activeLeads.length),
    attributableRequestedAmountTwd: leadSubscriptions.reduce((sum, item) => sum + item.requestedAmountTwd, 0),
    attributableAllocatedAmountTwd: leadSubscriptions.reduce((sum, item) => sum + item.allocatedAmountTwd, 0),
    ...sums,
  };
}

function requiredReason(body, code = 'reason_required') {
  const reason = String(body?.reason || '').trim();
  if (!reason) throw new DomainError('reason is required', code, 409);
  return reason;
}

function newsletterPreference(data, memberId) {
  return (data.newsletterPreferences || []).find((item) => item.memberId === memberId) || {
    memberId,
    dailyDigestConsent: false,
    marketingConsent: false,
    emailDeliveryConsent: false,
    lineDeliveryConsent: false,
    deliveryChannels: ['in_app'],
    updatedAt: null,
  };
}

function visibleContent(data, { member = null, publicOnly = false } = {}) {
  return (data.contentItems || [])
    .filter((item) => canViewContentItem(item, {
      member,
      publicOnly,
      project: item.projectId ? data.projects.find((project) => project.id === item.projectId) : null,
    }))
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || left.id.localeCompare(right.id));
}

function memberMatches(data, member, now = new Date().toISOString()) {
  return projectMatches({
    subject: member,
    member,
    projects: data.projects,
    now,
  });
}

function leadMatches(data, lead, now = new Date().toISOString()) {
  const member = lead.memberId ? data.members.find((item) => item.id === lead.memberId) : null;
  return projectMatches({ subject: lead, member, projects: data.projects, now });
}

function digestForMember(data, member, date = taipeiDate()) {
  const subscriptions = data.subscriptions.filter((item) => item.memberId === member.id);
  return {
    memberId: member.id,
    date,
    investmentProgress: {
      subscriptionCount: subscriptions.length,
      requestedAmountTwd: subscriptions.reduce((sum, item) => sum + item.requestedAmountTwd, 0),
      approvedAmountTwd: subscriptions.reduce((sum, item) => sum + item.approvedAmountTwd, 0),
      depositPaidAmountTwd: subscriptions.reduce((sum, item) => sum + item.receivedAmountTwd, 0),
      accountRecordedAmountTwd: subscriptions.reduce(
        (sum, item) => sum + Math.max(0, item.receivedAmountTwd - item.refundedAmountTwd),
        0,
      ),
      allocatedAmountTwd: subscriptions.reduce((sum, item) => sum + item.allocatedAmountTwd, 0),
      items: subscriptions.map((item) => memberSubscription(item, data)),
    },
    contentItems: visibleContent(data, { member }),
    matchedProjects: memberMatches(data, member).filter((item) => item.eligible),
  };
}

function dashboardActions(data) {
  const pendingMembers = data.members.filter((item) => item.membershipState === 'pending').length;
  const partnerReview = data.subscriptions.filter((item) => item.subscriptionState === 'partner_review').length;
  const unpaid = data.subscriptions.filter((item) => ['unpaid', 'partial'].includes(item.fundingState)).length;
  const failedNotifications = data.notifications.filter((item) => ['awaiting_confirmation', 'configuration_required', 'failed'].includes(item.status)).length;
  return [
    { id: 'membership-pending', type: '會員確認', priority: pendingMembers ? 'urgent' : 'normal', title: `確認 ${pendingMembers} 位新會員`, count: pendingMembers },
    { id: 'partner-review', type: '認購審核', priority: partnerReview ? 'urgent' : 'normal', title: `${partnerReview} 筆待登錄合作方結果`, count: partnerReview },
    { id: 'funding-followup', type: '入金追蹤', priority: 'normal', title: `追蹤 ${unpaid} 筆未完成入金`, count: unpaid },
    { id: 'notification-attention', type: '通知異常', priority: failedNotifications ? 'urgent' : 'normal', title: `${failedNotifications} 則 LINE 通知待處理`, count: failedNotifications },
  ];
}

function notificationNeedsConfirmation(eventType) {
  return eventType.includes('rejected') || eventType.includes('refund') || eventType.includes('bulk');
}

async function enqueueNotification(draft, store, {
  member, eventType, actor, manual = false, metadata = {}, autoDelivery = false, deliver = null,
}) {
  const now = new Date().toISOString();
  const record = {
    id: `notification-${randomUUID()}`,
    memberId: member.id,
    lineUserId: member.lineUserId,
    eventType,
    message: statusMessage(eventType),
    templateVersion: 1,
    metadata,
    status: !member.lineUserId
      ? 'configuration_required'
      : manual || notificationNeedsConfirmation(eventType) ? 'awaiting_confirmation' : 'queued',
    attempts: 0,
    lastError: null,
    providerResponse: null,
    autoDelivery,
    createdAt: now,
    updatedAt: now,
  };
  draft.notifications.push(record);
  await store.appendAudit(draft, {
    entityType: 'notification', entityId: record.id, action: 'notification.queued', actor,
    before: null, after: record, reason: `Event ${eventType}`,
  });
  if (record.status === 'queued' && autoDelivery && deliver) {
    setTimeout(() => deliver(record.id).catch((caught) => console.error('Notification delivery error', caught)), 0);
  }
  return record;
}

export function createApp({ store, env = process.env, staticRoot = './public', lineProvider = null }) {
  if (!store?.data) throw new Error('createApp requires an initialized store');
  const app = new Hono();
  const sessions = createSessionManager(env);
  const line = lineProvider || createLineProvider(env);
  const origin = env.APP_ORIGIN || 'http://localhost:4173';

  async function deliverNotification(notificationId, actor, { force = false } = {}) {
    const notification = await store.mutate(async (draft) => {
      const record = draft.notifications.find((item) => item.id === notificationId);
      if (!record) throw new DomainError('Notification was not found', 'notification_not_found', 404);
      if (record.channel && record.channel !== 'line') {
        throw new DomainError('Only LINE outbox records can be sent by the LINE notification worker', 'notification_channel_not_sendable', 409);
      }
      if (record.status === 'sent') return record;
      if (!force && (record.status === 'awaiting_confirmation' || record.attempts >= NOTIFICATION_MAX_ATTEMPTS)) return record;
      record.status = 'sending';
      record.updatedAt = new Date().toISOString();
      return record;
    });
    if (notification.status !== 'sending') return { ok: notification.status === 'sent', notification };

    try {
      const providerResponse = await line.push(notification.lineUserId, [{ type: 'text', text: notification.message }]);
      const sent = await store.mutate(async (draft) => {
        const record = draft.notifications.find((item) => item.id === notification.id);
        const before = structuredClone(record);
        record.attempts += 1;
        record.status = 'sent';
        record.providerResponse = providerResponse;
        record.lastError = null;
        record.sentAt = new Date().toISOString();
        record.updatedAt = record.sentAt;
        await store.appendAudit(draft, {
          entityType: 'notification', entityId: record.id, action: 'notification.sent', actor,
          before, after: record, reason: 'LINE push accepted',
        });
        return record;
      });
      return { ok: true, notification: sent };
    } catch (caught) {
      const failed = await store.mutate(async (draft) => {
        const record = draft.notifications.find((item) => item.id === notification.id);
        const before = structuredClone(record);
        record.attempts += 1;
        record.lastError = String(caught.message || caught);
        record.status = record.attempts >= NOTIFICATION_MAX_ATTEMPTS ? 'failed' : 'queued';
        record.updatedAt = new Date().toISOString();
        await store.appendAudit(draft, {
          entityType: 'notification', entityId: record.id, action: 'notification.failed', actor,
          before, after: record, reason: record.lastError,
        });
        return record;
      });
      if (failed.status === 'queued' && failed.autoDelivery) {
        const delayMs = 250 * (2 ** Math.max(0, failed.attempts - 1));
        setTimeout(() => deliverNotification(failed.id, { type: 'system', id: 'notification-worker' })
          .catch((error_) => console.error('Notification retry error', error_)), delayMs);
      }
      return { ok: false, notification: failed };
    }
  }

  const queueNotification = (draft, args) => enqueueNotification(draft, store, {
    ...args,
    autoDelivery: true,
    deliver: (id) => deliverNotification(id, { type: 'system', id: 'notification-worker' }),
  });
  const operationsRecipient = {
    id: 'operations-referrer',
    lineUserId: env.LINE_OPERATIONS_USER_ID || (line.demoMode ? 'demo-line-operations' : ''),
  };
  const complianceRecipient = {
    id: 'licensed-partner',
    lineUserId: env.LINE_COMPLIANCE_USER_ID || (line.demoMode ? 'demo-line-compliance' : ''),
  };
  const queueOperationsNotification = (draft, eventType, metadata, includeCompliance = false) => {
    const recipients = includeCompliance ? [operationsRecipient, complianceRecipient] : [operationsRecipient];
    return Promise.all(recipients.map((recipient) => queueNotification(draft, {
      member: recipient,
      eventType,
      actor: { type: 'system', id: 'operations-notifier' },
      metadata,
    })));
  };

  function requireReferrerRecord(draft, value) {
    const key = String(value || '').trim();
    const referrer = (draft.referrers || []).find((item) => item.id === key || item.code === key.toUpperCase());
    if (!referrer) throw new DomainError('Lead owner referrer was not found', 'referrer_not_found', 404);
    return referrer;
  }

  function resolveReferrer(draft, value, now) {
    const referrer = requireReferrerRecord(draft, value);
    if (!isReferrerEffective(referrer, now)) {
      throw new DomainError('Lead owner referrer must be active and effective', 'referrer_not_effective', 409);
    }
    return referrer;
  }

  async function linkLeadMember(draft, lead, memberId, actor, reason, now) {
    const member = draft.members.find((item) => item.id === memberId);
    if (!member) throw new DomainError('Member was not found', 'member_not_found', 404);
    if (lead.status === 'archived') throw new DomainError('Archived leads cannot be linked', 'lead_archived', 409);
    if (lead.memberId === member.id && member.leadOwnerAttribution?.leadId === lead.id) return;
    if (lead.memberId && lead.memberId !== member.id) {
      throw new DomainError('A converted lead cannot be linked to another member', 'lead_member_locked', 409);
    }
    if (member.leadOwnerAttribution && member.leadOwnerAttribution.leadId !== lead.id) {
      throw new DomainError('Member already has an immutable lead owner', 'member_lead_owner_locked', 409);
    }
    const verified = member.referralAttribution?.state === 'verified' ? member.referralAttribution : null;
    if (verified && verified.referrerId !== lead.ownerReferrerId) {
      throw new DomainError('Verified member referrer conflicts with the lead owner', 'lead_referrer_conflict', 409);
    }
    const referrer = requireReferrerRecord(draft, lead.ownerReferrerId);
    const beforeMember = structuredClone(member);
    const beforeLead = structuredClone(lead);
    member.leadOwnerAttribution ||= {
      leadId: lead.id,
      referrerId: referrer.id,
      referralCode: referrer.code,
      sourceReference: lead.sourceReference,
      evidenceReference: lead.privacyEvidence.reference,
      linkedAt: now,
      linkedBy: actor.id,
    };
    if (!verified) {
      member.referralAttribution = {
        referrerId: referrer.id,
        referralCode: referrer.code,
        state: 'verified',
        evidenceReference: lead.privacyEvidence.reference,
        claimedAt: member.referralAttribution?.claimedAt || now,
        verifiedAt: now,
        verifiedBy: actor.id,
      };
    }
    member.updatedAt = now;
    lead.memberId = member.id;
    lead.status = 'converted';
    lead.convertedAt ||= now;
    lead.updatedAt = now;
    await store.appendAudit(draft, {
      entityType: 'lead', entityId: lead.id, action: 'lead.member_linked', actor,
      before: beforeLead, after: lead, reason,
    });
    await store.appendAudit(draft, {
      entityType: 'member', entityId: member.id, action: 'member.lead_owner_linked', actor,
      before: beforeMember, after: member, reason,
    });
  }

  async function createLead(draft, input, actor, reason, inheritedEvidence = null) {
    const now = new Date().toISOString();
    const candidate = {
      ...input,
      privacyEvidence: input.privacyEvidence || input.sourceEvidence || inheritedEvidence,
    };
    const normalized = validateLead(candidate, { now });
    const owner = resolveReferrer(draft, normalized.ownerReferrerId, now);
    normalized.ownerReferrerId = owner.id;
    draft.leads ||= [];
    const phoneKey = normalized.phone.replace(/[^0-9+]/g, '');
    const duplicateContact = draft.leads.find((item) => (
      (normalized.email && String(item.email || '').toLowerCase() === normalized.email)
      || (phoneKey && String(item.phone || '').replace(/[^0-9+]/g, '') === phoneKey)
    ));
    if (duplicateContact) {
      if (duplicateContact.ownerReferrerId !== normalized.ownerReferrerId) {
        throw new DomainError('Lead contact is already owned by another referrer', 'lead_owner_conflict', 409);
      }
      throw new DomainError('Lead contact already exists', 'duplicate_lead_contact', 409);
    }
    const requestedMemberId = input.memberId || input.linkMemberId || null;
    if (normalized.status === 'converted' && !requestedMemberId) {
      throw new DomainError('A converted lead requires a linked member', 'lead_member_required', 409);
    }
    const record = {
      id: `lead-${randomUUID()}`,
      demo: false,
      ...normalized,
      memberId: null,
      convertedAt: null,
      importedBy: actor.id,
      importedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    if (requestedMemberId) record.status = 'new';
    draft.leads.push(record);
    await store.appendAudit(draft, {
      entityType: 'lead', entityId: record.id, action: 'lead.created', actor,
      before: null, after: record, reason,
    });
    if (requestedMemberId) await linkLeadMember(draft, record, requestedMemberId, actor, reason, now);
    return record;
  }

  async function enqueueDigestOutbox(draft, digest, member, channel, actor) {
    const now = new Date().toISOString();
    const record = {
      id: `notification-${randomUUID()}`,
      memberId: member.id,
      lineUserId: channel === 'line' ? member.lineUserId : null,
      channel,
      eventType: 'daily_digest.generated',
      message: `今日摘要已更新，請登入查看：${new URL('/member.html#digest', origin).toString()}`,
      templateVersion: 1,
      metadata: { digestId: digest.id, date: digest.date },
      status: 'outbox',
      attempts: 0,
      lastError: null,
      providerResponse: null,
      autoDelivery: false,
      createdAt: now,
      updatedAt: now,
    };
    draft.notifications.push(record);
    await store.appendAudit(draft, {
      entityType: 'notification', entityId: record.id, action: 'digest.delivery_queued', actor,
      before: null, after: record, reason: `Daily digest ${channel} delivery`,
    });
    return record;
  }

  app.onError((caught, c) => {
    if (caught instanceof DomainError) return error(c, caught.status, caught.code, caught.message);
    console.error(caught);
    return error(c, 500, 'internal_error', 'Unexpected server error');
  });

  app.use('*', async (c, next) => {
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    c.header('x-frame-options', 'DENY');
    c.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    c.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    await next();
  });

  app.use('/api/*', async (c, next) => {
    c.set('session', sessions.fromRequest(c.req));
    c.header('cache-control', 'no-store');
    await next();
  });

  const health = (c) => c.json({ ok: true, service: 'zhifu-invest', demo: line.demoMode, time: new Date().toISOString() });
  app.get('/healthz', health);
  app.get('/api/health', health);
  app.get('/api/config', (c) => {
    const config = {
      demoMode: line.demoMode,
      lineLoginEnabled: line.loginConfigured || line.demoMode,
      lineMessagingEnabled: line.messagingConfigured || line.demoMode,
      lineOaBasicId: env.LINE_OA_BASIC_ID || null,
      appOrigin: origin,
      sessionHours: Number(env.SESSION_TTL_SECONDS || 28800) / 3600,
    };
    return c.json({ ok: true, config, data: config });
  });

  app.get('/api/auth/me', (c) => {
    const session = c.get('session');
    if (!session) {
      const current = { authenticated: false, role: 'visitor', member: null };
      return c.json({ ok: true, ...current, data: current });
    }
    const data = store.snapshot();
    const member = sessionMember(c, data);
    if (session.role === 'member' && !member) {
      const current = { authenticated: false, role: 'visitor', member: null };
      return c.json({ ok: true, ...current, data: current });
    }
    const current = {
      authenticated: true,
      role: session.role,
      member: member ? publicMemberView(member, data) : null,
    };
    return c.json({ ok: true, ...current, data: current });
  });

  app.post('/api/auth/demo', async (c) => {
    if (!line.demoMode) return error(c, 404, 'not_found', 'Demo login is disabled');
    const body = await jsonBody(c);
    const data = store.snapshot();
    const role = body.role === ADMIN_ROLE ? ADMIN_ROLE : 'member';
    let payload;
    let subject;
    if (role === ADMIN_ROLE) {
      payload = { role, adminId: 'admin-referrer-demo' };
      subject = { id: 'admin-referrer-demo', displayName: '引薦人 DEMO', role };
    } else {
      const member = data.members.find((item) => item.id === (body.memberId || 'member-001'));
      if (!member) return error(c, 404, 'member_not_found', 'Demo member was not found');
      payload = { role, memberId: member.id };
      subject = publicMemberView(member, data);
    }
    c.header('set-cookie', sessions.cookie(sessions.issue(payload)));
    return c.json({ ok: true, role, subject, data: { role, subject } });
  });

  app.post('/api/auth/logout', (c) => {
    c.header('set-cookie', sessions.clearCookie());
    return c.json({ ok: true });
  });

  app.get('/api/auth/line', (c) => {
    const returnTo = c.req.query('returnTo') || '/';
    const state = sessions.issueState({ returnTo }, Date.now(), 10 * 60);
    c.header('set-cookie', `zhifu_oauth_state=${encodeURIComponent(state)}; Path=/api/auth/line; HttpOnly; SameSite=Lax; Max-Age=600`);
    return c.redirect(line.authorizationUrl(state), 302);
  });

  app.get('/api/auth/line/callback', async (c) => {
    const state = c.req.query('state');
    const statePayload = sessions.verify(state);
    const stateCookie = parseCookies(c.req.header('cookie')).zhifu_oauth_state;
    if (!statePayload || statePayload.type !== 'oauth_state' || stateCookie !== state) {
      return error(c, 400, 'invalid_oauth_state', 'OAuth state is invalid, expired or does not match this browser');
    }
    let lineUserId;
    let displayName;
    if (line.demoMode && c.req.query('demo_member')) {
      const demoMember = store.snapshot().members.find((item) => item.id === c.req.query('demo_member'));
      if (!demoMember) return error(c, 404, 'member_not_found', 'Demo member was not found');
      lineUserId = demoMember.lineUserId;
      displayName = demoMember.displayName;
    } else {
      const code = c.req.query('code');
      if (!code) return error(c, 400, 'missing_code', 'LINE authorization code is missing');
      const token = await line.exchange(code);
      const profile = await line.profile(token.access_token);
      lineUserId = profile.userId;
      displayName = profile.displayName;
    }

    const member = await store.mutate(async (draft) => {
      let found = draft.members.find((item) => item.lineUserId === lineUserId);
      if (found) return found;
      const now = new Date().toISOString();
      found = {
        id: `member-${randomUUID()}`, demo: false, displayName, legalName: '', phone: '', email: '', lineUserId,
        lineFriendshipState: 'unknown', sourceGroup: '', membershipState: 'pending',
        qualificationState: 'not_applied', qualificationApproval: null, tier: 'free', projectAccess: [],
        referralAttribution: null, leadOwnerAttribution: null,
        investmentPreferences: { industries: [], ticketMinTwd: 0, ticketMaxTwd: Number.MAX_SAFE_INTEGER },
        createdAt: now, updatedAt: now,
      };
      draft.members.push(found);
      await store.appendAudit(draft, {
        entityType: 'member', entityId: found.id, action: 'member.line_created',
        actor: { type: 'line', id: lineUserId }, before: null, after: found, reason: 'First LINE Login',
      });
      return found;
    });
    c.header('set-cookie', sessions.cookie(sessions.issue({ role: 'member', memberId: member.id })));
    if (c.req.query('return') === 'json') {
      const result = { role: 'member', member: publicMemberView(member, store.snapshot()) };
      return c.json({ ok: true, ...result, data: result });
    }
    return c.redirect(`${origin}${statePayload.returnTo || '/'}`, 302);
  });

  app.get('/api/projects', (c) => {
    const data = store.snapshot();
    const session = c.get('session');
    const member = sessionMember(c, data);
    const projects = data.projects.map((project) => session?.role === ADMIN_ROLE
      ? project
      : memberProject(project, member));
    return c.json({ ok: true, projects, data: projects });
  });

  app.get('/api/projects/:id', (c) => {
    const data = store.snapshot();
    const project = data.projects.find((item) => item.id === c.req.param('id'));
    if (!project) return error(c, 404, 'project_not_found', 'Project was not found');
    const session = c.get('session');
    if (session?.role === ADMIN_ROLE) return c.json({ ok: true, project, data: project });
    const visible = memberProject(project, sessionMember(c, data));
    return c.json({ ok: true, project: visible, data: visible });
  });

  const contentFeedHandler = (c) => {
    const data = store.snapshot();
    const member = sessionMember(c, data);
    const items = visibleContent(data, { member, publicOnly: !member });
    return c.json({ ok: true, contentItems: items, data: items });
  };
  app.get('/api/content', contentFeedHandler);
  app.get('/api/content/feed', contentFeedHandler);
  app.get('/api/content/public', (c) => {
    const items = visibleContent(store.snapshot(), { publicOnly: true });
    return c.json({ ok: true, contentItems: items, data: items });
  });

  const memberMatchesHandler = (c) => {
    const denied = gate(c, ['member']);
    if (denied) return denied;
    const data = store.snapshot();
    const member = sessionMember(c, data);
    if (!member) return error(c, 404, 'member_not_found', 'Member was not found');
    const matches = memberMatches(data, member).filter((item) => item.eligible);
    return c.json({ ok: true, matches, data: matches });
  };
  app.get('/api/project-matches', memberMatchesHandler);
  app.get('/api/matches', memberMatchesHandler);

  const getNewsletterPreference = (c) => {
    const denied = gate(c, ['member']);
    if (denied) return denied;
    const preference = newsletterPreference(store.snapshot(), c.get('session').memberId);
    return c.json({ ok: true, preference, data: preference });
  };
  app.get('/api/newsletter/preferences', getNewsletterPreference);
  app.get('/api/newsletter-preferences', getNewsletterPreference);

  const patchNewsletterPreference = async (c) => {
    const denied = gate(c, ['member']);
    if (denied) return denied;
    const body = await jsonBody(c);
    const preference = await store.mutate(async (draft) => {
      draft.newsletterPreferences ||= [];
      const memberId = c.get('session').memberId;
      const member = draft.members.find((item) => item.id === memberId);
      if (!member) throw new DomainError('Member was not found', 'member_not_found', 404);
      const index = draft.newsletterPreferences.findIndex((item) => item.memberId === memberId);
      const current = index >= 0 ? draft.newsletterPreferences[index] : newsletterPreference(draft, memberId);
      const normalized = validateNewsletterPreference(body, current);
      const now = new Date().toISOString();
      const next = { memberId, ...normalized, updatedAt: now };
      if (index >= 0) draft.newsletterPreferences[index] = next;
      else draft.newsletterPreferences.push(next);
      await store.appendAudit(draft, {
        entityType: 'newsletter_preference', entityId: memberId, action: 'newsletter_preference.updated',
        actor: actorFrom(c), before: current, after: next, reason: 'Member updated newsletter preferences',
      });
      return next;
    });
    return c.json({ ok: true, preference, data: preference });
  };
  app.patch('/api/newsletter/preferences', patchNewsletterPreference);
  app.patch('/api/newsletter-preferences', patchNewsletterPreference);

  app.get('/api/digest/today', (c) => {
    const denied = gate(c, ['member']);
    if (denied) return denied;
    const data = store.snapshot();
    const member = sessionMember(c, data);
    const date = taipeiDate();
    const stored = (data.dailyDigests || []).find((item) => item.memberId === member.id && item.date === date) || null;
    const digest = stored || digestForMember(data, member, date);
    return c.json({ ok: true, digest, generated: Boolean(stored), data: digest });
  });

  app.post('/api/activation', async (c) => {
    const denied = gate(c, ['member']);
    if (denied) return denied;
    const body = await jsonBody(c);
    const privacyConsent = body.privacyConsent === true || body.privacyConsent === 'true';
    const lineFriendConfirmed = body.lineFriendConfirmed === true || body.lineFriendConfirmed === 'true';
    const phone = String(body.phone || '').replace(/[\s-]/g, '');
    if (!body.fullName || !phone || !body.sourceCode || !body.sourceName) {
      return error(c, 400, 'missing_fields', 'fullName, phone, sourceCode and sourceName are required');
    }
    if (!/^09\d{8}$/.test(phone)) {
      return error(c, 400, 'invalid_phone', 'A valid Taiwan mobile number is required');
    }
    if (!privacyConsent || !lineFriendConfirmed) {
      return error(c, 409, 'consent_required', 'LINE friend confirmation and privacy consent are required');
    }
    const result = await store.mutate(async (draft) => {
      const member = sessionMember(c, draft);
      if (!member) throw new DomainError('Member not found', 'member_not_found', 404);
      if (member.lineFriendshipState !== 'friend') {
        throw new DomainError(
          'The LINE Official Account friendship must be verified before activation',
          'line_friendship_required',
          409,
        );
      }
      const before = structuredClone(member);
      const now = new Date().toISOString();
      const referralCode = String(body.sourceCode).trim().toUpperCase();
      const matchedReferrer = (draft.referrers || []).find((item) => (
        item.code === referralCode && isReferrerEffective(item, now)
      ));
      member.legalName = String(body.fullName).trim();
      member.phone = phone;
      member.sourceGroup = String(body.sourceName).trim();
      member.membershipState = 'pending';
      if (member.referralAttribution?.state !== 'verified') {
        member.referralAttribution = matchedReferrer ? {
          referrerId: matchedReferrer.id,
          referralCode: matchedReferrer.code,
          state: 'claimed',
          evidenceReference: null,
          claimedAt: now,
          verifiedAt: null,
          verifiedBy: null,
        } : null;
      }
      member.updatedAt = now;
      const activation = {
        id: `activation-${randomUUID()}`, memberId: member.id, status: 'pending',
        fullName: member.legalName, phone: member.phone, sourceCode: referralCode,
        sourceName: member.sourceGroup, lineFriendConfirmed: true,
        lineFriendshipEvidence: member.lineFriendshipState, privacyConsent: true,
        referralAttribution: member.referralAttribution ? structuredClone(member.referralAttribution) : null,
        consentedAt: member.updatedAt, submittedAt: member.updatedAt,
      };
      draft.activations.push(activation);
      await store.appendAudit(draft, {
        entityType: 'member', entityId: member.id, action: 'activation.submitted', actor: actorFrom(c),
        before: {
          membershipState: before.membershipState,
          sourceGroup: before.sourceGroup,
          referralAttribution: before.referralAttribution || null,
        },
        after: {
          membershipState: member.membershipState, sourceGroup: member.sourceGroup,
          referralAttribution: member.referralAttribution,
          activationId: activation.id, privacyConsent: true, consentedAt: activation.consentedAt,
        },
        reason: 'Member submitted community activation',
      });
      await queueNotification(draft, { member, eventType: 'activation.received', actor: actorFrom(c) });
      await queueOperationsNotification(draft, 'operations.activation_received', { memberId: member.id });
      return activation;
    });
    const { referralAttribution: internalAttribution, ...visible } = result;
    visible.referralClaimed = Boolean(internalAttribution);
    return c.json({ ok: true, activation: visible, data: visible }, 201);
  });

  app.get('/api/bookings', (c) => {
    const denied = gate(c, ['member', ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const session = c.get('session');
    const bookings = session.role === ADMIN_ROLE ? data.bookings : data.bookings.filter((item) => item.memberId === session.memberId);
    return c.json({ ok: true, bookings, data: bookings });
  });

  app.post('/api/bookings', async (c) => {
    const body = await jsonBody(c);
    const identityType = String(body.role || body.identityType || 'investor').trim();
    const topic = String(body.topic || '').trim();
    const contactName = String(body.name || '').trim();
    const contactPhone = String(body.phone || '').trim();
    const preferredDate = String(body.preferredDate || '').trim();
    const preferredTime = String(body.preferredTime || '').trim();
    const notes = String(body.note || body.notes || '').trim();
    const consent = body.consent === true || body.consent === 'on';
    if (!topic || !contactName || !contactPhone || !preferredDate || !preferredTime || !consent) {
      return error(c, 400, 'missing_fields', 'topic, name, phone, preferredDate, preferredTime and consent are required');
    }
    if (!['investor', 'company', 'other'].includes(identityType)) {
      return error(c, 400, 'invalid_identity_type', 'Booking identity type is invalid');
    }
    if (contactName.length > 80 || contactPhone.length > 30 || topic.length > 120 || notes.length > 500) {
      return error(c, 400, 'field_too_long', 'Booking fields exceed the allowed length');
    }
    const booking = await store.mutate(async (draft) => {
      const member = sessionMember(c, draft);
      const now = new Date().toISOString();
      const record = {
        id: `booking-${randomUUID()}`, memberId: member?.id || null, status: 'requested',
        advisorType: String(body.advisorType || topic), topic, preferredDate, preferredTime,
        identityType, contactName, contactPhone, notes, consentAt: now, createdAt: now, updatedAt: now,
      };
      draft.bookings.push(record);
      await store.appendAudit(draft, {
        entityType: 'booking', entityId: record.id, action: 'booking.created', actor: actorFrom(c),
        before: null, after: record, reason: member ? 'Member requested advisory booking' : 'Visitor requested advisory booking',
      });
      if (member) await queueNotification(draft, { member, eventType: 'booking.received', actor: actorFrom(c) });
      await queueOperationsNotification(draft, 'operations.booking_received', {
        bookingId: record.id,
        memberId: member?.id || null,
      });
      return record;
    });
    return c.json({ ok: true, booking, data: booking }, 201);
  });

  app.get('/api/subscriptions', (c) => {
    const denied = gate(c, ['member', ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const session = c.get('session');
    const subscriptions = session.role === ADMIN_ROLE
      ? data.subscriptions
      : data.subscriptions.filter((item) => item.memberId === session.memberId);
    const visible = subscriptions.map((item) => session.role === ADMIN_ROLE
      ? enrichedSubscription(item, data)
      : memberSubscription(item, data));
    return c.json({ ok: true, subscriptions: visible, data: visible });
  });

  app.post('/api/subscriptions', async (c) => {
    const denied = gate(c, ['member']);
    if (denied) return denied;
    const body = await jsonBody(c);
    const idempotencyKey = c.req.header('idempotency-key') || body.idempotencyKey;
    if (!idempotencyKey || String(idempotencyKey).length < 8) {
      return error(c, 400, 'idempotency_key_required', 'An Idempotency-Key of at least 8 characters is required');
    }
    const riskAcknowledged = body.riskAcknowledged === true || body.riskAcknowledged === 'true';
    if (!riskAcknowledged) {
      return error(c, 409, 'risk_acknowledgement_required', 'The current risk disclosure must be acknowledged');
    }
    const result = await store.mutate(async (draft) => {
      const scope = `subscription:${c.get('session').memberId}:${idempotencyKey}`;
      if (draft.idempotency[scope]) {
        return { subscription: draft.subscriptions.find((item) => item.id === draft.idempotency[scope]), replayed: true };
      }
      const member = sessionMember(c, draft);
      const project = draft.projects.find((item) => item.id === body.projectId);
      if (!project) throw new DomainError('Project was not found', 'project_not_found', 404);
      if (!canAccessProtectedProject(member, project)) {
        throw new DomainError('This project is not authorized for the member', 'project_access_denied', 403);
      }
      const now = new Date().toISOString();
      const record = createSubscriptionRecord({
        id: `subscription-${randomUUID()}`, memberId: member.id, projectId: project.id,
        requestedAmountTwd: body.requestedAmountTwd ?? body.requestedAmount,
        riskAcknowledged: true,
        riskAcknowledgedAt: now,
        riskDisclosureVersion: 'draft-0.1-2026-08-18',
        acquisitionAttributionSnapshot: captureAcquisitionAttributionSnapshot(member, now),
        referralSnapshot: captureReferralSnapshot(member, draft.referrers || [], now),
        now,
      });
      if (record.requestedAmountTwd < project.protected.minimumAmountTwd || record.requestedAmountTwd % project.protected.incrementAmountTwd !== 0) {
        throw new DomainError('Requested amount does not meet project minimum or increment', 'amount_rule_violation', 409);
      }
      draft.subscriptions.push(record);
      draft.idempotency[scope] = record.id;
      await store.appendAudit(draft, {
        entityType: 'subscription', entityId: record.id, action: 'subscription.submitted', actor: actorFrom(c),
        before: null, after: record, reason: String(body.reason || 'Member submitted subscription interest'),
      });
      await queueNotification(draft, { member, eventType: 'subscription.submitted', actor: actorFrom(c) });
      await queueOperationsNotification(
        draft,
        'operations.subscription_received',
        { memberId: member.id, subscriptionId: record.id, projectId: project.id },
        true,
      );
      return { subscription: record, replayed: false };
    });
    const response = { ...result, subscription: memberSubscription(result.subscription, store.snapshot()) };
    return c.json({ ok: true, ...response, data: response.subscription }, result.replayed ? 200 : 201);
  });

  app.post('/api/projects/:id/deck-token', async (c) => {
    const denied = gate(c, ['member', ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const project = data.projects.find((item) => item.id === c.req.param('id'));
    if (!project) return error(c, 404, 'project_not_found', 'Project was not found');
    const session = c.get('session');
    const member = sessionMember(c, data);
    if (session.role !== ADMIN_ROLE && !canAccessProtectedProject(member, project)) {
      return error(c, 403, 'project_access_denied', 'Pitch Deck access is not authorized');
    }
    const subjectId = member?.id || session.adminId;
    const token = sessions.issue({ type: 'deck', projectId: project.id, subjectId, role: session.role }, Date.now(), 5 * 60);
    await store.mutate(async (draft) => store.appendAudit(draft, {
      entityType: 'deck', entityId: project.protected.deck.id, action: 'deck.token_issued', actor: actorFrom(c),
      before: null, after: { projectId: project.id, subjectId, expiresInSeconds: 300 }, reason: 'Authorized expiring deck request',
    }));
    const result = { url: `/api/decks/${encodeURIComponent(token)}`, expiresInSeconds: 300 };
    return c.json({ ok: true, ...result, data: result });
  });

  app.get('/api/decks/:token', async (c) => {
    const payload = sessions.verify(c.req.param('token'));
    if (!payload || payload.type !== 'deck') return error(c, 401, 'invalid_deck_token', 'Deck link is invalid or expired');
    const currentSession = c.get('session');
    const currentSubject = currentSession?.role === 'member' ? currentSession.memberId : currentSession?.adminId;
    if (!currentSession || currentSession.role !== payload.role || currentSubject !== payload.subjectId) {
      return error(c, 401, 'deck_session_mismatch', 'Sign in as the authorized recipient to open this deck');
    }
    const data = store.snapshot();
    const project = data.projects.find((item) => item.id === payload.projectId);
    if (!project) return error(c, 404, 'project_not_found', 'Project was not found');
    if (payload.role === 'member') {
      const member = data.members.find((item) => item.id === payload.subjectId);
      if (!canAccessProtectedProject(member, project)) return error(c, 403, 'project_access_denied', 'Deck access is no longer authorized');
    }
    const issuedAt = new Date().toISOString();
    await store.mutate(async (draft) => store.appendAudit(draft, {
      entityType: 'deck', entityId: project.protected.deck.id, action: 'deck.downloaded',
      actor: { type: payload.role, id: payload.subjectId }, before: null,
      after: { projectId: project.id, subjectId: payload.subjectId, issuedAt }, reason: 'Personalized deck downloaded',
    }));
    const pdf = createDemoDeckPdf({ title: project.protected.deck.title, memberId: payload.subjectId, issuedAt });
    return new Response(pdf, { headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${project.id}-demo-deck.pdf"`,
      'cache-control': 'private, no-store',
    } });
  });

  app.post('/api/line/webhook', async (c) => {
    const rawBody = await c.req.text();
    if (!line.verifyWebhook(rawBody, c.req.header('x-line-signature'))) {
      return error(c, 401, 'invalid_line_signature', 'LINE webhook signature is invalid');
    }
    let payload;
    try { payload = JSON.parse(rawBody); } catch { return error(c, 400, 'invalid_json', 'Webhook body is invalid'); }
    await store.mutate(async (draft) => {
      for (const event of payload.events || []) {
        const userId = event.source?.userId;
        const member = draft.members.find((item) => item.lineUserId === userId);
        if (member && ['follow', 'unfollow'].includes(event.type)) {
          const before = structuredClone(member);
          member.lineFriendshipState = event.type === 'follow' ? 'friend' : 'blocked';
          member.updatedAt = new Date().toISOString();
          await store.appendAudit(draft, {
            entityType: 'member', entityId: member.id, action: `line.${event.type}`,
            actor: { type: 'line', id: userId }, before, after: member, reason: 'Verified LINE webhook event',
          });
        }
      }
    });
    return c.json({ ok: true, accepted: (payload.events || []).length });
  });

  app.get('/api/admin/overview', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const overview = dashboardOverview(data);
    return c.json({ ok: true, overview, data: overview });
  });

  app.get('/api/admin/dashboard', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const overview = dashboardOverview(data);
    const dashboard = {
      overview,
      kpis: {
        totalMembers: overview.memberCount,
        pendingMembers: overview.pendingMemberCount,
        requestedAmount: overview.requestedAmountTwd,
        approvedAmount: overview.approvedAmountTwd,
        receivedAmount: overview.receivedAmountTwd,
        allocatedAmount: overview.allocatedAmountTwd,
        referrerCount: overview.referrerCount,
        attributedMemberCount: overview.attributedMemberCount,
        commissionAccruedAmountTwd: overview.commissionAccruedAmountTwd,
        commissionApprovedAmountTwd: overview.commissionApprovedAmountTwd,
        commissionPaidAmountTwd: overview.commissionPaidAmountTwd,
        leadCount: overview.leadCount,
        activeLeadCount: overview.activeLeadCount,
        convertedLeadCount: overview.convertedLeadCount,
        leadConversionRateBps: overview.leadConversionRateBps,
        attributableRequestedAmountTwd: overview.attributableRequestedAmountTwd,
        attributableAllocatedAmountTwd: overview.attributableAllocatedAmountTwd,
      },
      leads: (data.leads || []).map((item) => enrichedLead(item, data)),
      referrers: data.referrers || [],
      members: data.members.map((item) => enrichedMember(item, data)),
      subscriptions: data.subscriptions.map((item) => enrichedSubscription(item, data)),
      commissions: data.subscriptions
        .filter((item) => item.referralSnapshot)
        .map((item) => enrichedCommission(item, data)),
      actions: dashboardActions(data),
    };
    return c.json({ ok: true, dashboard, data: dashboard });
  });

  app.get('/api/admin/leads', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const status = c.req.query('status');
    const data = store.snapshot();
    const leads = (data.leads || []).filter((item) => !status || item.status === status)
      .map((item) => enrichedLead(item, data));
    return c.json({ ok: true, leads, data: leads });
  });

  app.get('/api/admin/leads/:id', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const found = (data.leads || []).find((item) => item.id === c.req.param('id'));
    const lead = found ? enrichedLead(found, data) : null;
    if (!lead) return error(c, 404, 'lead_not_found', 'Lead was not found');
    return c.json({ ok: true, lead, data: lead });
  });

  app.post('/api/admin/leads', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const reason = requiredReason(body, 'lead_reason_required');
    const lead = await store.mutate((draft) => createLead(draft, body, actorFrom(c), reason));
    return c.json({ ok: true, lead, data: lead }, 201);
  });

  const leadImportBodyLimit = bodyLimit({
    maxSize: LEAD_IMPORT_MAX_BYTES,
    onError: (c) => error(c, 413, 'payload_too_large', 'Lead import body cannot exceed 64 KiB'),
  });
  app.use('/api/admin/leads/import', leadImportBodyLimit);
  app.use('/api/admin/leads/import-json', leadImportBodyLimit);

  const importLeadsHandler = async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const reason = requiredReason(body, 'lead_reason_required');
    const rows = body.leads || body.rows;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) {
      return error(c, 400, 'invalid_lead_import', 'leads or rows must contain 1 to 500 records');
    }
    const leads = await store.mutate(async (draft) => {
      const created = [];
      for (const row of rows) {
        created.push(await createLead(draft, bodyObject(row), actorFrom(c), reason, body.sourceEvidence));
      }
      return created;
    });
    return c.json({ ok: true, leads, importedCount: leads.length, data: leads }, 201);
  };
  app.post('/api/admin/leads/import', importLeadsHandler);
  app.post('/api/admin/leads/import-json', importLeadsHandler);

  app.patch('/api/admin/leads/:id', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const reason = requiredReason(body, 'lead_reason_required');
    const lead = await store.mutate(async (draft) => {
      const current = (draft.leads || []).find((item) => item.id === c.req.param('id'));
      if (!current) throw new DomainError('Lead was not found', 'lead_not_found', 404);
      const now = new Date().toISOString();
      if (body.ownerReferrerId !== undefined || body.owner !== undefined) {
        const requestedOwner = resolveReferrer(draft, body.ownerReferrerId || body.owner, now);
        if (requestedOwner.id !== current.ownerReferrerId) {
          throw new DomainError('Lead owner attribution is immutable', 'lead_owner_locked', 409);
        }
      }
      if (body.sourceReference !== undefined || body.source !== undefined
        || body.privacyEvidence !== undefined || body.sourceEvidence !== undefined) {
        throw new DomainError('Lead source and privacy evidence are immutable', 'lead_evidence_locked', 409);
      }
      const before = structuredClone(current);
      const contact = body.contact && typeof body.contact === 'object' ? body.contact : {};
      const candidate = {
        ...current,
        ...body,
        ownerReferrerId: current.ownerReferrerId,
        sourceReference: current.sourceReference,
        privacyEvidence: current.privacyEvidence,
        displayName: body.displayName ?? body.name ?? contact.name ?? current.displayName,
        phone: body.phone ?? contact.phone ?? (
          typeof body.contact === 'string' && !body.contact.includes('@') ? body.contact : current.phone
        ),
        email: body.email ?? contact.email ?? (
          typeof body.contact === 'string' && body.contact.includes('@') ? body.contact : current.email
        ),
        investmentPreferences: body.investmentPreferences || (
          body.industries !== undefined || body.industryPreferences !== undefined || body.ticketMinTwd !== undefined || body.ticketMaxTwd !== undefined
            ? body : current.investmentPreferences
        ),
      };
      const normalized = validateLead(candidate, { now });
      assertLeadStatusTransition(current.status, normalized.status);
      const memberId = body.memberId || body.linkMemberId;
      if (normalized.status === 'converted' && !current.memberId && !memberId) {
        throw new DomainError('A converted lead requires a linked member', 'lead_member_required', 409);
      }
      if (current.memberId && normalized.status !== 'converted' && normalized.status !== 'archived') {
        throw new DomainError('A linked lead cannot leave converted status', 'lead_member_locked', 409);
      }
      Object.assign(current, normalized, { updatedAt: now });
      if ((body.memberId === null || body.linkMemberId === null) && current.memberId) {
        throw new DomainError('A converted lead cannot be unlinked', 'lead_member_locked', 409);
      }
      await store.appendAudit(draft, {
        entityType: 'lead', entityId: current.id, action: 'lead.updated', actor: actorFrom(c),
        before, after: current, reason,
      });
      if (memberId) await linkLeadMember(draft, current, memberId, actorFrom(c), reason, now);
      return current;
    });
    return c.json({ ok: true, lead, data: lead });
  });

  app.delete('/api/admin/leads/:id', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const reason = requiredReason(body, 'lead_reason_required');
    const lead = await store.mutate(async (draft) => {
      const current = (draft.leads || []).find((item) => item.id === c.req.param('id'));
      if (!current) throw new DomainError('Lead was not found', 'lead_not_found', 404);
      const before = structuredClone(current);
      assertLeadStatusTransition(current.status, 'archived');
      current.status = 'archived';
      current.updatedAt = new Date().toISOString();
      await store.appendAudit(draft, {
        entityType: 'lead', entityId: current.id, action: 'lead.archived', actor: actorFrom(c),
        before, after: current, reason,
      });
      return current;
    });
    return c.json({ ok: true, lead, data: lead });
  });

  const adminContentListHandler = (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const contentItems = store.snapshot().contentItems || [];
    return c.json({ ok: true, contentItems, data: contentItems });
  };
  app.get('/api/admin/content', adminContentListHandler);
  app.get('/api/admin/content-items', adminContentListHandler);

  const adminContentGetHandler = (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const item = (store.snapshot().contentItems || []).find((entry) => entry.id === c.req.param('id'));
    if (!item) return error(c, 404, 'content_not_found', 'Content item was not found');
    return c.json({ ok: true, contentItem: item, data: item });
  };
  app.get('/api/admin/content/:id', adminContentGetHandler);
  app.get('/api/admin/content-items/:id', adminContentGetHandler);

  const adminContentCreateHandler = async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const reason = requiredReason(body, 'content_reason_required');
    const contentItem = await store.mutate(async (draft) => {
      const now = new Date().toISOString();
      const normalized = validateContentItem(body, { now });
      if (normalized.projectId && !draft.projects.some((item) => item.id === normalized.projectId)) {
        throw new DomainError('Project was not found', 'project_not_found', 404);
      }
      if (normalized.type === 'project_update' && !normalized.projectId) {
        throw new DomainError('project_update requires projectId', 'content_project_required', 409);
      }
      const record = {
        id: `content-${randomUUID()}`, demo: false, ...normalized, createdAt: now, updatedAt: now,
      };
      draft.contentItems ||= [];
      draft.contentItems.push(record);
      await store.appendAudit(draft, {
        entityType: 'content_item', entityId: record.id, action: 'content.created', actor: actorFrom(c),
        before: null, after: record, reason,
      });
      return record;
    });
    return c.json({ ok: true, contentItem, data: contentItem }, 201);
  };
  app.post('/api/admin/content', adminContentCreateHandler);
  app.post('/api/admin/content-items', adminContentCreateHandler);

  const adminContentPatchHandler = async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const reason = requiredReason(body, 'content_reason_required');
    const contentItem = await store.mutate(async (draft) => {
      const index = (draft.contentItems || []).findIndex((item) => item.id === c.req.param('id'));
      if (index < 0) throw new DomainError('Content item was not found', 'content_not_found', 404);
      const before = structuredClone(draft.contentItems[index]);
      if (before.archivedAt) throw new DomainError('Archived content cannot be republished', 'content_archived', 409);
      const now = new Date().toISOString();
      const candidate = {
        ...before,
        ...body,
        videoUrl: body.videoUrl ?? (body.type === 'video' ? body.url : undefined) ?? before.videoUrl,
        riskDisclosure: body.riskDisclosure ?? body.riskNotice ?? before.riskDisclosure,
      };
      if (body.status === 'published' && before.status !== 'published' && body.publishedAt === undefined) {
        candidate.publishedAt = now;
      }
      const normalized = validateContentItem(candidate, { now });
      if (normalized.projectId && !draft.projects.some((item) => item.id === normalized.projectId)) {
        throw new DomainError('Project was not found', 'project_not_found', 404);
      }
      if (normalized.type === 'project_update' && !normalized.projectId) {
        throw new DomainError('project_update requires projectId', 'content_project_required', 409);
      }
      const next = { ...before, ...normalized, updatedAt: now };
      draft.contentItems[index] = next;
      await store.appendAudit(draft, {
        entityType: 'content_item', entityId: next.id, action: 'content.updated', actor: actorFrom(c),
        before, after: next, reason,
      });
      return next;
    });
    return c.json({ ok: true, contentItem, data: contentItem });
  };
  app.patch('/api/admin/content/:id', adminContentPatchHandler);
  app.patch('/api/admin/content-items/:id', adminContentPatchHandler);

  const adminContentDeleteHandler = async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const reason = requiredReason(body, 'content_reason_required');
    const removed = await store.mutate(async (draft) => {
      const index = (draft.contentItems || []).findIndex((item) => item.id === c.req.param('id'));
      if (index < 0) throw new DomainError('Content item was not found', 'content_not_found', 404);
      const item = draft.contentItems[index];
      const before = structuredClone(item);
      const now = new Date().toISOString();
      item.status = 'draft';
      item.publishedAt = null;
      item.archivedAt = now;
      item.updatedAt = now;
      await store.appendAudit(draft, {
        entityType: 'content_item', entityId: item.id, action: 'content.archived', actor: actorFrom(c),
        before, after: item, reason,
      });
      return item;
    });
    return c.json({ ok: true, contentItem: removed, data: removed });
  };
  app.delete('/api/admin/content/:id', adminContentDeleteHandler);
  app.delete('/api/admin/content-items/:id', adminContentDeleteHandler);

  const adminMatchesHandler = (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const leadId = c.req.query('leadId');
    const memberId = c.req.query('memberId');
    if (leadId) {
      const lead = (data.leads || []).find((item) => item.id === leadId);
      if (!lead) return error(c, 404, 'lead_not_found', 'Lead was not found');
      const result = { subjectType: 'lead', subjectId: lead.id, matches: leadMatches(data, lead) };
      return c.json({ ok: true, ...result, data: result });
    }
    if (memberId) {
      const member = data.members.find((item) => item.id === memberId);
      if (!member) return error(c, 404, 'member_not_found', 'Member was not found');
      const result = { subjectType: 'member', subjectId: member.id, matches: memberMatches(data, member) };
      return c.json({ ok: true, ...result, data: result });
    }
    const result = {
      leads: (data.leads || []).map((lead) => ({ leadId: lead.id, matches: leadMatches(data, lead) })),
      members: data.members.map((member) => ({ memberId: member.id, matches: memberMatches(data, member) })),
    };
    return c.json({ ok: true, matches: result, data: result });
  };
  app.get('/api/admin/project-matches', adminMatchesHandler);
  app.get('/api/admin/matches', adminMatchesHandler);

  function validateDigestDate(value) {
    const date = String(value || taipeiDate());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`))) {
      throw new DomainError('date must use YYYY-MM-DD', 'invalid_digest_date');
    }
    return date;
  }

  const digestPreviewForRequest = (c, input = {}) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const date = validateDigestDate(input.date || c.req.query('date'));
    const requestedMemberId = input.memberId || c.req.query('memberId');
    const members = requestedMemberId
      ? data.members.filter((item) => item.id === requestedMemberId)
      : data.members;
    if (requestedMemberId && members.length === 0) return error(c, 404, 'member_not_found', 'Member was not found');
    const previews = members.map((member) => ({
      ...digestForMember(data, member, date),
      preference: newsletterPreference(data, member.id),
    }));
    return c.json({ ok: true, previews, data: previews });
  };
  app.get('/api/admin/newsletters/preview', (c) => digestPreviewForRequest(c));
  app.get('/api/admin/daily-digests/preview', (c) => digestPreviewForRequest(c));
  const digestPreviewPostHandler = async (c) => digestPreviewForRequest(c, await jsonBody(c));
  app.post('/api/admin/newsletters/preview', digestPreviewPostHandler);
  app.post('/api/admin/daily-digests/preview', digestPreviewPostHandler);

  const digestGenerateHandler = async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const reason = requiredReason(body, 'digest_reason_required');
    const date = validateDigestDate(body.date);
    const result = await store.mutate(async (draft) => {
      draft.dailyDigests ||= [];
      const requestedIds = Array.isArray(body.memberIds)
        ? [...new Set(body.memberIds.map(String))]
        : body.memberId ? [String(body.memberId)] : null;
      const members = requestedIds
        ? requestedIds.map((id) => draft.members.find((item) => item.id === id))
        : draft.members;
      if (members.some((item) => !item)) throw new DomainError('Member was not found', 'member_not_found', 404);
      const generated = [];
      const queued = [];
      for (const member of members) {
        let digest = draft.dailyDigests.find((item) => item.memberId === member.id && item.date === date);
        if (!digest) {
          const now = new Date().toISOString();
          digest = {
            id: `digest-${randomUUID()}`,
            ...digestForMember(draft, member, date),
            deliveryChannels: ['in_app'],
            generatedAt: now,
          };
          draft.dailyDigests.push(digest);
          await store.appendAudit(draft, {
            entityType: 'daily_digest', entityId: digest.id, action: 'digest.generated', actor: actorFrom(c),
            before: null, after: digest, reason,
          });
        }
        generated.push(digest);
        const preference = newsletterPreference(draft, member.id);
        if (preference.dailyDigestConsent && body.send !== false) {
          const channels = [...new Set(preference.deliveryChannels)].filter((channel) => (
            (channel === 'line' && preference.lineDeliveryConsent && member.lineUserId)
            || (channel === 'email' && preference.emailDeliveryConsent && member.email)
          ));
          for (const channel of channels) {
            const existing = draft.notifications.find((item) => (
              item.eventType === 'daily_digest.generated'
              && item.memberId === member.id
              && item.channel === channel
              && item.metadata?.date === date
            ));
            if (!existing) queued.push(await enqueueDigestOutbox(draft, digest, member, channel, actorFrom(c)));
          }
        }
      }
      return { generated, queued, skippedExternalDeliveryCount: members.length - new Set(queued.map((item) => item.memberId)).size };
    });
    return c.json({ ok: true, ...result, data: result }, 201);
  };
  app.post('/api/admin/newsletters/generate', digestGenerateHandler);
  app.post('/api/admin/daily-digests/generate', digestGenerateHandler);

  app.get('/api/admin/referrers', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const referrers = store.snapshot().referrers || [];
    return c.json({ ok: true, referrers, data: referrers });
  });

  app.post('/api/admin/referrers', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    if (!String(body.reason || '').trim()) {
      return error(c, 409, 'referrer_reason_required', 'reason is required when creating a referrer');
    }
    const referrer = await store.mutate(async (draft) => {
      const now = new Date().toISOString();
      const normalized = validateReferrer({
        ...body,
        status: body.status || 'active',
        commissionBasis: body.commissionBasis || 'allocated_amount',
      });
      draft.referrers ||= [];
      if (draft.referrers.some((item) => item.code === normalized.code)) {
        throw new DomainError('Referrer code already exists', 'duplicate_referrer_code', 409);
      }
      const record = {
        id: `referrer-${randomUUID()}`,
        demo: false,
        ...normalized,
        createdAt: now,
        updatedAt: now,
      };
      draft.referrers.push(record);
      await store.appendAudit(draft, {
        entityType: 'referrer', entityId: record.id, action: 'referrer.created', actor: actorFrom(c),
        before: null, after: record, reason: String(body.reason || 'Referrer created'),
      });
      return record;
    });
    return c.json({ ok: true, referrer, data: referrer }, 201);
  });

  app.patch('/api/admin/referrers/:id', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    if (!String(body.reason || '').trim()) {
      return error(c, 409, 'referrer_reason_required', 'reason is required when changing a referrer');
    }
    const referrer = await store.mutate(async (draft) => {
      draft.referrers ||= [];
      const index = draft.referrers.findIndex((item) => item.id === c.req.param('id'));
      if (index < 0) throw new DomainError('Referrer was not found', 'referrer_not_found', 404);
      const before = structuredClone(draft.referrers[index]);
      const permitted = Object.fromEntries([
        'code', 'displayName', 'legalName', 'contactName', 'contactEmail', 'status',
        'defaultCommissionRateBps', 'commissionBasis', 'agreementReference', 'effectiveAt', 'expiresAt',
      ].flatMap((field) => body[field] !== undefined ? [[field, body[field]]] : []));
      const normalized = validateReferrer({ ...before, ...permitted });
      if (draft.referrers.some((item, itemIndex) => itemIndex !== index && item.code === normalized.code)) {
        throw new DomainError('Referrer code already exists', 'duplicate_referrer_code', 409);
      }
      const next = { ...before, ...normalized, updatedAt: new Date().toISOString() };
      draft.referrers[index] = next;
      await store.appendAudit(draft, {
        entityType: 'referrer', entityId: next.id, action: 'referrer.updated', actor: actorFrom(c),
        before, after: next, reason: String(body.reason || 'Referrer updated'),
      });
      return next;
    });
    return c.json({ ok: true, referrer, data: referrer });
  });

  app.get('/api/admin/commissions', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const commissions = data.subscriptions
      .filter((item) => item.referralSnapshot)
      .map((item) => enrichedCommission(item, data));
    return c.json({ ok: true, commissions, data: commissions });
  });

  app.get('/api/admin/members', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const members = data.members.map((item) => enrichedMember(item, data));
    return c.json({ ok: true, members, data: members });
  });

  app.get('/api/admin/subscriptions', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const data = store.snapshot();
    const subscriptions = data.subscriptions.map((item) => enrichedSubscription(item, data));
    return c.json({ ok: true, subscriptions, data: subscriptions });
  });

  app.get('/api/admin/actions', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const actions = dashboardActions(store.snapshot());
    return c.json({ ok: true, actions, data: actions });
  });

  app.patch('/api/admin/members/:id', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    if (body.referralAttribution !== undefined && !String(body.reason || '').trim()) {
      return error(c, 409, 'referral_reason_required', 'reason is required when changing referral attribution');
    }
    const updated = await store.mutate(async (draft) => {
      const member = draft.members.find((item) => item.id === c.req.param('id'));
      if (!member) throw new DomainError('Member was not found', 'member_not_found', 404);
      const before = structuredClone(member);
      if (body.membershipState !== undefined) {
        assertTransition('membership', member.membershipState, body.membershipState);
        member.membershipState = body.membershipState;
      }
      if (body.qualificationState !== undefined) {
        assertTransition('qualification', member.qualificationState, body.qualificationState);
        if (body.qualificationState === 'approved') {
          const approval = body.qualificationApproval;
          const approvedAt = Date.parse(approval?.approvedAt || '');
          const expiresAt = Date.parse(approval?.expiresAt || '');
          const clockSkewMs = 5 * 60 * 1000;
          if (!approval?.approver || !approval?.reference || !Number.isFinite(approvedAt)
            || approvedAt > Date.now() + clockSkewMs || !Number.isFinite(expiresAt)
            || expiresAt <= Date.now() || expiresAt <= approvedAt) {
            throw new DomainError('Valid external approval, reference and future expiry evidence are required', 'approval_required', 409);
          }
          member.qualificationApproval = {
            approver: String(approval.approver).trim(),
            approvedAt: new Date(approvedAt).toISOString(),
            reference: String(approval.reference).trim(),
            expiresAt: new Date(expiresAt).toISOString(),
          };
        } else {
          member.qualificationApproval = null;
        }
        member.qualificationState = body.qualificationState;
      }
      if (body.projectAccess !== undefined) {
        if (!Array.isArray(body.projectAccess)) throw new DomainError('projectAccess must be an array');
        member.projectAccess = [...new Set(body.projectAccess.filter((id) => draft.projects.some((item) => item.id === id)))];
      }
      if (body.referralAttribution !== undefined) {
        if (member.leadOwnerAttribution && (
          body.referralAttribution === null
          || body.referralAttribution?.referrerId !== member.leadOwnerAttribution.referrerId
        )) {
          throw new DomainError('Lead owner attribution is immutable', 'lead_owner_locked', 409);
        }
        if (body.referralAttribution === null) {
          member.referralAttribution = null;
        } else {
          const input = bodyObject(body.referralAttribution);
          const evidenceReference = String(input.evidenceReference || '').trim();
          const referrer = (draft.referrers || []).find((item) => item.id === input.referrerId);
          const now = new Date().toISOString();
          if (!referrer) throw new DomainError('Referrer was not found', 'referrer_not_found', 404);
          if (!isReferrerEffective(referrer, now)) {
            throw new DomainError('Referrer must be active and effective', 'referrer_not_effective', 409);
          }
          if (!evidenceReference) {
            throw new DomainError('evidenceReference is required to verify attribution', 'referral_evidence_required', 409);
          }
          member.referralAttribution = {
            referrerId: referrer.id,
            referralCode: referrer.code,
            state: 'verified',
            evidenceReference,
            claimedAt: member.referralAttribution?.referrerId === referrer.id
              ? member.referralAttribution.claimedAt || now
              : now,
            verifiedAt: now,
            verifiedBy: actorFrom(c).id,
          };
        }
      }
      if (body.investmentPreferences !== undefined) {
        member.investmentPreferences = normalizeInvestmentPreferences(body.investmentPreferences);
      }
      if (body.tier !== undefined) member.tier = String(body.tier);
      member.updatedAt = new Date().toISOString();
      await store.appendAudit(draft, {
        entityType: 'member', entityId: member.id, action: 'member.updated', actor: actorFrom(c),
        before, after: member, reason: String(body.reason || 'Operations update'),
      });
      const eventType = body.qualificationState ? `qualification.${body.qualificationState}` : body.membershipState ? `membership.${body.membershipState}` : null;
      if (eventType) await queueNotification(draft, { member, eventType, actor: actorFrom(c) });
      return member;
    });
    const visible = enrichedMember(updated, store.snapshot());
    return c.json({ ok: true, member: visible, data: visible });
  });

  app.get('/api/admin/projects', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const projects = store.snapshot().projects;
    return c.json({ ok: true, projects, data: projects });
  });

  app.patch('/api/admin/projects/:id', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const project = await store.mutate(async (draft) => {
      const current = draft.projects.find((item) => item.id === c.req.param('id'));
      if (!current) throw new DomainError('Project was not found', 'project_not_found', 404);
      const before = structuredClone(current);
      for (const field of ['displayName', 'summary', 'publicVisibility', 'videoUrl']) {
        if (body[field] !== undefined) current[field] = String(body[field]);
      }
      if (body.memberAllowlist !== undefined) current.memberAllowlist = [...new Set(body.memberAllowlist)];
      current.updatedAt = new Date().toISOString();
      await store.appendAudit(draft, {
        entityType: 'project', entityId: current.id, action: 'project.updated', actor: actorFrom(c),
        before, after: current, reason: String(body.reason || 'Operations project update'),
      });
      return current;
    });
    return c.json({ ok: true, project, data: project });
  });

  app.patch('/api/admin/subscriptions/:id', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const normalizedBody = {
      ...body,
      ...(body.subscriptionStatus !== undefined ? { subscriptionState: body.subscriptionStatus } : {}),
      ...(body.fundingStatus !== undefined ? { fundingState: body.fundingStatus } : {}),
      ...(body.allocationStatus !== undefined ? { allocationState: body.allocationStatus } : {}),
      ...Object.fromEntries(AMOUNT_FIELDS.flatMap((field) => {
        const alias = field.replace('AmountTwd', 'Amount');
        return body[alias] !== undefined ? [[field, body[alias]]] : [];
      })),
    };
    const subscription = await store.mutate(async (draft) => {
      const index = draft.subscriptions.findIndex((item) => item.id === c.req.param('id'));
      if (index < 0) throw new DomainError('Subscription was not found', 'subscription_not_found', 404);
      const before = structuredClone(draft.subscriptions[index]);
      const next = updateSubscriptionRecord(before, normalizedBody, new Date().toISOString());
      draft.subscriptions[index] = next;
      await store.appendAudit(draft, {
        entityType: 'subscription', entityId: next.id, action: 'subscription.updated', actor: actorFrom(c),
        before, after: next, reason: String(body.reason || 'Operations subscription update'),
      });
      const member = draft.members.find((item) => item.id === next.memberId);
      const changedState = ['subscription', 'funding', 'allocation'].find((workflow) => before[`${workflow}State`] !== next[`${workflow}State`]);
      if (member && changedState) {
        await queueNotification(draft, {
          member, eventType: `${changedState}.${next[`${changedState}State`]}`, actor: actorFrom(c),
          manual: next[`${changedState}State`] === 'refunded', metadata: { subscriptionId: next.id },
        });
      }
      return next;
    });
    const visible = enrichedSubscription(subscription, store.snapshot());
    return c.json({ ok: true, subscription: visible, data: visible });
  });

  app.patch('/api/admin/commissions/:subscriptionId', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const subscription = await store.mutate(async (draft) => {
      const index = draft.subscriptions.findIndex((item) => item.id === c.req.param('subscriptionId'));
      if (index < 0) throw new DomainError('Subscription was not found', 'subscription_not_found', 404);
      const before = structuredClone(draft.subscriptions[index]);
      const next = updateCommissionRecord(before, {
        action: body.action,
        approvalReference: body.approvalReference,
        payoutReference: body.payoutReference,
        voidReason: body.voidReason,
        reason: body.reason,
        actorId: actorFrom(c).id,
      }, new Date().toISOString());
      draft.subscriptions[index] = next;
      await store.appendAudit(draft, {
        entityType: 'commission', entityId: next.id, action: `commission.${body.action}`,
        actor: actorFrom(c), before, after: next, reason: String(body.reason).trim(),
      });
      return next;
    });
    const visible = enrichedCommission(subscription, store.snapshot());
    return c.json({ ok: true, commission: visible, data: visible });
  });

  app.get('/api/admin/notifications', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const notifications = store.snapshot().notifications;
    return c.json({ ok: true, notifications, data: notifications });
  });

  app.post('/api/admin/notifications', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const body = await jsonBody(c);
    const notification = await store.mutate(async (draft) => {
      const member = draft.members.find((item) => item.id === body.memberId);
      if (!member) throw new DomainError('Member was not found', 'member_not_found', 404);
      return enqueueNotification(draft, store, {
        member,
        eventType: String(body.eventType || 'manual.status_update'),
        actor: actorFrom(c),
        manual: body.confirm !== true,
        metadata: body.metadata || {},
        autoDelivery: false,
      });
    });
    return c.json({ ok: true, notification, data: notification }, 201);
  });

  app.post('/api/admin/notifications/:id/send', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const result = await deliverNotification(c.req.param('id'), actorFrom(c), { force: true });
    if (!result.ok) {
      return c.json({ ok: false, notification: result.notification, error: { code: 'line_push_failed', message: result.notification.lastError } }, 502);
    }
    return c.json({ ok: true, notification: result.notification, data: result.notification });
  });

  app.post('/api/admin/notifications/process', async (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const queued = store.snapshot().notifications
      .filter((item) => item.status === 'queued' && item.attempts < NOTIFICATION_MAX_ATTEMPTS)
      .slice(0, 20)
      .map((item) => item.id);
    const results = [];
    for (const id of queued) results.push(await deliverNotification(id, actorFrom(c)));
    const summary = {
      processed: results.length,
      sent: results.filter((item) => item.ok).length,
      retrying: results.filter((item) => !item.ok && item.notification.status === 'queued').length,
      failed: results.filter((item) => !item.ok && item.notification.status === 'failed').length,
    };
    return c.json({ ok: true, summary, data: summary });
  });

  app.get('/api/admin/audits', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const entityType = c.req.query('entityType');
    const entityId = c.req.query('entityId');
    let audits = store.snapshot().audits;
    if (entityType) audits = audits.filter((item) => item.entityType === entityType);
    if (entityId) audits = audits.filter((item) => item.entityId === entityId);
    return c.json({ ok: true, audits, data: audits });
  });

  app.get('/api/admin/export/leads.xlsx', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const bytes = createLeadXlsx(store.snapshot());
    c.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('content-disposition', `attachment; filename="${leadXlsxFilename()}"`);
    c.header('x-zhifu-export-schema', LEAD_EXPORT_SCHEMA_VERSION);
    return c.body(bytes);
  });

  app.get('/api/admin/export/:filename', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const filename = c.req.param('filename');
    const resource = filename.endsWith('.csv') ? filename.slice(0, -4) : filename;
    const data = store.snapshot();
    const fields = resource === 'members'
      ? ['id', 'displayName', 'phone', 'email', 'membershipState', 'qualificationState', 'tier', 'sourceGroup', 'referrerName', 'referralAttribution', 'updatedAt']
      : resource === 'subscriptions'
        ? ['id', 'memberId', 'projectId', 'subscriptionState', 'fundingState', 'allocationState', ...AMOUNT_FIELDS, 'acquisitionAttributionSnapshot', 'referralSnapshot', 'commissionState', 'commissionBasisAmountTwd', 'commissionAccruedAmountTwd', 'updatedAt']
        : resource === 'referrers'
          ? ['id', 'code', 'displayName', 'legalName', 'contactName', 'contactEmail', 'status', 'defaultCommissionRateBps', 'commissionBasis', 'agreementReference', 'effectiveAt', 'expiresAt', 'createdAt', 'updatedAt']
          : resource === 'commissions'
            ? ['id', 'memberId', 'projectId', 'referrerId', 'referrerName', 'referralCode', 'commissionRateBps', 'commissionBasis', 'agreementReference', 'commissionState', 'commissionBasisAmountTwd', 'commissionAccruedAmountTwd', 'commissionApproval', 'commissionPayment', 'commissionVoidReason', 'updatedAt']
            : resource === 'leads'
              ? LEAD_EXPORT_FIELDS
              : null;
    if (!fields) return error(c, 404, 'export_not_found', 'Supported exports are members, subscriptions, referrers, commissions and leads');
    const rows = resource === 'members'
      ? data.members.map((item) => enrichedMember(item, data))
      : resource === 'leads'
        ? leadExportRows(data)
      : resource === 'commissions'
        ? data.subscriptions.filter((item) => item.referralSnapshot).map((item) => ({
          ...item,
          referrerId: item.referralSnapshot.referrerId,
          referrerName: item.referralSnapshot.referrerName,
          referralCode: item.referralSnapshot.referralCode,
          commissionRateBps: item.referralSnapshot.commissionRateBps,
          commissionBasis: item.referralSnapshot.commissionBasis,
          agreementReference: item.referralSnapshot.agreementReference,
        }))
        : data[resource];
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${resource}.csv"`);
    return c.body(`\uFEFF${toCsv(rows, fields)}`);
  });

  app.get('/api/*', (c) => error(c, 404, 'not_found', 'API endpoint was not found'));

  app.use('/*', serveStatic({ root: staticRoot }));
  app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));
  return app;
}
