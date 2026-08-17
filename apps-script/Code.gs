/** Web entry points, setup helpers and operation dispatch. */

function nowIso_() {
  return new Date().toISOString();
}

function createId_(prefix) {
  return prefix + '-' + Utilities.getUuid().toLowerCase();
}

function jsonOutput_(body) {
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function publicError_(error) {
  var code = error && error.code ? error.code : 'internal_error';
  var safeMessage = error && error.code ? error.message : 'Unexpected server error';
  console.error(JSON.stringify({ code: code, message: error && error.message, stack: error && error.stack }));
  return { code: code, message: safeMessage };
}

/**
 * Only accepts the signed JSON envelope produced by the Cloudflare Worker.
 * Apps Script cannot reliably expose custom request headers, hence the body signature.
 */
function doPost(event) {
  try {
    if (!event || !event.postData || !event.postData.contents) {
      throw domainError_('POST body is required', 'invalid_envelope');
    }
    var envelope;
    try {
      envelope = JSON.parse(event.postData.contents);
    } catch (error) {
      throw domainError_('POST body must be JSON', 'invalid_envelope');
    }
    var secret = PropertiesService.getScriptProperties().getProperty('GATEWAY_SHARED_SECRET');
    if (!secret || secret.length < 32) {
      throw domainError_('GATEWAY_SHARED_SECRET must contain at least 32 characters', 'configuration_error', 500);
    }
    var payload = verifyGatewayEnvelope_(envelope, secret);
    var data = withStoreLock_(function () {
      assertAndStoreNonce_(envelope);
      return dispatchOperation_(envelope.operation, payload);
    });
    return jsonOutput_({ ok: true, data: data });
  } catch (error) {
    return jsonOutput_({ ok: false, error: publicError_(error) });
  }
}

function doGet() {
  try {
    assertAdminIdentity_();
    return HtmlService.createTemplateFromFile('Admin').evaluate()
      .setTitle('致富投資｜雪芬姐營運儀表板')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DENY);
  } catch (error) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<title>沒有存取權</title><main style="font:16px system-ui;max-width:38rem;margin:15vh auto;padding:24px">' +
      '<h1>無法開啟營運儀表板</h1><p>請以已列入 ADMIN_EMAILS 的 Google 帳號登入後再試。</p></main>'
    );
  }
}

function setupWorkbook(spreadsheetId) {
  var workbook;
  if (spreadsheetId) {
    workbook = SpreadsheetApp.openById(String(spreadsheetId));
  } else {
    workbook = SpreadsheetApp.getActiveSpreadsheet();
    if (!workbook) workbook = SpreadsheetApp.create('致富投資｜營運資料');
  }
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', workbook.getId());
  withStoreLock_(function () {
    initializeWorkbookSchema_(workbook);
  });
  return { spreadsheetId: workbook.getId(), url: workbook.getUrl(), sheets: Object.keys(ZF_SCHEMA) };
}

function assertAdminIdentity_() {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  var configured = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '';
  var allowlist = configured.split(',').map(function (value) {
    return value.trim().toLowerCase();
  }).filter(Boolean);
  if (!email || allowlist.indexOf(email) === -1) {
    throw domainError_('Google account is not authorized', 'forbidden', 403);
  }
  return { type: 'admin', id: email, email: email, role: 'admin' };
}

/** Called only by the HtmlService dashboard through google.script.run. */
function adminRpc(request) {
  try {
    var actor = assertAdminIdentity_();
    if (!request || typeof request.operation !== 'string') {
      throw domainError_('operation is required', 'invalid_request');
    }
    var payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
    payload.context = { role: 'admin', actorId: actor.id };
    var data = withStoreLock_(function () {
      return dispatchOperation_(request.operation, payload);
    });
    return { ok: true, data: data };
  } catch (error) {
    return { ok: false, error: publicError_(error) };
  }
}

function normalizeContext_(payload) {
  var raw = payload && payload.context && typeof payload.context === 'object' ? payload.context :
    (payload && payload.actor && typeof payload.actor === 'object' ? payload.actor : {});
  return {
    role: raw.role || 'visitor',
    actorId: raw.actorId || raw.memberId || raw.lineUserId || 'anonymous',
    memberId: raw.memberId || '',
    requestId: raw.requestId || ''
  };
}

function actorFromContext_(context) {
  return {
    type: context.role === 'admin' ? 'admin' : context.role === 'service' ? 'service' : 'member',
    id: context.actorId || context.memberId || 'anonymous'
  };
}

function requireRecord_(sheetName, id) {
  var record = storeFindById_(sheetName, id);
  if (!record) throw domainError_(sheetName + ' record not found', 'not_found', 404);
  return record;
}

