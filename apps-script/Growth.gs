/** Prospect attribution, content, matching and daily digest operations. */

var ZF_PROSPECT_STATUSES = Object.freeze(['new', 'contacted', 'qualified', 'converted', 'archived']);
var ZF_CONTENT_TYPES = Object.freeze(['video', 'article', 'project_update']);
var ZF_CONTENT_VISIBILITY = Object.freeze(['public', 'member', 'qualified']);
var ZF_CONTENT_STATUSES = Object.freeze(['draft', 'published']);
var ZF_DELIVERY_CHANNELS = Object.freeze(['in_app', 'line', 'email']);

function booleanInput_(value, fallback) {
  if (value === undefined) return Boolean(fallback);
  if (value === true || value === false) return value;
  throw domainError_('Consent values must be boolean', 'validation_error');
}

function normalizeProspectAliases_(input) {
  var value = input || {};
  var hasContact = value.contact !== undefined || value.contactValue !== undefined || value.email !== undefined || value.phone !== undefined;
  var contact = hasContact ? normalizeOptionalString_(value.contact || value.contactValue || value.email || value.phone || '', 300) : undefined;
  var hasChannel = value.channel !== undefined || value.contactChannel !== undefined || value.contactType !== undefined;
  var channel = hasChannel ? (value.channel || value.contactChannel || value.contactType || '') : undefined;
  var explicitEmail = value.email !== undefined ? normalizeOptionalString_(value.email, 300) : '';
  var explicitPhone = value.phone !== undefined ? normalizeOptionalString_(value.phone, 40) : '';
  var contactLooksEmail = Boolean(contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact));
  var contactLooksPhone = Boolean(contact && /^\+?\d[\d\s().-]{6,}$/.test(contact));
  var email = explicitEmail || (contactLooksEmail || (hasContact && String(channel).toLowerCase() === 'email') ? contact : '');
  var phone = explicitPhone || (contactLooksPhone || (hasContact && String(channel).toLowerCase() === 'phone') ? contact : '');
  email = email ? email.toLowerCase() : undefined;
  phone = phone ? phone.replace(/[^0-9+]/g, '') : undefined;
  var privacy = value.privacyEvidence || {};
  return {
    displayName: value.displayName || value.name,
    contact: contact,
    email: email,
    phone: phone,
    sourceContact: value.sourceContact !== undefined ? value.sourceContact :
      (hasContact && !email && !phone ? contact : undefined),
    channel: channel,
    source: value.source || value.acquisitionSource,
    sourceReference: value.sourceReference || value.sourceEvidence || value.acquisitionEvidence || value.evidenceReference,
    privacyEvidenceReference: value.privacyEvidenceReference || privacy.reference,
    privacyConsentedAt: value.privacyConsentedAt || privacy.consentedAt,
    privacyNoticeVersion: value.privacyNoticeVersion || privacy.noticeVersion,
    acquisitionOwnerId: value.acquisitionOwnerId || value.owner || value.ownerId || value.referrerId,
    linkedMemberId: value.linkedMemberId || value.linkMemberId || value.memberId,
    investmentPreferences: value.investmentPreferences || (
      value.industries !== undefined || value.industryPreferences !== undefined ||
      value.minimumTicketTwd !== undefined || value.ticketMinTwd !== undefined ||
      value.maximumTicketTwd !== undefined || value.ticketMaxTwd !== undefined ? {
        industries: value.industries || value.industryPreferences,
        minimumTicketTwd: value.minimumTicketTwd !== undefined ? value.minimumTicketTwd : value.ticketMinTwd,
        maximumTicketTwd: value.maximumTicketTwd !== undefined ? value.maximumTicketTwd : value.ticketMaxTwd
      } : undefined
    ),
    status: value.status,
    demo: value.demo
  };
}

function normalizedProspectIdentityKeys_(input) {
  var value = normalizeProspectAliases_(input);
  var keys = [];
  if (value.email) keys.push('email:' + value.email);
  if (value.phone) keys.push('phone:' + value.phone);
  return keys;
}

