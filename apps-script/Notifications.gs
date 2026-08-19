/** LINE transactional notification queue. Messages deliberately contain no amounts. */

var ZF_NOTIFICATION_POLICY = Object.freeze({
  membership_activated: 'auto',
  qualification_approved: 'auto',
  subscription_submitted: 'auto',
  subscription_operations_confirmed: 'auto',
  subscription_approved: 'auto',
  booking_received: 'auto',
  daily_digest: 'auto',
  membership_rejected: 'manual',
  qualification_rejected: 'manual',
  subscription_rejected: 'manual',
  subscription_refunded: 'manual',
  bulk_announcement: 'manual'
});

var ZF_NOTIFICATION_COPY = Object.freeze({
  membership_activated: '您的致富投資會員資格狀態已更新，請登入會員中心查看。',
  qualification_approved: '您的合格投資人審核狀態已更新，請登入會員中心查看。',
  subscription_submitted: '您的認購意向已送出，請登入會員中心追蹤狀態。',
  subscription_operations_confirmed: '您的認購意向處理狀態已更新，請登入會員中心查看。',
  subscription_approved: '您的認購意向審核狀態已更新，請登入會員中心查看。',
  booking_received: '您的顧問預約已收到，後續狀態請登入會員中心查看。',
  daily_digest: '您的致富投資每日摘要已更新，請登入會員中心查看。',
  membership_rejected: '您的會員申請狀態已更新，請登入會員中心查看說明。',
  qualification_rejected: '您的合格投資人審核狀態已更新，請登入會員中心查看說明。',
  subscription_rejected: '您的認購意向審核狀態已更新，請登入會員中心查看說明。',
  subscription_refunded: '您的投後作業狀態已更新，請登入會員中心查看。',
  bulk_announcement: '致富投資會員中心有新的服務公告，請登入查看。'
});

// One initial delivery plus three retries. The fourth failure is retained for
// manual follow-up instead of looping indefinitely.
var ZF_NOTIFICATION_MAX_ATTEMPTS = 4;

function notificationPolicyForEvent_(eventType) {
  var policy = ZF_NOTIFICATION_POLICY[eventType];
  if (!policy) throw domainError_('Unknown notification event: ' + eventType, 'invalid_notification');
  return policy;
}

function notificationMessageForEvent_(eventType) {
  var message = ZF_NOTIFICATION_COPY[eventType];
  if (!message) throw domainError_('Unknown notification event: ' + eventType, 'invalid_notification');
  return message;
}

function enqueueNotification_(input) {
  if (!input.lineUserId) return null;
  var eventType = input.eventType;
  var policy = notificationPolicyForEvent_(eventType);
  var now = nowIso_();
  var baseUrl = PropertiesService.getScriptProperties().getProperty('MEMBER_APP_BASE_URL') || '';
  var path = input.deepLinkPath || '/member.html';
  var notification = {
    id: createId_('notification'),
    recipientMemberId: input.recipientMemberId || '',
    lineUserId: input.lineUserId,
    eventType: eventType,
    entityType: input.entityType || '',
    entityId: input.entityId || '',
    policy: policy,
    state: policy === 'auto' ? 'queued' : 'pending_manual',
    message: notificationMessageForEvent_(eventType),
    deepLink: baseUrl ? baseUrl.replace(/\/$/, '') + path : '',
    attemptCount: 0,
    lastError: '',
    nextAttemptAt: policy === 'auto' ? now : '',
    manualApprovedBy: '',
    createdAt: now,
    updatedAt: now,
    sentAt: ''
  };
  storeAppend_('Notifications', notification);
  appendAudit_({
    entityType: 'notification',
    entityId: notification.id,
    action: 'notification.enqueued',
    actor: input.actor,
    before: null,
    after: {
      eventType: eventType,
      policy: policy,
      state: notification.state,
      recipientMemberId: notification.recipientMemberId
    },
    requestId: input.requestId || ''
  });
  return notification;
}

function enqueueMemberNotification_(memberId, eventType, entityType, entityId, actor, requestId) {
  var member = storeFindById_('Members', memberId);
  if (!member) return null;
  return enqueueNotification_({
    recipientMemberId: member.id,
    lineUserId: member.lineUserId,
    eventType: eventType,
    entityType: entityType,
    entityId: entityId,
    actor: actor,
    requestId: requestId
  });
}