function dispatchOperation_(operation, payload) {
  var handlers = {
    upsertLineMember: operationUpsertLineMember_,
    getMember: operationGetMember_,
    listProjects: operationListProjects_,
    getProject: operationGetProject_,
    listSubscriptions: operationListSubscriptions_,
    createBooking: operationCreateBooking_,
    createActivation: operationCreateActivation_,
    createSubscription: operationCreateSubscription_,
    authorizeDeck: operationAuthorizeDeck_,
    deckDownloadAudit: operationDeckDownloadAudit_,
    webhookEvent: operationWebhookEvent_,
    authenticateAdmin: operationAuthenticateAdmin_,
    adminDashboard: operationAdminDashboard_,
    adminList: operationAdminList_,
    adminPatchMember: operationAdminPatchMember_,
    adminPatchProject: operationAdminPatchProject_,
    adminPatchSubscription: operationAdminPatchSubscription_,
    adminApproveNotification: operationAdminApproveNotification_,
    adminCreateBulkNotification: operationAdminCreateBulkNotification_,
    adminProcessNotifications: operationAdminProcessNotifications_,
    adminExport: operationAdminExport_
  };
  var aliases = {
    'projects.list': function (value) { return operationListProjects_(value, normalizeContext_(value)); },
    'projects.get': function (value) {
      value.projectId = value.projectId || (value.params && value.params.projectId);
      return operationGetProject_(value, normalizeContext_(value));
    },
    'activation.create': function (value) {
      value.activation = value.activation || value.body || value;
      return operationCreateActivation_(value, normalizeContext_(value));
    },
    'bookings.list': function (value) { return operationListBookings_(value, normalizeContext_(value)); },
    'bookings.create': function (value) {
      value.booking = value.booking || value.body || value;
      return operationCreateBooking_(value, normalizeContext_(value));
    },
    'subscriptions.list': function (value) { return operationListSubscriptions_(value, normalizeContext_(value)); },
    'subscriptions.create': function (value) {
      var body = value.body || value;
      value.projectId = body.projectId;
      value.requestedAmountTwd = body.requestedAmountTwd;
      value.idempotencyKey = value.idempotencyKey || body.idempotencyKey;
      return operationCreateSubscription_(value, normalizeContext_(value));
    },
    'auth.line.resolve': operationResolveLineIdentity_,
    'member.self': operationGetMember_,
    'auth.admin.authenticate': operationAuthenticateAdmin_,
    'deck.authorize': operationDeckAuthorizeAlias_,
    'deck.download.audit': operationDeckDownloadAudit_,
    'line.webhook.ingest': operationWebhookIngest_,
    'admin.dashboard': function (value) { return operationAdminDashboard_(value, normalizeContext_(value)); },
    'admin.overview': function (value) { return operationAdminDashboard_(value, normalizeContext_(value)); },
    'admin.members.list': function (value) { value.resource = 'members'; return operationAdminList_(value, normalizeContext_(value)); },
    'admin.projects.list': function (value) { value.resource = 'projects'; return operationAdminList_(value, normalizeContext_(value)); },
    'admin.subscriptions.list': function (value) { value.resource = 'subscriptions'; return operationAdminList_(value, normalizeContext_(value)); },
    'admin.actions.list': operationAdminActionsAlias_,
    'admin.notifications.list': function (value) { value.resource = 'notifications'; return operationAdminList_(value, normalizeContext_(value)); },
    'admin.notifications.create': operationAdminNotificationCreateAlias_,
    'admin.audits.list': function (value) { value.resource = 'audits'; return operationAdminList_(value, normalizeContext_(value)); },
    'admin.members.update': operationAdminMemberUpdateAlias_,
    'admin.projects.update': operationAdminProjectUpdateAlias_,
    'admin.subscriptions.update': operationAdminSubscriptionUpdateAlias_,
    'admin.notifications.send': operationAdminNotificationSendAlias_,
    'admin.exports.members': function (value) { value.resource = 'members'; return operationAdminExport_(value, normalizeContext_(value)); },
    'admin.exports.subscriptions': function (value) { value.resource = 'subscriptions'; return operationAdminExport_(value, normalizeContext_(value)); }
  };
  if (aliases[operation]) return aliases[operation](payload || {});
  if (!handlers[operation]) throw domainError_('Unknown operation: ' + operation, 'unknown_operation', 404);
  return handlers[operation](payload || {}, normalizeContext_(payload || {}));
}

function operationResolveLineIdentity_(payload) {
  var result = operationUpsertLineMember_({
    member: {
      lineUserId: payload.lineUserId,
      displayName: payload.displayName,
      lineFriendshipState: payload.friendshipStatus
    },
    context: { role: 'service', actorId: 'cloudflare-line-auth', requestId: payload.requestId || '' }
  }, { role: 'service', actorId: 'cloudflare-line-auth', requestId: payload.requestId || '' });
  return { memberId: result.id };
}

function operationListBookings_(payload, context) {
  assertRole_(context, ['member', 'qualified', 'admin']);
  var memberId = context.role === 'admin' ? normalizeOptionalString_(payload.memberId || (payload.query && payload.query.memberId), 100) : context.memberId;
  if (context.role !== 'admin') assertOwnMemberScope_(context, memberId);
  return { bookings: storeList_('Bookings').filter(function (booking) {
    return memberId ? booking.memberId === memberId : true;
  }) };
}