function createProspectRecord_(input, id, importBatchId, now, importedBy) {
  var value = normalizeProspectAliases_(input);
  var channel = assertRequiredString_(value.channel, 'prospect.channel', 40).toLowerCase();
  if (['line', 'email', 'phone', 'openchat', 'community', 'other'].indexOf(channel) === -1) {
    throw domainError_('Unsupported prospect channel', 'invalid_prospect_channel');
  }
  var status = value.status || 'new';
  if (ZF_PROSPECT_STATUSES.indexOf(status) === -1) throw domainError_('Invalid prospect status', 'invalid_prospect_status');
  if (status === 'converted' && !value.linkedMemberId) {
    throw domainError_('A converted prospect requires an audited linked member', 'prospect_member_link_required', 409);
  }
  return {
    id: id,
    demo: Boolean(value.demo),
    displayName: assertRequiredString_(value.displayName, 'prospect.displayName', 100),
    contact: assertRequiredString_(value.contact, 'prospect.contact', 300),
    email: value.email,
    phone: value.phone,
    sourceContact: value.sourceContact,
    channel: channel,
    source: assertRequiredString_(value.source, 'prospect.source', 200),
    sourceReference: assertRequiredString_(value.sourceReference, 'prospect.sourceReference', 500),
    privacyEvidenceReference: assertRequiredString_(value.privacyEvidenceReference, 'prospect.privacyEvidenceReference', 500),
    privacyConsentedAt: normalizeIsoTime_(value.privacyConsentedAt, 'prospect.privacyConsentedAt', true),
    privacyNoticeVersion: assertRequiredString_(value.privacyNoticeVersion, 'prospect.privacyNoticeVersion', 100),
    acquisitionOwnerId: assertRequiredString_(value.acquisitionOwnerId, 'prospect.acquisitionOwnerId', 100),
    linkedMemberId: normalizeOptionalString_(value.linkedMemberId, 100),
    investmentPreferences: value.investmentPreferences ? normalizeInvestmentPreferences_(value.investmentPreferences) : null,
    status: value.linkedMemberId ? 'converted' : status,
    importBatchId: importBatchId || '',
    importedBy: assertRequiredString_(importedBy || 'unknown', 'prospect.importedBy', 200),
    importedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function patchProspectRecord_(current, patchInput, membersById, prospects, now) {
  var raw = patchInput || {};
  var aliases = normalizeProspectAliases_(raw);
  var immutableEvidenceFields = [
    'source', 'acquisitionSource', 'sourceReference', 'sourceEvidence', 'acquisitionEvidence',
    'evidenceReference', 'privacyEvidence', 'privacyEvidenceReference', 'privacyConsentedAt',
    'privacyNoticeVersion'
  ];
  if (immutableEvidenceFields.some(function (field) { return raw[field] !== undefined; })) {
    throw domainError_('Prospect source and privacy evidence cannot be changed after import', 'prospect_evidence_immutable', 409);
  }
  var ownerSupplied = raw.acquisitionOwnerId !== undefined || raw.owner !== undefined ||
    raw.ownerId !== undefined || raw.referrerId !== undefined;
  if (ownerSupplied && aliases.acquisitionOwnerId !== current.acquisitionOwnerId) {
    throw domainError_('Acquisition owner cannot be changed after import', 'acquisition_owner_immutable', 409);
  }
  var next = Object.assign({}, current);
  ['displayName', 'contact'].forEach(function (field) {
    if (aliases[field] !== undefined) next[field] = assertRequiredString_(aliases[field], 'prospect.' + field, field.indexOf('Reference') !== -1 ? 500 : 300);
  });
  if (aliases.email !== undefined && aliases.email !== current.email) throw domainError_('Prospect email identity cannot be changed after import', 'prospect_identity_immutable', 409);
  if (aliases.phone !== undefined && aliases.phone !== current.phone) throw domainError_('Prospect phone identity cannot be changed after import', 'prospect_identity_immutable', 409);
  if (aliases.channel !== undefined) {
    var channel = String(aliases.channel).toLowerCase();
    if (['line', 'email', 'phone', 'openchat', 'community', 'other'].indexOf(channel) === -1) {
      throw domainError_('Unsupported prospect channel', 'invalid_prospect_channel');
    }
    next.channel = channel;
  }
  if (aliases.status !== undefined) {
    if (ZF_PROSPECT_STATUSES.indexOf(aliases.status) === -1) throw domainError_('Invalid prospect status', 'invalid_prospect_status');
    next.status = aliases.status;
  }
  if (aliases.investmentPreferences !== undefined) {
    next.investmentPreferences = normalizeInvestmentPreferences_(aliases.investmentPreferences);
  }
  if (aliases.linkedMemberId !== undefined) {
    var memberId = normalizeOptionalString_(aliases.linkedMemberId, 100);
    if (current.linkedMemberId && current.linkedMemberId !== memberId) {
      throw domainError_('A prospect link cannot be reassigned', 'prospect_member_link_immutable', 409);
    }
    if (memberId) {
      var member = membersById[memberId];
      if (!member) throw domainError_('Member not found', 'not_found', 404);
      var attribution = member.referralAttribution || null;
      if (attribution && attribution.state === 'verified' && attribution.referrerId && attribution.referrerId !== current.acquisitionOwnerId) {
        throw domainError_('Member already belongs to another acquisition owner', 'member_attribution_conflict', 409);
      }
      (prospects || []).forEach(function (record) {
        if (record.id !== current.id && record.linkedMemberId === memberId &&
            record.acquisitionOwnerId !== current.acquisitionOwnerId) {
          throw domainError_('Member is linked to another acquisition owner', 'member_attribution_conflict', 409);
        }
      });
      next.linkedMemberId = memberId;
      if (!current.linkedMemberId) next.status = 'converted';
    }
  }
  if (next.status === 'converted' && !next.linkedMemberId) {
    throw domainError_('A converted prospect requires an audited linked member', 'prospect_member_link_required', 409);
  }
  if (next.linkedMemberId && next.status !== 'converted') {
    throw domainError_('A linked prospect must remain in converted status', 'prospect_member_link_required', 409);
  }
  next.updatedAt = now;
  return next;
}

function resolveAcquisitionOwner_(value, referrers) {
  var candidate = assertRequiredString_(value, 'prospect.acquisitionOwnerId', 100).toUpperCase();
  var match = (referrers || []).filter(function (referrer) {
    return String(referrer.id).toUpperCase() === candidate || String(referrer.code).toUpperCase() === candidate;
  })[0];
  var now = Date.now();
  if (!match || match.status !== 'active' || Date.parse(String(match.effectiveAt || '')) > now ||
      (match.expiresAt && Date.parse(String(match.expiresAt)) <= now)) {
    throw domainError_('Acquisition owner is not effective', 'acquisition_owner_not_found', 409);
  }
  return match;
}

function normalizeContentRecord_(input, current, actorId, now) {
  var value = Object.assign({}, current || {}, input || {});
  var type = assertRequiredString_(value.type, 'content.type', 40).toLowerCase();
  if (ZF_CONTENT_TYPES.indexOf(type) === -1) throw domainError_('Invalid content type', 'invalid_content_type');
  var publicSafe = booleanInput_(value.publicSafe, false);
  var visibility = (value.visibility || (publicSafe ? 'public' : type === 'project_update' ? 'qualified' : 'member')).toLowerCase();
  if (ZF_CONTENT_VISIBILITY.indexOf(visibility) === -1) throw domainError_('Invalid content visibility', 'invalid_content_visibility');
  var status = (value.status || 'draft').toLowerCase();
  if (ZF_CONTENT_STATUSES.indexOf(status) === -1) throw domainError_('Invalid content status', 'invalid_content_status');
  if (visibility === 'public' && status === 'published' && !publicSafe) {
    throw domainError_('Published public content requires publicSafe approval', 'public_content_approval_required', 409);
  }
  var riskNotice = assertRequiredString_(value.riskNotice, 'content.riskNotice', 1000);
  var contentUrl = assertRequiredString_(value.url, 'content.url', 2000);
  if (!/^https:\/\//i.test(contentUrl)) throw domainError_('content.url must use HTTPS', 'invalid_content_url');
  return {
    id: value.id,
    demo: Boolean(value.demo),
    type: type,
    title: assertRequiredString_(value.title, 'content.title', 200),
    summary: normalizeOptionalString_(value.summary, 2000),
    url: contentUrl,
    projectId: normalizeOptionalString_(value.projectId, 100),
    visibility: visibility,
    status: status,
    publishedAt: status === 'published' ? (value.publishedAt || now) : '',
    riskNotice: riskNotice,
    publicSafe: publicSafe,
    createdBy: current ? current.createdBy : actorId,
    createdAt: current ? current.createdAt : now,
    updatedAt: now
  };
}

function memberHasCurrentQualification_(member) {
  if (!member || member.membershipState !== 'active' || member.qualificationState !== 'approved') return false;
  var approval = member.qualificationApproval || {};
  var approvedAt = Date.parse(String(approval.approvedAt || ''));
  var expiresAt = Date.parse(String(approval.expiresAt || ''));
  return Number.isFinite(approvedAt) && approvedAt <= Date.now() + 5 * 60 * 1000 &&
    Number.isFinite(expiresAt) && expiresAt > Date.now() && expiresAt > approvedAt;
}

function publicContentView_(item) {
  return {
    id: item.id, type: item.type, title: item.title, summary: item.summary || '', url: item.url,
    projectId: item.projectId || '', visibility: item.visibility, publishedAt: item.publishedAt,
    riskNotice: item.riskNotice, status: item.status, publicSafe: item.publicSafe === true
  };
}

function publishedContentReadable_(item, now) {
  var publishedAt = Date.parse(String(item && item.publishedAt || ''));
  var nowMs = Date.parse(String(now || nowIso_()));
  return Boolean(item && item.status === 'published' && item.riskNotice &&
    Number.isFinite(publishedAt) && Number.isFinite(nowMs) && publishedAt <= nowMs);
}

function visibleContentForMember_(items, member, projects, now) {
  var qualified = memberHasCurrentQualification_(member);
  return (items || []).filter(function (item) {
    if (!publishedContentReadable_(item, now)) return false;
    if (item.visibility === 'public') return item.publicSafe === true;
    if (!member || member.membershipState !== 'active') return false;
    if (item.visibility === 'member') return true;
    if (item.visibility !== 'qualified' || !qualified) return false;
    if (!item.projectId) return true;
    var project = (projects || []).filter(function (candidate) { return candidate.id === item.projectId; })[0];
    return Boolean(project && hasProjectAccess_(member, project));
  }).sort(function (left, right) {
    return String(right.publishedAt).localeCompare(String(left.publishedAt)) || String(left.id).localeCompare(String(right.id));
  }).map(publicContentView_);
}

function visiblePublicContent_(items, now) {
  return (items || []).filter(function (item) {
    return publishedContentReadable_(item, now) && item.visibility === 'public' && item.publicSafe === true;
  }).sort(function (left, right) {
    return String(right.publishedAt).localeCompare(String(left.publishedAt)) || String(left.id).localeCompare(String(right.id));
  }).map(publicContentView_);
}

function normalizeInvestmentPreferences_(input) {
  var value = input || {};
  var industryValues = value.industries || value.industryPreferences;
  if (!Array.isArray(industryValues) || !industryValues.length) {
    throw domainError_('investmentPreferences.industries is required', 'investment_preferences_required', 409);
  }
  var industries = industryValues.map(function (industry) {
    return assertRequiredString_(industry, 'investmentPreferences.industries', 100);
  }).filter(function (industry, index, all) { return all.indexOf(industry) === index; });
  var minimum = normalizeTwd_(value.minimumTicketTwd !== undefined ? value.minimumTicketTwd : value.ticketMinTwd, 'minimumTicketTwd');
  var maximum = normalizeTwd_(value.maximumTicketTwd !== undefined ? value.maximumTicketTwd : value.ticketMaxTwd, 'maximumTicketTwd');
  if (maximum <= 0 || maximum < minimum) throw domainError_('Investment ticket range is invalid', 'invalid_investment_ticket_range', 409);
  return { industries: industries, minimumTicketTwd: minimum, maximumTicketTwd: maximum };
}

function projectEligibleForMatching_(project, now) {
  var nowMs = Date.parse(String(now || nowIso_()));
  if (!Number.isFinite(nowMs) || !project || project.withdrawnAt || project.archivedAt || project.closedAt ||
      ['withdrawn', 'closed'].indexOf(project.publicVisibility) !== -1) return false;
  if (project.status !== 'published') return false;
  var publishedAt = Date.parse(String(project.publishedAt || ''));
  if (!Number.isFinite(publishedAt) || publishedAt > nowMs) return false;
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(project.deadline || ''));
  if (!match) return false;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (calendarCheck.getUTCFullYear() !== year || calendarCheck.getUTCMonth() !== month - 1 || calendarCheck.getUTCDate() !== day) return false;
  var deadline = Date.parse(String(project.deadline) + 'T23:59:59.999+08:00');
  return Number.isFinite(deadline) && deadline >= nowMs;
}

function projectMatchCandidates_(subject, member, projects, now) {
  if (!subject || !subject.investmentPreferences) return [];
  var preferences = normalizeInvestmentPreferences_(subject.investmentPreferences);
  var qualified = memberHasCurrentQualification_(member);
  return (projects || []).map(function (project) {
    if (!projectEligibleForMatching_(project, now)) return null;
    var industryMatch = preferences.industries.indexOf(project.industry) !== -1;
    var minimumTicket = Number(project.minimumAmountTwd || 0);
    var maximumTicket = Number(project.targetAmountTwd || minimumTicket);
    var ticketMatch = preferences.maximumTicketTwd >= minimumTicket && preferences.minimumTicketTwd <= maximumTicket;
    var access = Boolean(member && hasProjectAccess_(member, project));
    var eligible = industryMatch && ticketMatch && qualified && access;
    var score = (industryMatch ? 40 : 0) + (ticketMatch ? 30 : 0) + (qualified ? 15 : 0) + (access ? 15 : 0);
    return {
      projectId: project.id,
      projectName: project.displayName,
      displayName: project.displayName,
      industry: project.industry,
      stage: project.stage,
      score: score,
      industryMatch: industryMatch,
      ticketRangeMatch: ticketMatch,
      qualificationMatch: qualified,
      accessMatch: access,
      eligible: eligible,
      reasons: [
        industryMatch ? { code: 'industry_match', label: '符合產業偏好' } : { code: 'industry_mismatch', label: '不符合產業偏好' },
        ticketMatch ? { code: 'ticket_range_match', label: '符合投資金額範圍' } : { code: 'ticket_range_mismatch', label: '不符合投資金額範圍' },
        qualified ? { code: 'qualification_approved', label: '投資資格有效' } : { code: 'qualification_required', label: '尚需有效投資資格' },
        access ? { code: 'project_access_granted', label: '已具專案存取權' } : { code: 'project_access_required', label: '尚需專案存取授權' }
      ],
      updatedAt: project.updatedAt
    };
  }).filter(Boolean).sort(function (left, right) {
    return right.score - left.score || String(left.projectId).localeCompare(String(right.projectId));
  });
}

function deterministicProjectMatches_(member, projects, subscriptions, now) {
  return projectMatchCandidates_(member, member, projects, now).filter(function (match) { return match.eligible; });
}

function normalizeDeliveryChannels_(channels) {
  var requested = Array.isArray(channels) ? channels : ['in_app'];
  var result = ['in_app'];
  requested.forEach(function (channel) {
    var normalized = String(channel).toLowerCase();
    if (ZF_DELIVERY_CHANNELS.indexOf(normalized) === -1) throw domainError_('Unsupported delivery channel', 'invalid_delivery_channel');
    if (result.indexOf(normalized) === -1) result.push(normalized);
  });
  return result;
}

function normalizeNewsletterPreference_(input, member, now, current) {
  var value = input || {};
  var dailyConsent = booleanInput_(value.dailyDigestConsent, current && current.dailyDigestConsent);
  var marketingConsent = booleanInput_(value.marketingConsent, current && current.marketingConsent);
  var emailDeliveryConsent = booleanInput_(value.emailDeliveryConsent, current && current.emailDeliveryConsent);
  var lineDeliveryConsent = booleanInput_(value.lineDeliveryConsent, current && current.lineDeliveryConsent);
  var channels = normalizeDeliveryChannels_(value.deliveryChannels === undefined && current ? current.deliveryChannels : value.deliveryChannels);
  if (!dailyConsent && channels.some(function (channel) { return channel === 'line' || channel === 'email'; })) {
    throw domainError_('LINE and email digest delivery require dailyDigestConsent', 'daily_digest_consent_required', 409);
  }
  if ((channels.indexOf('line') !== -1 && !lineDeliveryConsent) ||
      (channels.indexOf('email') !== -1 && !emailDeliveryConsent)) {
    throw domainError_('External digest delivery requires channel-specific consent', 'delivery_consent_required', 409);
  }
  if (channels.indexOf('line') !== -1 && !member.lineUserId) {
    throw domainError_('LINE digest delivery requires a linked LINE identity', 'delivery_identity_missing', 409);
  }
  if (channels.indexOf('email') !== -1 && !member.email) {
    throw domainError_('Email digest delivery requires a member email', 'delivery_identity_missing', 409);
  }
  return {
    id: current ? current.id : 'newsletter-' + member.id,
    memberId: member.id,
    dailyDigestConsent: dailyConsent,
    marketingConsent: marketingConsent,
    emailDeliveryConsent: emailDeliveryConsent,
    lineDeliveryConsent: lineDeliveryConsent,
    deliveryChannels: channels,
    consentedAt: dailyConsent && (!current || !current.dailyDigestConsent) ? now : (current ? current.consentedAt : ''),
    updatedAt: now
  };
}

function defaultNewsletterPreference_(memberId) {
  return {
    id: 'newsletter-' + memberId, memberId: memberId, dailyDigestConsent: false,
    marketingConsent: false, emailDeliveryConsent: false, lineDeliveryConsent: false,
    deliveryChannels: ['in_app'], consentedAt: '', updatedAt: ''
  };
}

function cancelWithdrawnDailyDigestNotifications_(memberId, actor, requestId, reason) {
  var cancelled = 0;
  storeList_('Notifications').forEach(function (current) {
    if (current.recipientMemberId !== memberId || current.eventType !== 'daily_digest' ||
        ['queued', 'retry'].indexOf(current.state) === -1) return;
    var next = Object.assign({}, current, {
      state: 'cancelled_consent', nextAttemptAt: '', lastError: '', updatedAt: nowIso_()
    });
    storePut_('Notifications', next);
    appendAudit_({
      entityType: 'notification', entityId: next.id, action: 'notification.cancelled_consent', actor: actor,
      before: { state: current.state }, after: { state: next.state }, reason: reason, requestId: requestId
    });
    cancelled += 1;
  });
  return cancelled;
}

function taipeiDigestDate_(date) {
  var value = date || new Date();
  return Utilities.formatDate(value, 'Asia/Taipei', 'yyyy-MM-dd');
}

function canonicalDigestProgressItem_(record) {
  var depositPaid = Number(record.depositPaidAmountTwd !== undefined ? record.depositPaidAmountTwd : record.receivedAmountTwd || 0);
  var accountRecorded = record.accountRecordedAmountTwd !== undefined ? Number(record.accountRecordedAmountTwd || 0) :
    Math.max(0, depositPaid - Number(record.refundedAmountTwd || 0));
  return {
    subscriptionId: record.subscriptionId || record.id,
    projectId: record.projectId,
    subscriptionState: record.subscriptionState,
    fundingState: record.fundingState,
    allocationState: record.allocationState,
    requestedAmountTwd: Number(record.requestedAmountTwd || 0),
    approvedAmountTwd: Number(record.approvedAmountTwd || 0),
    depositPaidAmountTwd: depositPaid,
    accountRecordedAmountTwd: accountRecorded,
    allocatedAmountTwd: Number(record.allocatedAmountTwd || 0),
    updatedAt: record.updatedAt || ''
  };
}

function digestForMember_(member, digestDate, contentItems, projects, subscriptions, preference, now) {
  var memberSubscriptions = subscriptions.filter(function (record) { return record.memberId === member.id; });
  return {
    id: createId_('digest'),
    memberId: member.id,
    digestDate: digestDate,
    dedupeKey: member.id + ':' + digestDate,
    contentItems: visibleContentForMember_(contentItems, member, projects).slice(0, 8),
    matches: deterministicProjectMatches_(member, projects, memberSubscriptions).slice(0, 5),
    progress: memberSubscriptions.map(canonicalDigestProgressItem_),
    deliveryChannels: preference.deliveryChannels || ['in_app'],
    deliveryState: { in_app: 'available' },
    createdAt: now,
    updatedAt: now
  };
}

function digestExternalCopy_(digest) {
  return '您的致富投資每日摘要已更新，請登入會員中心查看投資進度與最新資訊。';
}

function sendDailyDigestEmail_(member, digest) {
  var baseUrl = PropertiesService.getScriptProperties().getProperty('MEMBER_APP_BASE_URL') || '';
  var message = digestExternalCopy_(digest);
  MailApp.sendEmail({
    to: member.email,
    subject: '致富投資｜每日投資摘要已更新',
    body: message + (baseUrl ? '\n' + baseUrl.replace(/\/$/, '') + '/member.html' : ''),
    name: '致富投資'
  });
}

function generateDailyDigests_(digestDate, actor, requestId, reason, sendExternal) {
  var auditReason = assertRequiredString_(reason, 'reason', 1000);
  var shouldSendExternal = sendExternal !== false;
  var dateKey = digestDate || taipeiDigestDate_(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw domainError_('digestDate must be YYYY-MM-DD', 'invalid_digest_date');
  var members = storeList_('Members').filter(function (member) { return member.membershipState === 'active'; });
  var preferences = storeList_('NewsletterPreferences');
  var existing = storeList_('DailyDigests');
  var content = storeList_('ContentItems');
  var projects = storeList_('Projects');
  var subscriptions = storeList_('Subscriptions');
  var preferenceByMember = {};
  preferences.forEach(function (preference) { preferenceByMember[preference.memberId] = preference; });
  var existingKeys = {};
  existing.forEach(function (digest) { existingKeys[digest.dedupeKey] = digest; });
  var emailQuota = Math.max(0, Number(MailApp.getRemainingDailyQuota() || 0));
  var summary = { digestDate: dateKey, eligible: members.length, created: 0, existing: 0, lineQueued: 0, emailSubmitted: 0, emailDeferred: 0, emailFailed: 0, emailQuotaStart: emailQuota };
  members.forEach(function (member) {
    var dedupeKey = member.id + ':' + dateKey;
    var preference = preferenceByMember[member.id] || defaultNewsletterPreference_(member.id);
    var digest = existingKeys[dedupeKey];
    var isNew = !digest;
    if (isNew) {
      var now = nowIso_();
      digest = digestForMember_(member, dateKey, content, projects, subscriptions, preference, now);
      storeAppend_('DailyDigests', digest);
      existingKeys[dedupeKey] = digest;
      summary.created += 1;
    } else {
      summary.existing += 1;
    }
    var deliveryBefore = JSON.stringify(digest.deliveryState || {});
    digest.deliveryChannels = preference.deliveryChannels || ['in_app'];
    digest.deliveryState = digest.deliveryState || { in_app: 'available' };
    if (shouldSendExternal && preference.dailyDigestConsent === true && preference.lineDeliveryConsent === true &&
        preference.deliveryChannels.indexOf('line') !== -1 &&
        member.lineUserId && !digest.deliveryState.line) {
      enqueueNotification_({
        recipientMemberId: member.id, lineUserId: member.lineUserId, eventType: 'daily_digest',
        entityType: 'daily_digest', entityId: digest.id, actor: actor, requestId: requestId,
        deepLinkPath: '/member.html#daily-digest'
      });
      digest.deliveryState.line = 'queued';
      summary.lineQueued += 1;
    }
    if (shouldSendExternal && preference.dailyDigestConsent === true && preference.emailDeliveryConsent === true &&
        preference.deliveryChannels.indexOf('email') !== -1 && member.email &&
        (!digest.deliveryState.email || digest.deliveryState.email === 'deferred_quota')) {
      if (emailQuota <= 0) {
        digest.deliveryState.email = 'deferred_quota';
        summary.emailDeferred += 1;
      } else {
        emailQuota -= 1;
      // Mark the attempt before the provider call. If Apps Script terminates in
      // an indeterminate state, we do not risk sending the same daily email twice.
        digest.deliveryState.email = 'submitting';
        storePut_('DailyDigests', digest);
        try {
          sendDailyDigestEmail_(member, digest);
          digest.deliveryState.email = 'submitted';
          summary.emailSubmitted += 1;
        } catch (error) {
          digest.deliveryState.email = 'failed';
          summary.emailFailed += 1;
        }
      }
    }
    digest.updatedAt = nowIso_();
    storePut_('DailyDigests', digest);
    if (isNew) {
      appendAudit_({
        entityType: 'daily_digest', entityId: digest.id, action: 'daily_digest.generated', actor: actor,
        before: null, after: { memberId: member.id, digestDate: dateKey, channels: digest.deliveryChannels },
        reason: auditReason, requestId: requestId
      });
    } else if (deliveryBefore !== JSON.stringify(digest.deliveryState || {})) {
      appendAudit_({
        entityType: 'daily_digest', entityId: digest.id, action: 'daily_digest.delivery_updated', actor: actor,
        before: { deliveryState: JSON.parse(deliveryBefore) }, after: { deliveryState: digest.deliveryState },
        reason: auditReason, requestId: requestId
      });
    }
  });
  summary.emailQuotaRemaining = emailQuota;
  return summary;
}

function prospectKpis_(prospects) {
  return {
    total: prospects.length,
    new: prospects.filter(function (record) { return record.status === 'new'; }).length,
    qualified: prospects.filter(function (record) { return record.status === 'qualified'; }).length,
    linked: prospects.filter(function (record) { return Boolean(record.linkedMemberId); }).length,
    owners: Object.keys(prospects.reduce(function (result, record) { result[record.acquisitionOwnerId] = true; return result; }, {})).length
  };
}

function acquisitionSnapshotForMember_(memberOrId, prospects, capturedAt) {
  var member = typeof memberOrId === 'object' && memberOrId ? memberOrId : null;
  var memberId = member ? member.id : memberOrId;
  if (member && member.leadOwnerAttribution) {
    return {
      leadId: member.leadOwnerAttribution.leadId,
      ownerReferrerId: member.leadOwnerAttribution.referrerId,
      capturedAt: normalizeIsoTime_(capturedAt, 'acquisitionAttributionSnapshot.capturedAt', true)
    };
  }
  var prospect = (prospects || []).filter(function (record) {
    return record.linkedMemberId === memberId && record.acquisitionOwnerId;
  }).sort(function (left, right) {
    return String(left.importedAt || left.createdAt).localeCompare(String(right.importedAt || right.createdAt));
  })[0];
  if (!prospect) return null;
  return {
    leadId: prospect.id,
    ownerReferrerId: prospect.acquisitionOwnerId,
    capturedAt: normalizeIsoTime_(capturedAt, 'acquisitionAttributionSnapshot.capturedAt', true)
  };
}

function prepareMemberForProspectLink_(currentProspect, nextProspect, membersById, referrers, context, now) {
  var member = membersById[nextProspect.linkedMemberId];
  if (!member) throw domainError_('Member not found', 'not_found', 404);
  if (member.leadOwnerAttribution && (member.leadOwnerAttribution.leadId !== nextProspect.id ||
      member.leadOwnerAttribution.referrerId !== nextProspect.acquisitionOwnerId)) {
    throw domainError_('Member already has an immutable lead owner', 'lead_owner_attribution_conflict', 409);
  }
  var owner = (referrers || []).filter(function (record) { return record.id === nextProspect.acquisitionOwnerId; })[0] || null;
  if (!owner) throw domainError_('Acquisition owner not found', 'acquisition_owner_not_found', 409);
  var attribution = member.referralAttribution;
  var verified = attribution && attribution.state === 'verified' ? attribution : null;
  if (verified && verified.referrerId !== owner.id) {
    throw domainError_('Verified member referrer conflicts with the lead owner', 'member_attribution_conflict', 409);
  }
  if (!verified) {
    attribution = {
      referrerId: owner.id, referralCode: owner.code, state: 'verified',
      evidenceReference: nextProspect.sourceReference,
      claimedAt: attribution && attribution.claimedAt || (currentProspect && currentProspect.createdAt) || nextProspect.createdAt,
      verifiedBy: context.actorId, verifiedAt: now
    };
  }
  return Object.assign({}, member, {
    leadOwnerAttribution: member.leadOwnerAttribution || {
      leadId: nextProspect.id, referrerId: owner.id, capturedAt: now
    },
    referralAttribution: attribution,
    updatedAt: now
  });
}

function operationAdminListProspects_(payload, context) {
  assertRole_(context, ['admin']);
  var records = storeList_('Prospects');
  var limit = Math.max(1, Math.min(Number(payload.limit) || 100, 500));
  return { leads: records.slice(0, limit), records: records.slice(0, limit), total: records.length, kpis: prospectKpis_(records) };
}

function operationAdminCreateProspect_(payload, context) {
  assertRole_(context, ['admin']);
  var reason = assertRequiredString_(payload.reason, 'reason', 1000);
  var input = normalizeProspectAliases_(payload.prospect || payload.lead || payload);
  var owner = resolveAcquisitionOwner_(input.acquisitionOwnerId, storeList_('Referrers'));
  input.acquisitionOwnerId = owner.id;
  var existing = storeList_('Prospects').filter(function (record) {
    var retained = normalizedProspectIdentityKeys_(record);
    return normalizedProspectIdentityKeys_(input).some(function (key) { return retained.indexOf(key) !== -1; });
  })[0];
  if (existing) {
    if (existing.acquisitionOwnerId !== owner.id) {
      throw domainError_('Prospect contact is already owned by another acquisition owner', 'prospect_owner_conflict', 409);
    }
    appendAudit_({ entityType: 'prospect', entityId: existing.id, action: 'prospect.duplicate_ignored', actor: actorFromContext_(context), before: null, after: { retainedAcquisitionOwnerId: existing.acquisitionOwnerId }, reason: reason, requestId: context.requestId });
    return { lead: existing, prospect: existing, duplicate: true };
  }
  var requestedMemberId = input.linkedMemberId;
  input.linkedMemberId = '';
  if (requestedMemberId && input.status === 'converted') input.status = 'new';
  var now = nowIso_();
  var prospect = createProspectRecord_(input, createId_('prospect'), '', now, context.actorId);
  var linkedMember = null;
  var originalLinkedMember = null;
  if (requestedMemberId) {
    var members = storeList_('Members');
    var memberMap = {};
    members.forEach(function (member) { memberMap[member.id] = member; });
    var currentProspects = storeList_('Prospects');
    prospect = patchProspectRecord_(prospect, { linkedMemberId: requestedMemberId }, memberMap, currentProspects, now);
    originalLinkedMember = memberMap[requestedMemberId];
    linkedMember = prepareMemberForProspectLink_(null, prospect, memberMap, [owner], context, now);
  }
  if (linkedMember) {
    var linkedMemberWritten = false;
    try {
      storePut_('Members', linkedMember);
      linkedMemberWritten = true;
      storeAppend_('Prospects', prospect);
    } catch (error) {
      if (linkedMemberWritten && originalLinkedMember) storePut_('Members', originalLinkedMember);
      throw error;
    }
  } else {
    storeAppend_('Prospects', prospect);
  }
  appendAudit_({ entityType: 'prospect', entityId: prospect.id, action: 'prospect.created', actor: actorFromContext_(context), before: null, after: prospect, reason: reason, requestId: context.requestId });
  return { lead: prospect, prospect: prospect };
}

function operationAdminImportProspects_(payload, context) {
  assertRole_(context, ['admin']);
  var reason = assertRequiredString_(payload.reason, 'reason', 1000);
  var items = payload.prospects || payload.leads || payload.records || payload.rows;
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) throw domainError_('leads must contain 1 to 500 records', 'validation_error');
  var referrers = storeList_('Referrers');
  var existing = storeList_('Prospects');
  var knownContacts = {};
  existing.forEach(function (record) { normalizedProspectIdentityKeys_(record).forEach(function (key) { knownContacts[key] = record; }); });
  var batchId = createId_('lead-import');
  var imported = [];
  var skipped = [];
  var candidates = [];
  items.forEach(function (item, index) {
    var merged = Object.assign({}, item);
    if (!merged.sourceReference && !merged.sourceEvidence) merged.sourceReference = payload.sourceReference || payload.sourceEvidence;
    var privacy = payload.privacyEvidence || {};
    if (!merged.privacyEvidenceReference) merged.privacyEvidenceReference = payload.privacyEvidenceReference || privacy.reference;
    if (!merged.privacyConsentedAt) merged.privacyConsentedAt = payload.privacyConsentedAt || privacy.consentedAt;
    if (!merged.privacyNoticeVersion) merged.privacyNoticeVersion = payload.privacyNoticeVersion || privacy.noticeVersion;
    var input = normalizeProspectAliases_(merged);
    var requestedMemberId = input.linkedMemberId;
    input.linkedMemberId = '';
    if (requestedMemberId) {
      throw domainError_('Batch import cannot link members; import first, then use the audited lead PATCH route', 'validation_error', 409);
    }
    var owner = resolveAcquisitionOwner_(input.acquisitionOwnerId, referrers);
    input.acquisitionOwnerId = owner.id;
    var keys = normalizedProspectIdentityKeys_(input);
    var duplicate = null;
    keys.some(function (key) { if (knownContacts[key]) { duplicate = knownContacts[key]; return true; } return false; });
    if (duplicate) {
      if (duplicate.acquisitionOwnerId !== owner.id) {
        throw domainError_('Prospect contact is already owned by another acquisition owner', 'prospect_owner_conflict', 409);
      }
      skipped.push({ row: index + 1, reason: 'duplicate_identity' });
      return;
    }
    var prospect = createProspectRecord_(input, createId_('prospect'), batchId, nowIso_(), context.actorId);
    keys.forEach(function (key) { knownContacts[key] = prospect; });
    candidates.push(prospect);
  });
  storeAppendMany_('Prospects', candidates);
  imported = candidates.slice();
  appendAudit_({ entityType: 'prospect_import', entityId: batchId, action: 'prospect.imported', actor: actorFromContext_(context), before: null, after: { imported: imported.length, skipped: skipped.length }, reason: reason, requestId: context.requestId });
  return { batchId: batchId, imported: imported, importedCount: imported.length, skipped: skipped, skippedCount: skipped.length };
}

function operationAdminPatchProspect_(payload, context) {
  assertRole_(context, ['admin']);
  var reason = assertRequiredString_(payload.reason || (payload.patch && payload.patch.reason), 'reason', 1000);
  var prospectId = assertRequiredString_(payload.prospectId || payload.leadId || payload.id, 'prospectId', 100);
  var current = requireRecord_('Prospects', prospectId);
  var members = storeList_('Members');
  var memberMap = {};
  members.forEach(function (member) { memberMap[member.id] = member; });
  var prospects = storeList_('Prospects');
  var next = patchProspectRecord_(current, payload.patch || payload.lead || payload, memberMap, prospects, nowIso_());
  var linkedMember = null;
  if (next.linkedMemberId && next.linkedMemberId !== current.linkedMemberId) {
    linkedMember = prepareMemberForProspectLink_(current, next, memberMap, storeList_('Referrers'), context, nowIso_());
  }
  if (linkedMember) storePut_('Members', linkedMember);
  storePut_('Prospects', next);
  appendAudit_({ entityType: 'prospect', entityId: next.id, action: 'prospect.admin_patched', actor: actorFromContext_(context), before: current, after: next, reason: reason, requestId: context.requestId });
  return { lead: next, prospect: next };
}

function operationAdminListMatches_(payload, context) {
  assertRole_(context, ['admin']);
  var members = storeList_('Members');
  var prospects = storeList_('Prospects');
  var memberId = normalizeOptionalString_(payload.memberId, 100);
  var leadId = normalizeOptionalString_(payload.leadId || payload.prospectId, 100);
  var projects = storeList_('Projects');
  if (leadId) {
    var lead = prospects.filter(function (record) { return record.id === leadId; })[0];
    if (!lead) throw domainError_('Prospect not found', 'not_found', 404);
    var linkedMember = lead.linkedMemberId ? members.filter(function (record) { return record.id === lead.linkedMemberId; })[0] || null : null;
    return { subjectType: 'lead', subjectId: lead.id, matches: projectMatchCandidates_(lead, linkedMember, projects) };
  }
  if (memberId) {
    var member = members.filter(function (record) { return record.id === memberId; })[0];
    if (!member) throw domainError_('Member not found', 'not_found', 404);
    return { subjectType: 'member', subjectId: member.id, matches: projectMatchCandidates_(member, member, projects) };
  }
  var leadMatches = prospects.map(function (lead) {
    var linked = lead.linkedMemberId ? members.filter(function (record) { return record.id === lead.linkedMemberId; })[0] || null : null;
    return { subjectType: 'lead', subjectId: lead.id, leadId: lead.id, matches: projectMatchCandidates_(lead, linked, projects) };
  });
  var memberMatches = members.map(function (member) {
    return { subjectType: 'member', subjectId: member.id, memberId: member.id, matches: projectMatchCandidates_(member, member, projects) };
  });
  return { matches: leadMatches.concat(memberMatches), leads: leadMatches, members: memberMatches };
}

function operationListMatches_(payload, context) {
  assertRole_(context, ['member', 'qualified']);
  var member = requireRecord_('Members', context.memberId);
  return { matches: deterministicProjectMatches_(member, storeList_('Projects'), storeList_('Subscriptions')) };
}

function operationAdminListContent_(payload, context) {
  assertRole_(context, ['admin']);
  var records = storeList_('ContentItems');
  return { content: records, records: records, total: records.length };
}

function operationAdminCreateContent_(payload, context) {
  assertRole_(context, ['admin']);
  var reason = assertRequiredString_(payload.reason, 'reason', 1000);
  var now = nowIso_();
  var content = normalizeContentRecord_(Object.assign({}, payload.content || payload, { id: createId_('content') }), null, context.actorId, now);
  if (content.projectId && !storeFindById_('Projects', content.projectId)) throw domainError_('Project not found', 'not_found', 404);
  storeAppend_('ContentItems', content);
  appendAudit_({ entityType: 'content', entityId: content.id, action: 'content.created', actor: actorFromContext_(context), before: null, after: content, reason: reason, requestId: context.requestId });
  return { content: content };
}

function operationAdminPatchContent_(payload, context) {
  assertRole_(context, ['admin']);
  var reason = assertRequiredString_(payload.reason || (payload.patch && payload.patch.reason), 'reason', 1000);
  var contentId = assertRequiredString_(payload.contentId || payload.id, 'contentId', 100);
  var current = requireRecord_('ContentItems', contentId);
  var next = normalizeContentRecord_(Object.assign({}, payload.patch || payload, { id: current.id }), current, context.actorId, nowIso_());
  if (next.projectId && !storeFindById_('Projects', next.projectId)) throw domainError_('Project not found', 'not_found', 404);
  storePut_('ContentItems', next);
  appendAudit_({ entityType: 'content', entityId: next.id, action: 'content.admin_patched', actor: actorFromContext_(context), before: current, after: next, reason: reason, requestId: context.requestId });
  return { content: next };
}

function operationListContentFeed_(payload, context) {
  assertRole_(context, ['member', 'qualified']);
  var member = requireRecord_('Members', context.memberId);
  return { content: visibleContentForMember_(storeList_('ContentItems'), member, storeList_('Projects')) };
}

function operationListPublicContent_(payload, context) {
  assertRole_(context, ['visitor', 'member', 'qualified', 'admin', 'service']);
  return { content: visiblePublicContent_(storeList_('ContentItems')) };
}

function operationGetNewsletterPreferences_(payload, context) {
  assertRole_(context, ['member', 'qualified']);
  var member = requireRecord_('Members', context.memberId);
  var current = storeList_('NewsletterPreferences').filter(function (record) { return record.memberId === context.memberId; })[0];
  var preference = current || defaultNewsletterPreference_(context.memberId);
  return {
    preference: preference,
    preferences: preference,
    emailAvailable: Boolean(member.email),
    lineAvailable: Boolean(member.lineUserId)
  };
}

function operationPatchNewsletterPreferences_(payload, context) {
  assertRole_(context, ['member', 'qualified']);
  var reason = 'Member updated newsletter preferences';
  var member = requireRecord_('Members', context.memberId);
  var current = storeList_('NewsletterPreferences').filter(function (record) { return record.memberId === member.id; })[0] || null;
  var next = normalizeNewsletterPreference_(payload.preferences || payload, member, nowIso_(), current);
  storePut_('NewsletterPreferences', next);
  var actor = actorFromContext_(context);
  appendAudit_({ entityType: 'newsletter_preference', entityId: next.id, action: 'newsletter.preference_updated', actor: actor, before: current, after: { memberId: member.id, dailyDigestConsent: next.dailyDigestConsent, marketingConsent: next.marketingConsent, emailDeliveryConsent: next.emailDeliveryConsent, lineDeliveryConsent: next.lineDeliveryConsent, deliveryChannels: next.deliveryChannels }, reason: reason, requestId: context.requestId });
  if (!next.dailyDigestConsent || !next.lineDeliveryConsent || next.deliveryChannels.indexOf('line') === -1) {
    cancelWithdrawnDailyDigestNotifications_(member.id, actor, context.requestId, reason);
  }
  return {
    preference: next, preferences: next,
    emailAvailable: Boolean(member.email), lineAvailable: Boolean(member.lineUserId)
  };
}

function operationGetDailyDigest_(payload, context) {
  assertRole_(context, ['member', 'qualified']);
  var dateKey = payload.digestDate || taipeiDigestDate_(new Date());
  var digest = storeList_('DailyDigests').filter(function (record) {
    return record.memberId === context.memberId && record.digestDate === dateKey;
  })[0] || null;
  if (digest) return {
    digest: Object.assign({}, digest, { progress: (digest.progress || []).map(canonicalDigestProgressItem_) }),
    generated: true
  };
  var member = requireRecord_('Members', context.memberId);
  var preference = storeList_('NewsletterPreferences').filter(function (record) {
    return record.memberId === member.id;
  })[0] || defaultNewsletterPreference_(member.id);
  return {
    digest: digestForMember_(
      member, dateKey, storeList_('ContentItems'), storeList_('Projects'),
      storeList_('Subscriptions'), preference, nowIso_()
    ),
    generated: false
  };
}

function operationAdminDigestPreview_(payload, context) {
  assertRole_(context, ['admin']);
  var dateKey = payload.digestDate || taipeiDigestDate_(new Date());
  var members = storeList_('Members').filter(function (member) { return member.membershipState === 'active'; });
  var memberId = normalizeOptionalString_(payload.memberId, 100);
  if (memberId) members = members.filter(function (member) { return member.id === memberId; });
  var preferences = storeList_('NewsletterPreferences');
  var preferenceMap = {};
  preferences.forEach(function (record) { preferenceMap[record.memberId] = record; });
  return { digestDate: dateKey, previews: members.map(function (member) {
    return digestForMember_(member, dateKey, storeList_('ContentItems'), storeList_('Projects'), storeList_('Subscriptions'), preferenceMap[member.id] || defaultNewsletterPreference_(member.id), nowIso_());
  }) };
}

function operationAdminDigestGenerate_(payload, context) {
  assertRole_(context, ['admin', 'service']);
  assertRequiredString_(payload.reason, 'reason', 1000);
  return { summary: generateDailyDigests_(payload.digestDate || taipeiDigestDate_(new Date()), actorFromContext_(context), context.requestId, payload.reason, payload.send !== false) };
}

var ZF_LEAD_EXPORT_SCHEMA_VERSION = 'lead-export-v1';
var ZF_LEAD_EXPORT_HEADERS = Object.freeze([
  'schemaVersion', 'id', 'displayName', 'phone', 'email', 'channel', 'sourceReference',
  'privacyEvidenceReference', 'privacyConsentedAt', 'privacyNoticeVersion', 'ownerReferrerId',
  'memberId', 'status', 'importedBy', 'importedAt', 'subscriptionCount',
  'attributableRequestedAmountTwd', 'attributableAllocatedAmountTwd'
]);

function prospectExportProjection_(records, subscriptions) {
  var rows = (records || []).map(function (record) {
    var attributed = (subscriptions || []).filter(function (subscription) {
      var snapshot = subscription.acquisitionAttributionSnapshot || {};
      return (snapshot.leadId || snapshot.prospectId) === record.id &&
        (snapshot.ownerReferrerId || snapshot.acquisitionOwnerId) === record.acquisitionOwnerId;
    });
    return {
      schemaVersion: ZF_LEAD_EXPORT_SCHEMA_VERSION,
      id: String(record.id || ''),
      displayName: String(record.displayName || ''),
      phone: String(record.phone || ''),
      email: String(record.email || ''),
      channel: String(record.channel || ''),
      sourceReference: String(record.sourceReference || ''),
      privacyEvidenceReference: String(record.privacyEvidenceReference || ''),
      privacyConsentedAt: String(record.privacyConsentedAt || ''),
      privacyNoticeVersion: String(record.privacyNoticeVersion || ''),
      ownerReferrerId: String(record.acquisitionOwnerId || ''),
      memberId: String(record.linkedMemberId || ''),
      status: String(record.status || ''),
      importedBy: String(record.importedBy || ''),
      importedAt: String(record.importedAt || record.createdAt || ''),
      subscriptionCount: attributed.length,
      attributableRequestedAmountTwd: attributed.reduce(function (total, item) { return total + Number(item.requestedAmountTwd || 0); }, 0),
      attributableAllocatedAmountTwd: attributed.reduce(function (total, item) { return total + Number(item.allocatedAmountTwd || 0); }, 0)
    };
  });
  return {
    schemaVersion: ZF_LEAD_EXPORT_SCHEMA_VERSION,
    headers: ZF_LEAD_EXPORT_HEADERS.slice(),
    rows: rows
  };
}

function prospectRecordsToCsv_(records, subscriptions) {
  var projection = prospectExportProjection_(records, subscriptions);
  var headers = projection.headers;
  var lines = [headers.map(csvEscape_).join(',')];
  projection.rows.forEach(function (exportRow) {
    lines.push(headers.map(function (header) { return csvEscape_(exportRow[header]); }).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

function operationAdminExportProspects_(payload, context) {
  assertRole_(context, ['admin']);
  var records = storeList_('Prospects');
  var subscriptions = storeList_('Subscriptions');
  appendAudit_({ entityType: 'export', entityId: 'leads', action: 'admin.csv_exported', actor: actorFromContext_(context), before: null, after: { rows: records.length }, reason: normalizeOptionalString_(payload.reason, 1000), requestId: context.requestId });
  return {
    filename: 'zhifu-leads-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '.csv',
    mimeType: 'text/csv;charset=utf-8', csv: prospectRecordsToCsv_(records, subscriptions)
  };
}

function operationAdminExportProspectRows_(payload, context) {
  assertRole_(context, ['admin']);
  var reason = assertRequiredString_(payload.reason, 'reason', 1000);
  var records = storeList_('Prospects');
  var subscriptions = storeList_('Subscriptions');
  var projection = prospectExportProjection_(records, subscriptions);
  appendAudit_({
    entityType: 'export', entityId: 'leads', action: 'admin.xlsx_data_exported',
    actor: actorFromContext_(context), before: null,
    after: { schemaVersion: projection.schemaVersion, rows: projection.rows.length },
    reason: reason, requestId: context.requestId
  });
  return {
    filename: 'zhifu-leads-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '.xlsx',
    schemaVersion: projection.schemaVersion,
    headers: projection.headers,
    rows: projection.rows
  };
}
