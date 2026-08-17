import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  AMOUNT_FIELDS,
  DomainError,
  assertTransition,
  canAccessProtectedProject,
  createSubscriptionRecord,
  memberProject,
  publicProject,
  redactMember,
  updateSubscriptionRecord,
} from './domain.js';
import { createSessionManager, parseCookies, requireRole } from './auth.js';
import { createLineProvider, statusMessage } from './line.js';
import { createDemoDeckPdf } from './pdf.js';

const ADMIN_ROLE = 'admin';

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
  return `"${string.replaceAll('"', '""')}"`;
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
    memberName: member?.displayName || '未知會員',
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

function enrichedMember(member, data) {
  const subscriptions = data.subscriptions.filter((item) => item.memberId === member.id);
  return {
    ...member,
    name: member.displayName,
    source: member.sourceGroup,
    membership: member.membershipState,
    qualification: member.qualificationState,
    lineFriend: member.lineFriendshipState === 'friend',
    requested: subscriptions.reduce((sum, item) => sum + item.requestedAmountTwd, 0),
    received: subscriptions.reduce((sum, item) => sum + item.receivedAmountTwd, 0),
  };
}

function dashboardOverview(data) {
  const sums = Object.fromEntries(AMOUNT_FIELDS.map((field) => [field, data.subscriptions.reduce((sum, item) => sum + item[field], 0)]));
  return {
    memberCount: data.members.length,
    pendingMemberCount: data.members.filter((item) => item.membershipState === 'pending').length,
    needsInformationCount: data.members.filter((item) => item.qualificationState === 'needs_information').length,
    pendingPartnerReviewCount: data.subscriptions.filter((item) => item.subscriptionState === 'partner_review').length,
    notificationAttentionCount: data.notifications.filter((item) => ['awaiting_confirmation', 'configuration_required', 'failed'].includes(item.status)).length,
    ...sums,
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
      if (record.status === 'sent') return record;
      if (!force && (record.status === 'awaiting_confirmation' || record.attempts >= 3)) return record;
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
        record.status = record.attempts >= 3 ? 'failed' : 'queued';
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
    id: 'operations-xuefen',
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
      member: member ? publicMemberView(member) : null,
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
      payload = { role, adminId: 'admin-xuefen-demo' };
      subject = { id: 'admin-xuefen-demo', displayName: '雪芬姐 DEMO', role };
    } else {
      const member = data.members.find((item) => item.id === (body.memberId || 'member-001'));
      if (!member) return error(c, 404, 'member_not_found', 'Demo member was not found');
      payload = { role, memberId: member.id };
      subject = publicMemberView(member);
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
        id: `member-${randomUUID()}`, demo: false, displayName, phone: '', email: '', lineUserId,
        lineFriendshipState: 'unknown', sourceGroup: '', membershipState: 'pending',
        qualificationState: 'not_applied', qualificationApproval: null, tier: 'free', projectAccess: [],
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
      const result = { role: 'member', member: publicMemberView(member) };
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

  app.post('/api/activation', async (c) => {
    const denied = gate(c, ['member']);
    if (denied) return denied;
    const body = await jsonBody(c);
    if (!body.fullName || !body.phone || !body.sourceCode) {
      return error(c, 400, 'missing_fields', 'fullName, phone and sourceCode are required');
    }
    const result = await store.mutate(async (draft) => {
      const member = sessionMember(c, draft);
      if (!member) throw new DomainError('Member not found', 'member_not_found', 404);
      const before = structuredClone(member);
      member.displayName = String(body.fullName).trim();
      member.phone = String(body.phone).trim();
      member.sourceGroup = String(body.sourceCode).trim();
      member.membershipState = 'pending';
      member.updatedAt = new Date().toISOString();
      const activation = {
        id: `activation-${randomUUID()}`, memberId: member.id, status: 'pending',
        sourceCode: member.sourceGroup, submittedAt: member.updatedAt,
      };
      draft.activations.push(activation);
      await store.appendAudit(draft, {
        entityType: 'member', entityId: member.id, action: 'activation.submitted', actor: actorFrom(c),
        before, after: member, reason: 'Member submitted community activation',
      });
      await queueNotification(draft, { member, eventType: 'activation.received', actor: actorFrom(c) });
      await queueOperationsNotification(draft, 'operations.activation_received', { memberId: member.id });
      return activation;
    });
    return c.json({ ok: true, activation: result, data: result }, 201);
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
    const visible = subscriptions.map((item) => enrichedSubscription(item, data));
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
        requestedAmountTwd: body.requestedAmountTwd ?? body.requestedAmount, now,
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
    const response = { ...result, subscription: enrichedSubscription(result.subscription, store.snapshot()) };
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
      },
      members: data.members.map((item) => enrichedMember(item, data)),
      subscriptions: data.subscriptions.map((item) => enrichedSubscription(item, data)),
      actions: dashboardActions(data),
    };
    return c.json({ ok: true, dashboard, data: dashboard });
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
          if (!approval?.approver || !approval?.approvedAt || !approval?.reference) {
            throw new DomainError('External partner approval evidence is required', 'approval_required', 409);
          }
          member.qualificationApproval = approval;
        }
        member.qualificationState = body.qualificationState;
      }
      if (body.projectAccess !== undefined) {
        if (!Array.isArray(body.projectAccess)) throw new DomainError('projectAccess must be an array');
        member.projectAccess = [...new Set(body.projectAccess.filter((id) => draft.projects.some((item) => item.id === id)))];
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
    return c.json({ ok: true, member: updated, data: updated });
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
      .filter((item) => item.status === 'queued' && item.attempts < 3)
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

  app.get('/api/admin/export/:filename', (c) => {
    const denied = gate(c, [ADMIN_ROLE]);
    if (denied) return denied;
    const filename = c.req.param('filename');
    const resource = filename.endsWith('.csv') ? filename.slice(0, -4) : filename;
    const data = store.snapshot();
    const fields = resource === 'members'
      ? ['id', 'displayName', 'phone', 'email', 'membershipState', 'qualificationState', 'tier', 'sourceGroup', 'updatedAt']
      : resource === 'subscriptions'
        ? ['id', 'memberId', 'projectId', 'subscriptionState', 'fundingState', 'allocationState', ...AMOUNT_FIELDS, 'updatedAt']
        : null;
    if (!fields) return error(c, 404, 'export_not_found', 'Supported exports are members and subscriptions');
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${resource}.csv"`);
    return c.body(`\uFEFF${toCsv(data[resource], fields)}`);
  });

  app.get('/api/*', (c) => error(c, 404, 'not_found', 'API endpoint was not found'));

  app.use('/*', serveStatic({ root: staticRoot }));
  app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));
  return app;
}