function operationDeckAuthorizeAlias_(payload) {
  var context = normalizeContext_(payload);
  var result = operationAuthorizeDeck_(payload, context).authorization;
  return {
    allowed: result.allowed,
    objectKey: result.objectKey,
    filename: result.filename,
    contentType: result.contentType,
    expiresAt: result.expiresAt
  };
}

function operationDeckDownloadAudit_(payload) {
  var context = normalizeContext_(payload);
  assertRole_(context, ['member', 'qualified', 'admin']);
  appendAudit_({
    entityType: 'deck', entityId: payload.projectId || '', action: 'deck.downloaded',
    actor: actorFromContext_(context), before: null,
    after: { objectKey: payload.objectKey || '', downloadedAt: payload.downloadedAt || Date.now() },
    requestId: payload.requestId || ''
  });
  return { accepted: true };
}

function operationWebhookIngest_(payload) {
  var context = { role: 'service', actorId: 'cloudflare-line-webhook', requestId: payload.requestId || '' };
  var events = Array.isArray(payload.events) ? payload.events : [];
  var results = events.map(function (event) {
    return operationWebhookEvent_({ event: {
      webhookEventId: event.webhookEventId,
      type: event.type,
      lineUserId: event.source && event.source.userId
    } }, context);
  });
  return { accepted: results.length, results: results };
}

function adminAliasPayload_(payload, idField) {
  var context = normalizeContext_(payload);
  var result = {
    context: context,
    patch: payload.body && payload.body.patch ? payload.body.patch : (payload.body || {}),
    reason: payload.body && payload.body.reason ? payload.body.reason : ''
  };
  result[idField] = payload[idField] || (payload.params && payload.params[idField]);
  return result;
}

function operationAdminMemberUpdateAlias_(payload) {
  var value = adminAliasPayload_(payload, 'memberId');
  return operationAdminPatchMember_(value, value.context);
}

function operationAdminProjectUpdateAlias_(payload) {
  var value = adminAliasPayload_(payload, 'projectId');
  return operationAdminPatchProject_(value, value.context);
}

function operationAdminSubscriptionUpdateAlias_(payload) {
  var value = adminAliasPayload_(payload, 'subscriptionId');
  return operationAdminPatchSubscription_(value, value.context);
}

function operationAdminActionsAlias_(payload) {
  var dashboard = operationAdminDashboard_(payload, normalizeContext_(payload));
  return { actions: dashboard.actionQueue };
}

function operationAdminNotificationCreateAlias_(payload) {
  var body = payload.body || payload;
  payload.memberIds = body.memberIds;
  payload.announcementId = body.announcementId;
  return operationAdminCreateBulkNotification_(payload, normalizeContext_(payload));
}

function operationAdminNotificationSendAlias_(payload) {
  var value = {
    notificationId: payload.notificationId || (payload.params && payload.params.notificationId),
    reason: payload.body && payload.body.reason,
    context: normalizeContext_(payload)
  };
  return operationAdminApproveNotification_(value, value.context);
}

function operationUpsertLineMember_(payload, context) {
  assertRole_(context, ['service', 'admin']);
  var input = payload.member || {};
  var lineUserId = assertRequiredString_(input.lineUserId, 'member.lineUserId', 200);
  var existing = storeList_('Members').filter(function (member) {
    return member.lineUserId === lineUserId;
  })[0] || null;
  var now = nowIso_();
  var next = existing ? Object.assign({}, existing) : {
    id: createId_('member'),
    demo: false,
    legalName: '',
    phone: '',
    email: '',
    sourceGroup: '',
    membershipState: 'pending',
    qualificationState: 'not_applied',
    qualificationApproval: null,
    tier: 'free',
    projectAccess: [],
    createdAt: now
  };
  next.displayName = assertRequiredString_(input.displayName, 'member.displayName', 100);
  next.lineUserId = lineUserId;
  next.lineFriendshipState = ['friend', 'not_friend', 'unknown'].indexOf(input.lineFriendshipState) !== -1 ?
    input.lineFriendshipState : 'unknown';
  next.updatedAt = now;
  storePut_('Members', next);
  appendAudit_({
    entityType: 'member', entityId: next.id,
    action: existing ? 'member.line_profile_updated' : 'member.created_from_line',
    actor: actorFromContext_(context), before: existing, after: next,
    requestId: context.requestId
  });
  return sanitizeMemberForSelf_(next);
}

function operationGetMember_(payload, context) {
  assertRole_(context, ['member', 'qualified', 'admin']);
  var memberId = context.role === 'admin' ? normalizeOptionalString_(payload.memberId, 100) : context.memberId;
  if (!memberId) throw domainError_('Member identity is not linked', 'not_found', 404);
  assertOwnMemberScope_(context, memberId);
  return { member: sanitizeMemberForSelf_(requireRecord_('Members', memberId)) };
}

function memberForContext_(context) {
  if (!context.memberId) return null;
  return requireRecord_('Members', context.memberId);
}