function approveNotification_(notificationId, actor, reason) {
  var current = storeFindById_('Notifications', notificationId);
  if (!current) throw domainError_('Notification not found', 'not_found', 404);
  if (current.state !== 'pending_manual' && current.state !== 'failed') {
    throw domainError_('Only manual or failed notifications can be approved', 'invalid_transition', 409);
  }
  var next = Object.assign({}, current, {
    state: 'queued',
    attemptCount: 0,
    nextAttemptAt: nowIso_(),
    lastError: '',
    manualApprovedBy: actor.id,
    updatedAt: nowIso_()
  });
  storePut_('Notifications', next);
  appendAudit_({
    entityType: 'notification',
    entityId: next.id,
    action: 'notification.manual_approved',
    actor: actor,
    before: { state: current.state },
    after: { state: next.state },
    reason: reason
  });
  return next;
}

function linePush_(notification) {
  var accessToken = PropertiesService.getScriptProperties().getProperty('LINE_MESSAGING_ACCESS_TOKEN');
  if (!accessToken) throw domainError_('LINE_MESSAGING_ACCESS_TOKEN is not configured', 'configuration_error', 500);
  var text = notification.message;
  if (notification.deepLink) text += '\n' + notification.deepLink;
  var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify({
      to: notification.lineUserId,
      messages: [{ type: 'text', text: text }]
    }),
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    // Never persist access tokens or the full provider body.
    throw domainError_('LINE push failed with HTTP ' + status, 'line_push_failed', 502);
  }
}

function dailyDigestLineDeliveryAllowed_(notification) {
  if (notification.eventType !== 'daily_digest') return true;
  var member = storeList_('Members').filter(function (record) {
    return record.id === notification.recipientMemberId;
  })[0] || null;
  var preference = storeList_('NewsletterPreferences').filter(function (record) {
    return record.memberId === notification.recipientMemberId;
  })[0] || null;
  return Boolean(member && preference && preference.dailyDigestConsent === true &&
    preference.lineDeliveryConsent === true &&
    (preference.deliveryChannels || []).indexOf('line') !== -1 &&
    member.lineUserId && member.lineUserId === notification.lineUserId);
}

function processNotificationQueue_(limit) {
  var now = nowIso_();
  var records = storeList_('Notifications').filter(function (notification) {
    return (notification.state === 'queued' || notification.state === 'retry') &&
      (!notification.nextAttemptAt || notification.nextAttemptAt <= now);
  }).slice(0, Math.max(1, Math.min(Number(limit) || 10, 20)));

  var summary = { attempted: 0, sent: 0, retry: 0, failed: 0, cancelledConsent: 0 };
  records.forEach(function (current) {
    if (!dailyDigestLineDeliveryAllowed_(current)) {
      var cancelled = Object.assign({}, current, {
        state: 'cancelled_consent', nextAttemptAt: '', lastError: '', updatedAt: nowIso_()
      });
      storePut_('Notifications', cancelled);
      appendAudit_({
        entityType: 'notification', entityId: cancelled.id, action: 'notification.cancelled_consent',
        actor: { type: 'system', id: 'notification-worker' },
        before: { state: current.state, attemptCount: current.attemptCount },
        after: { state: cancelled.state, attemptCount: cancelled.attemptCount },
        reason: 'Daily digest delivery consent or identity is no longer valid'
      });
      summary.cancelledConsent += 1;
      return;
    }
    summary.attempted += 1;
    var next = Object.assign({}, current, {
      attemptCount: Number(current.attemptCount || 0) + 1,
      updatedAt: nowIso_()
    });
    try {
      linePush_(current);
      next.state = 'sent';
      next.sentAt = nowIso_();
      next.nextAttemptAt = '';
      next.lastError = '';
      summary.sent += 1;
    } catch (error) {
      next.lastError = (error.code || 'line_push_failed') + ': ' + error.message;
      if (next.attemptCount >= ZF_NOTIFICATION_MAX_ATTEMPTS) {
        next.state = 'failed';
        next.nextAttemptAt = '';
        summary.failed += 1;
      } else {
        next.state = 'retry';
        next.nextAttemptAt = new Date(Date.now() + next.attemptCount * 5 * 60 * 1000).toISOString();
        summary.retry += 1;
      }
    }
    storePut_('Notifications', next);
    appendAudit_({
      entityType: 'notification',
      entityId: next.id,
      action: next.state === 'sent' ? 'notification.sent' : 'notification.delivery_failed',
      actor: { type: 'system', id: 'notification-worker' },
      before: { state: current.state, attemptCount: current.attemptCount },
      after: { state: next.state, attemptCount: next.attemptCount },
      reason: next.lastError
    });
  });
  return summary;
}

/** Install this function as a time-driven trigger (for example every 5 minutes). */
function processNotificationQueue() {
  return withStoreLock_(function () {
    return processNotificationQueue_(10);
  });
}