function operationListProjects_(payload, context) {
  assertRole_(context, ['visitor', 'member', 'qualified', 'admin', 'service']);
  var member = context.role === 'member' || context.role === 'qualified' ? memberForContext_(context) : null;
  return { projects: filterProjectsForActor_(storeList_('Projects'), member, context.role) };
}

function operationGetProject_(payload, context) {
  assertRole_(context, ['visitor', 'member', 'qualified', 'admin', 'service']);
  var project = requireRecord_('Projects', assertRequiredString_(payload.projectId, 'projectId', 100));
  var member = context.role === 'member' || context.role === 'qualified' ? memberForContext_(context) : null;
  return { project: projectViewForActor_(project, member, context.role) };
}

function operationListSubscriptions_(payload, context) {
  assertRole_(context, ['member', 'qualified', 'admin']);
  var memberId = context.role === 'admin' ? normalizeOptionalString_(payload.memberId, 100) : context.memberId;
  if (context.role !== 'admin') assertOwnMemberScope_(context, memberId);
  var records = storeList_('Subscriptions').filter(function (record) {
    return memberId ? record.memberId === memberId : true;
  });
  return { subscriptions: records };
}

function operationCreateBooking_(payload, context) {
  assertRole_(context, ['visitor', 'member', 'qualified', 'admin', 'service']);
  var input = payload.booking || {};
  var member = context.memberId ? storeFindById_('Members', context.memberId) : null;
  var now = nowIso_();
  var booking = {
    id: createId_('booking'),
    demo: false,
    memberId: member ? member.id : '',
    displayName: assertRequiredString_(input.displayName || (member && member.displayName), 'booking.displayName', 100),
    phone: normalizeOptionalString_(input.phone || (member && member.phone), 30),
    email: normalizeOptionalString_(input.email || (member && member.email), 200),
    advisorType: assertRequiredString_(input.advisorType, 'booking.advisorType', 100),
    topic: assertRequiredString_(input.topic, 'booking.topic', 500),
    preferredTime: assertRequiredString_(input.preferredTime, 'booking.preferredTime', 100),
    note: normalizeOptionalString_(input.note, 2000),
    state: 'requested',
    createdAt: now,
    updatedAt: now
  };
  if (!booking.phone && !booking.email && !member) {
    throw domainError_('A phone or email is required for visitor bookings', 'validation_error');
  }
  storeAppend_('Bookings', booking);
  appendAudit_({
    entityType: 'booking', entityId: booking.id, action: 'booking.created',
    actor: actorFromContext_(context), before: null, after: booking,
    requestId: context.requestId
  });
  if (member) enqueueMemberNotification_(member.id, 'booking_received', 'booking', booking.id, actorFromContext_(context), context.requestId);
  return { booking: booking };
}

function operationCreateActivation_(payload, context) {
  assertRole_(context, ['member', 'qualified', 'service', 'admin']);
  var input = payload.activation || {};
  var memberId = context.role === 'service' || context.role === 'admin' ? input.memberId : context.memberId;
  assertOwnMemberScope_(context, memberId);
  var member = requireRecord_('Members', memberId);
  var fullName = assertRequiredString_(input.fullName, 'activation.fullName', 100);
  var phone = assertRequiredString_(input.phone, 'activation.phone', 30).replace(/[\s-]/g, '');
  if (!/^09\d{8}$/.test(phone)) throw domainError_('activation.phone must be a valid Taiwan mobile number', 'validation_error');
  var sourceName = assertRequiredString_(input.sourceName, 'activation.sourceName', 200);
  var lineFriendConfirmed = input.lineFriendConfirmed === true || String(input.lineFriendConfirmed) === 'true';
  var privacyConsent = input.privacyConsent === true || String(input.privacyConsent) === 'true';
  if (!lineFriendConfirmed || !privacyConsent) {
    throw domainError_('LINE friend confirmation and privacy consent are required', 'consent_required', 409);
  }
  var now = nowIso_();
  var activation = {
    id: createId_('activation'),
    demo: false,
    memberId: member.id,
    lineUserId: member.lineUserId,
    fullName: fullName,
    phone: phone,
    sourceCode: assertRequiredString_(input.sourceCode, 'activation.sourceCode', 100),
    sourceName: sourceName,
    identityNote: normalizeOptionalString_(input.identityNote, 1000),
    lineFriendConfirmed: true,
    privacyConsent: true,
    consentedAt: now,
    state: 'submitted',
    createdAt: now,
    updatedAt: now
  };
  storeAppend_('Activations', activation);
  var previousMember = Object.assign({}, member);
  member.legalName = fullName;
  member.phone = phone;
  member.sourceGroup = sourceName;
  member.updatedAt = now;
  storePut_('Members', member);
  appendAudit_({
    entityType: 'activation', entityId: activation.id, action: 'activation.created',
    actor: actorFromContext_(context), before: null,
    after: {
      id: activation.id, memberId: member.id, sourceCode: activation.sourceCode,
      sourceName: sourceName, state: activation.state, privacyConsent: true, consentedAt: now
    },
    requestId: context.requestId
  });
  appendAudit_({
    entityType: 'member', entityId: member.id, action: 'member.activation_profile_updated',
    actor: actorFromContext_(context),
    before: { legalName: previousMember.legalName || '', sourceGroup: previousMember.sourceGroup || '' },
    after: { legalName: member.legalName, sourceGroup: member.sourceGroup },
    requestId: context.requestId
  });
  return { activation: activation };
}

function operationCreateSubscription_(payload, context) {
  assertRole_(context, ['member', 'qualified']);
  var member = memberForContext_(context);
  var project = requireRecord_('Projects', assertRequiredString_(payload.projectId, 'projectId', 100));
  if (!hasProjectAccess_(member, project)) {
    throw domainError_('Qualified access to this project is required', 'forbidden', 403);
  }
  var idempotencyKey = assertRequiredString_(payload.idempotencyKey, 'idempotencyKey', 128);
  if (idempotencyKey.length < 8) throw domainError_('idempotencyKey is too short', 'validation_error');
  var priorAudit = storeList_('Audits').filter(function (audit) {
    return audit.requestId === idempotencyKey && audit.action === 'subscription.created' &&
      audit.actor && audit.actor.id === (context.actorId || context.memberId);
  })[0];
  if (priorAudit && priorAudit.entityId) {
    return { subscription: requireRecord_('Subscriptions', priorAudit.entityId), replayed: true };
  }
  var requested = normalizeTwd_(payload.requestedAmountTwd, 'requestedAmountTwd');
  var minimum = normalizeTwd_(project.minimumAmountTwd, 'minimumAmountTwd');
  var increment = normalizeTwd_(project.incrementAmountTwd, 'incrementAmountTwd');
  if (requested < minimum || (increment > 0 && (requested - minimum) % increment !== 0)) {
    throw domainError_('Requested amount does not match project minimum/increment rules', 'invalid_amount', 409);
  }
  var subscription = createSubscriptionRecord_({
    id: createId_('subscription'),
    demo: false,
    memberId: member.id,
    projectId: project.id,
    requestedAmountTwd: requested
  }, nowIso_());
  storeAppend_('Subscriptions', subscription);
  appendAudit_({
    entityType: 'subscription', entityId: subscription.id, action: 'subscription.created',
    actor: actorFromContext_(context), before: null, after: subscription,
    requestId: idempotencyKey
  });
  enqueueMemberNotification_(member.id, 'subscription_submitted', 'subscription', subscription.id, actorFromContext_(context), idempotencyKey);
  return { subscription: subscription, replayed: false };
}

function operationAuthorizeDeck_(payload, context) {
  assertRole_(context, ['member', 'qualified', 'admin']);
  var project = requireRecord_('Projects', assertRequiredString_(payload.projectId, 'projectId', 100));
  var member = context.role === 'admin' ? null : memberForContext_(context);
  if (context.role !== 'admin' && !hasProjectAccess_(member, project)) {
    throw domainError_('Qualified access to this project is required', 'forbidden', 403);
  }
  if (!project.deck || !project.deck.id) throw domainError_('Deck is not available', 'not_found', 404);
  var expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  var authorization = {
    allowed: true,
    projectId: project.id,
    deckId: project.deck.id,
    objectKey: project.deck.objectKey || ('decks/' + project.id + '/' + project.deck.id + '.pdf'),
    filename: project.deck.filename || (project.slug + '-pitch-deck.pdf'),
    contentType: project.deck.contentType || 'application/pdf',
    subjectId: member ? member.id : context.actorId,
    watermarkLabel: member ? member.displayName + ' / ' + member.id : 'ADMIN / ' + context.actorId,
    expiresAt: expiresAt
  };
  appendAudit_({
    entityType: 'deck', entityId: project.deck.id, action: 'deck.authorized',
    actor: actorFromContext_(context), before: null, after: authorization,
    requestId: context.requestId
  });
  return { authorization: authorization };
}

function operationWebhookEvent_(payload, context) {
  assertRole_(context, ['service']);
  var event = payload.event || {};
  var type = assertRequiredString_(event.type, 'event.type', 40);
  var lineUserId = normalizeOptionalString_(event.lineUserId, 200);
  var member = lineUserId ? storeList_('Members').filter(function (record) {
    return record.lineUserId === lineUserId;
  })[0] : null;
  var before = member ? Object.assign({}, member) : null;
  if (member && (type === 'follow' || type === 'unfollow')) {
    member.lineFriendshipState = type === 'follow' ? 'friend' : 'not_friend';
    member.updatedAt = nowIso_();
    storePut_('Members', member);
  }
  appendAudit_({
    entityType: 'line_webhook', entityId: event.webhookEventId || createId_('line-event'),
    action: 'line.' + type, actor: actorFromContext_(context), before: before,
    after: member ? { id: member.id, lineFriendshipState: member.lineFriendshipState } : { matchedMember: false },
    requestId: context.requestId
  });
  return { accepted: true, matchedMember: Boolean(member) };
}

function enrichSubscriptionsForAdmin_(subscriptions, members, projects) {
  var memberMap = {};
  var projectMap = {};
  (members || storeList_('Members')).forEach(function (member) { memberMap[member.id] = member; });
  (projects || storeList_('Projects')).forEach(function (project) { projectMap[project.id] = project; });
  return subscriptions.map(function (record) {
    var member = memberMap[record.memberId] || {};
    var project = projectMap[record.projectId] || {};
    return Object.assign({}, record, {
      memberName: member.legalName || member.displayName || record.memberId,
      projectName: project.displayName || record.projectId
    });
  });
}

function operationAdminDashboard_(payload, context) {
  assertRole_(context, ['admin']);
  var members = storeList_('Members');
  var projects = storeList_('Projects');
  var subscriptions = storeList_('Subscriptions');
  var enrichedSubscriptions = enrichSubscriptionsForAdmin_(subscriptions, members, projects);
  var notifications = storeList_('Notifications');
  var sum = function (field) {
    return subscriptions.reduce(function (total, record) { return total + Number(record[field] || 0); }, 0);
  };
  return {
    generatedAt: nowIso_(),
    kpis: {
      members: members.length,
      pendingMembers: members.filter(function (record) { return record.membershipState === 'pending'; }).length,
      qualifiedMembers: members.filter(function (record) { return record.qualificationState === 'approved'; }).length,
      projects: projects.length,
      subscriptions: subscriptions.length,
      requestedAmountTwd: sum('requestedAmountTwd'),
      approvedAmountTwd: sum('approvedAmountTwd'),
      receivedAmountTwd: sum('receivedAmountTwd'),
      allocatedAmountTwd: sum('allocatedAmountTwd'),
      refundedAmountTwd: sum('refundedAmountTwd'),
      notificationActions: notifications.filter(function (record) {
        return record.state === 'pending_manual' || record.state === 'failed';
      }).length
    },
    recentSubscriptions: enrichedSubscriptions.slice().sort(function (a, b) {
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    }).slice(0, 12),
    actionQueue: {
      members: members.filter(function (record) { return record.membershipState === 'pending'; }).slice(0, 20),
      subscriptions: enrichedSubscriptions.filter(function (record) {
        return ['submitted', 'operations_confirmed', 'partner_review'].indexOf(record.subscriptionState) !== -1;
      }).slice(0, 20),
      notifications: notifications.filter(function (record) {
        return record.state === 'pending_manual' || record.state === 'failed';
      }).slice(0, 20)
    }
  };
}

var ZF_ADMIN_RESOURCES = Object.freeze({
  members: 'Members', projects: 'Projects', subscriptions: 'Subscriptions',
  bookings: 'Bookings', activations: 'Activations', notifications: 'Notifications', audits: 'Audits'
});

function operationAdminList_(payload, context) {
  assertRole_(context, ['admin']);
  var resource = assertRequiredString_(payload.resource, 'resource', 40).toLowerCase();
  var sheetName = ZF_ADMIN_RESOURCES[resource];
  if (!sheetName) throw domainError_('Unsupported admin resource', 'invalid_request');
  var limit = Math.max(1, Math.min(Number(payload.limit) || 100, 500));
  var records = storeList_(sheetName);
  if (payload.memberId && ['Subscriptions', 'Bookings', 'Activations', 'Notifications'].indexOf(sheetName) !== -1) {
    records = records.filter(function (record) {
      return (record.memberId || record.recipientMemberId) === payload.memberId;
    });
  }
  if (sheetName === 'Subscriptions') records = enrichSubscriptionsForAdmin_(records);
  return { resource: resource, records: records.slice(0, limit), total: records.length };
}

function operationAdminPatchMember_(payload, context) {
  assertRole_(context, ['admin']);
  var current = requireRecord_('Members', assertRequiredString_(payload.memberId, 'memberId', 100));
  var patch = payload.patch || {};
  var next = Object.assign({}, current);
  if (patch.membershipState !== undefined) {
    assertTransition_('membership', current.membershipState, patch.membershipState);
    next.membershipState = patch.membershipState;
  }
  if (patch.qualificationState !== undefined) {
    assertTransition_('qualification', current.qualificationState, patch.qualificationState);
    next.qualificationState = patch.qualificationState;
    next.qualificationApproval = assertQualificationEvidence_(patch.qualificationState, patch.qualificationApproval);
  }
  if (patch.lineFriendshipState !== undefined) {
    if (['friend', 'not_friend', 'unknown'].indexOf(patch.lineFriendshipState) === -1) {
      throw domainError_('Invalid LINE friendship state', 'invalid_state');
    }
    next.lineFriendshipState = patch.lineFriendshipState;
  }
  if (patch.tier !== undefined) next.tier = assertRequiredString_(patch.tier, 'tier', 40);
  if (patch.projectAccess !== undefined) {
    if (!Array.isArray(patch.projectAccess)) throw domainError_('projectAccess must be an array', 'validation_error');
    var validProjectIds = storeList_('Projects').map(function (project) { return project.id; });
    patch.projectAccess.forEach(function (projectId) {
      if (validProjectIds.indexOf(projectId) === -1) throw domainError_('Unknown project in access list', 'not_found', 404);
    });
    next.projectAccess = patch.projectAccess.slice();
  }
  next.updatedAt = nowIso_();
  storePut_('Members', next);
  var actor = actorFromContext_(context);
  appendAudit_({
    entityType: 'member', entityId: next.id, action: 'member.admin_patched', actor: actor,
    before: current, after: next, reason: normalizeOptionalString_(payload.reason, 1000),
    requestId: context.requestId
  });
  if (current.membershipState !== next.membershipState) {
    if (next.membershipState === 'active') enqueueMemberNotification_(next.id, 'membership_activated', 'member', next.id, actor, context.requestId);
    if (next.membershipState === 'rejected') enqueueMemberNotification_(next.id, 'membership_rejected', 'member', next.id, actor, context.requestId);
  }
  if (current.qualificationState !== next.qualificationState) {
    if (next.qualificationState === 'approved') enqueueMemberNotification_(next.id, 'qualification_approved', 'member', next.id, actor, context.requestId);
    if (next.qualificationState === 'rejected') enqueueMemberNotification_(next.id, 'qualification_rejected', 'member', next.id, actor, context.requestId);
  }
  return { member: next };
}

function operationAdminPatchProject_(payload, context) {
  assertRole_(context, ['admin']);
  var current = requireRecord_('Projects', assertRequiredString_(payload.projectId, 'projectId', 100));
  var patch = payload.patch || {};
  var allowed = [
    'publicVisibility', 'displayName', 'industry', 'stage', 'region', 'summary', 'highlights',
    'videoUrl', 'companyName', 'taxId', 'round', 'targetAmountTwd', 'minimumAmountTwd',
    'incrementAmountTwd', 'deadline', 'valuationNote', 'useOfFunds', 'teamSummary',
    'financialSummary', 'risks', 'reports', 'deck', 'memberAllowlist'
  ];
  Object.keys(patch).forEach(function (field) {
    if (allowed.indexOf(field) === -1) throw domainError_('Project field cannot be patched: ' + field, 'validation_error');
  });
  var next = Object.assign({}, current, patch, { updatedAt: nowIso_() });
  ['targetAmountTwd', 'minimumAmountTwd', 'incrementAmountTwd'].forEach(function (field) {
    next[field] = normalizeTwd_(next[field], field);
  });
  if (next.minimumAmountTwd > next.targetAmountTwd) throw domainError_('Minimum exceeds target', 'invalid_amounts', 409);
  if (!Array.isArray(next.memberAllowlist)) throw domainError_('memberAllowlist must be an array', 'validation_error');
  storePut_('Projects', next);
  appendAudit_({
    entityType: 'project', entityId: next.id, action: 'project.admin_patched',
    actor: actorFromContext_(context), before: current, after: next,
    reason: normalizeOptionalString_(payload.reason, 1000), requestId: context.requestId
  });
  return { project: next };
}

function operationAdminPatchSubscription_(payload, context) {
  assertRole_(context, ['admin']);
  var current = requireRecord_('Subscriptions', assertRequiredString_(payload.subscriptionId, 'subscriptionId', 100));
  var next = updateSubscriptionRecord_(current, payload.patch || {}, nowIso_());
  storePut_('Subscriptions', next);
  var actor = actorFromContext_(context);
  appendAudit_({
    entityType: 'subscription', entityId: next.id, action: 'subscription.admin_patched',
    actor: actor, before: current, after: next,
    reason: normalizeOptionalString_(payload.reason, 1000), requestId: context.requestId
  });
  if (current.subscriptionState !== next.subscriptionState) {
    if (next.subscriptionState === 'operations_confirmed') enqueueMemberNotification_(next.memberId, 'subscription_operations_confirmed', 'subscription', next.id, actor, context.requestId);
    if (next.subscriptionState === 'approved') enqueueMemberNotification_(next.memberId, 'subscription_approved', 'subscription', next.id, actor, context.requestId);
    if (next.subscriptionState === 'rejected') enqueueMemberNotification_(next.memberId, 'subscription_rejected', 'subscription', next.id, actor, context.requestId);
  }
  if (current.fundingState !== next.fundingState && next.fundingState === 'refunded') {
    enqueueMemberNotification_(next.memberId, 'subscription_refunded', 'subscription', next.id, actor, context.requestId);
  }
  return { subscription: next };
}

function operationAdminApproveNotification_(payload, context) {
  assertRole_(context, ['admin']);
  return { notification: approveNotification_(
    assertRequiredString_(payload.notificationId, 'notificationId', 100),
    actorFromContext_(context),
    normalizeOptionalString_(payload.reason, 1000)
  ) };
}

function operationAdminCreateBulkNotification_(payload, context) {
  assertRole_(context, ['admin']);
  var memberIds = payload.memberIds;
  if (!Array.isArray(memberIds) || memberIds.length < 1 || memberIds.length > 500) {
    throw domainError_('memberIds must contain 1 to 500 members', 'validation_error');
  }
  var actor = actorFromContext_(context);
  var queued = memberIds.map(function (memberId) {
    var member = requireRecord_('Members', memberId);
    return enqueueNotification_({
      recipientMemberId: member.id, lineUserId: member.lineUserId,
      eventType: 'bulk_announcement', entityType: 'announcement',
      entityId: payload.announcementId || '', actor: actor, requestId: context.requestId
    });
  }).filter(Boolean);
  return { notifications: queued, manualApprovalRequired: true };
}

function operationAdminProcessNotifications_(payload, context) {
  assertRole_(context, ['admin', 'service']);
  return { summary: processNotificationQueue_(payload.limit) };
}

function operationAdminExport_(payload, context) {
  assertRole_(context, ['admin']);
  var resource = assertRequiredString_(payload.resource, 'resource', 40).toLowerCase();
  var sheetName = ZF_ADMIN_RESOURCES[resource];
  if (!sheetName) {
    throw domainError_('Unsupported export resource', 'invalid_request');
  }
  var records = storeList_(sheetName);
  appendAudit_({
    entityType: 'export', entityId: resource, action: 'admin.csv_exported',
    actor: actorFromContext_(context), before: null, after: { rows: records.length },
    reason: normalizeOptionalString_(payload.reason, 1000), requestId: context.requestId
  });
  return {
    filename: 'zhifu-' + resource + '-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '.csv',
    mimeType: 'text/csv;charset=utf-8',
    csv: recordsToCsv_(sheetName, records)
  };
}

function base32Bytes_(value) {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var clean = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!clean) throw domainError_('Admin TOTP secret is not configured', 'configuration_error', 500);
  var bits = '';
  for (var index = 0; index < clean.length; index += 1) {
    var position = alphabet.indexOf(clean.charAt(index));
    if (position < 0) throw domainError_('Admin TOTP secret is invalid', 'configuration_error', 500);
    bits += position.toString(2).padStart(5, '0');
  }
  var bytes = [];
  for (var offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(parseInt(bits.slice(offset, offset + 8), 2));
  }
  return bytes;
}

function totpCode_(secret, counter) {
  var high = Math.floor(counter / 4294967296);
  var low = counter >>> 0;
  var counterBytes = [
    (high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255,
    (low >>> 24) & 255, (low >>> 16) & 255, (low >>> 8) & 255, low & 255
  ];
  var digest = Utilities.computeHmacSha1Signature(counterBytes, base32Bytes_(secret));
  var unsigned = digest.map(function (byte) { return byte < 0 ? byte + 256 : byte; });
  var position = unsigned[unsigned.length - 1] & 15;
  var binary = ((unsigned[position] & 127) << 24) |
    (unsigned[position + 1] << 16) |
    (unsigned[position + 2] << 8) |
    unsigned[position + 3];
  return String((binary >>> 0) % 1000000).padStart(6, '0');
}

function verifyTotp_(secret, supplied, nowMs) {
  if (!/^\d{6}$/.test(String(supplied || ''))) return false;
  var counter = Math.floor((nowMs === undefined ? Date.now() : nowMs) / 30000);
  for (var drift = -1; drift <= 1; drift += 1) {
    if (constantTimeEqual_(totpCode_(secret, counter + drift), supplied)) return true;
  }
  return false;
}

function operationAuthenticateAdmin_(payload) {
  var credential = assertRequiredString_(payload.googleCredential, 'googleCredential', 10000);
  var response = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential),
    { muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) {
    throw domainError_('Google credential is invalid', 'admin_identity_invalid', 403);
  }
  var identity = JSON.parse(response.getContentText());
  var clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_ADMIN_CLIENT_ID');
  var email = String(identity.email || '').trim().toLowerCase();
  var allowlist = (PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '')
    .split(',').map(function (value) { return value.trim().toLowerCase(); }).filter(Boolean);
  if (!clientId || identity.aud !== clientId || String(identity.email_verified) !== 'true' ||
      Number(identity.exp) * 1000 <= Date.now() || allowlist.indexOf(email) === -1) {
    throw domainError_('Google account is not authorized', 'forbidden', 403);
  }
  var secrets;
  try {
    secrets = JSON.parse(PropertiesService.getScriptProperties().getProperty('ADMIN_TOTP_SECRETS_JSON') || '{}');
  } catch (error) {
    throw domainError_('ADMIN_TOTP_SECRETS_JSON is invalid', 'configuration_error', 500);
  }
  if (!secrets[email] || !verifyTotp_(secrets[email], payload.twoFactorCode)) {
    throw domainError_('Two-factor code is invalid', 'admin_two_factor_invalid', 403);
  }
  appendAudit_({
    entityType: 'admin_session', entityId: email, action: 'admin.authenticated',
    actor: { type: 'admin', id: email }, before: null, after: { email: email }
  });
  return { adminId: email, displayName: identity.name || email.split('@')[0] };
}
