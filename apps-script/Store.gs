/** Google Sheets persistence. All mutations must be called under withStoreLock_. */

var ZF_SCHEMA = Object.freeze({
  Members: [
    'id', 'demo', 'displayName', 'legalName', 'phone', 'email', 'lineUserId', 'lineFriendshipState',
    'sourceGroup', 'membershipState', 'qualificationState', 'qualificationApprover',
    'qualificationApprovedAt', 'qualificationReference', 'qualificationExpiresAt',
    'tier', 'projectAccessJson', 'createdAt', 'updatedAt', 'referralAttributionJson'
  ],
  Projects: [
    'id', 'demo', 'slug', 'publicVisibility', 'displayName', 'industry', 'stage', 'region',
    'summary', 'highlightsJson', 'videoUrl', 'updatedAt', 'companyName', 'taxId', 'round',
    'targetAmountTwd', 'minimumAmountTwd', 'incrementAmountTwd', 'deadline', 'valuationNote',
    'useOfFundsJson', 'teamSummary', 'financialSummary', 'risksJson', 'reportsJson',
    'deckJson', 'memberAllowlistJson'
  ],
  Subscriptions: [
    'id', 'demo', 'memberId', 'projectId', 'membershipState', 'qualificationState',
    'subscriptionState', 'fundingState', 'allocationState', 'requestedAmountTwd',
    'approvedAmountTwd', 'receivedAmountTwd', 'allocatedAmountTwd', 'refundedAmountTwd',
    'riskAcknowledged', 'riskAcknowledgedAt', 'riskDisclosureVersion',
    'partnerApprover', 'partnerApprovedAt', 'partnerReference', 'createdAt', 'updatedAt',
    'referralSnapshotJson', 'commissionState', 'commissionBasisAmountTwd',
    'commissionAccruedAmountTwd', 'commissionApprovalJson', 'commissionPaymentJson',
    'commissionVoidReason'
  ],
  Referrers: [
    'id', 'demo', 'code', 'displayName', 'legalName', 'contactName', 'contactEmail',
    'status', 'defaultCommissionRateBps', 'commissionBasis', 'agreementReference',
    'effectiveAt', 'expiresAt', 'createdAt', 'updatedAt'
  ],
  Bookings: [
    'id', 'demo', 'memberId', 'displayName', 'phone', 'email', 'advisorType', 'topic',
    'preferredTime', 'note', 'state', 'createdAt', 'updatedAt'
  ],
  Activations: [
    'id', 'demo', 'memberId', 'lineUserId', 'fullName', 'phone', 'sourceCode',
    'sourceName', 'identityNote', 'lineFriendConfirmed', 'lineFriendshipState',
    'privacyConsent', 'consentedAt',
    'state', 'createdAt', 'updatedAt'
  ],
  Notifications: [
    'id', 'recipientMemberId', 'lineUserId', 'eventType', 'entityType', 'entityId',
    'policy', 'state', 'message', 'deepLink', 'attemptCount', 'lastError', 'nextAttemptAt',
    'manualApprovedBy', 'createdAt', 'updatedAt', 'sentAt'
  ],
  Audits: [
    'id', 'entityType', 'entityId', 'action', 'actorJson', 'beforeJson', 'afterJson',
    'reason', 'requestId', 'createdAt'
  ],
  GatewayNonces: ['nonce', 'timestamp', 'operation', 'createdAt']
});

function withStoreLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    try {
      // Apps Script batches Spreadsheet writes. Commit them while the script
      // lock is still held so the next execution cannot observe stale rows.
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}

function getWorkbook_() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw domainError_('SPREADSHEET_ID Script Property is not configured', 'configuration_error', 500);
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function initializeWorkbookSchema_(workbook) {
  Object.keys(ZF_SCHEMA).forEach(function (sheetName) {
    var expected = ZF_SCHEMA[sheetName];
    var sheet = workbook.getSheetByName(sheetName);
    if (!sheet) sheet = workbook.insertSheet(sheetName);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, expected.length)
        .setBackground('#10243e')
        .setFontColor('#ffffff')
        .setFontWeight('bold');
      return;
    }
    var actual = sheet.getRange(1, 1, 1, expected.length).getValues()[0];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw domainError_(
        'Schema mismatch in ' + sheetName + '. Back up the workbook before migrating.',
        'schema_mismatch',
        500
      );
    }
  });
}

function migrateReferralCommissionSchema_(workbook) {
  var additions = {
    Members: ['referralAttributionJson'],
    Subscriptions: [
      'referralSnapshotJson', 'commissionState', 'commissionBasisAmountTwd',
      'commissionAccruedAmountTwd', 'commissionApprovalJson', 'commissionPaymentJson',
      'commissionVoidReason'
    ]
  };
  Object.keys(additions).forEach(function (sheetName) {
    var sheet = workbook.getSheetByName(sheetName);
    if (!sheet) throw domainError_('Missing sheet: ' + sheetName, 'configuration_error', 500);
    var lastColumn = sheet.getLastColumn();
    var actual = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
    var expected = ZF_SCHEMA[sheetName];
    var legacy = expected.slice(0, expected.length - additions[sheetName].length);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    if (JSON.stringify(actual) !== JSON.stringify(legacy)) {
      throw domainError_('Schema mismatch in ' + sheetName + '. Back up the workbook before migrating.', 'schema_mismatch', 500);
    }
    sheet.getRange(1, actual.length + 1, 1, additions[sheetName].length)
      .setValues([additions[sheetName]])
      .setBackground('#10243e').setFontColor('#ffffff').setFontWeight('bold');
  });
  var referrers = workbook.getSheetByName('Referrers');
  if (!referrers) referrers = workbook.insertSheet('Referrers');
  if (referrers.getLastRow() === 0) {
    referrers.getRange(1, 1, 1, ZF_SCHEMA.Referrers.length).setValues([ZF_SCHEMA.Referrers]);
    referrers.setFrozenRows(1);
    referrers.getRange(1, 1, 1, ZF_SCHEMA.Referrers.length)
      .setBackground('#10243e').setFontColor('#ffffff').setFontWeight('bold');
  }
  initializeWorkbookSchema_(workbook);
}

function sheet_(sheetName) {
  var expected = ZF_SCHEMA[sheetName];
  if (!expected) throw domainError_('Unknown sheet: ' + sheetName, 'configuration_error', 500);
  var sheet = getWorkbook_().getSheetByName(sheetName);
  if (!sheet) throw domainError_('Missing sheet: ' + sheetName, 'configuration_error', 500);
  return sheet;
}

function serializeCell_(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeCell_(value, header) {
  if (value instanceof Date) return value.toISOString();
  if (/Json$/.test(header)) {
    if (value === '' || value === null || value === undefined) return null;
    try {
      return JSON.parse(String(value));
    } catch (error) {
      throw domainError_('Invalid JSON in ' + header, 'corrupt_data', 500);
    }
  }
  if (header === 'demo') return value === true || value === 'TRUE' || value === 'true';
  return value;
}

function entityToRow_(sheetName, entity) {
  var row = Object.assign({}, entity);
  if (sheetName === 'Members') {
    row.projectAccessJson = JSON.stringify(entity.projectAccess || []);
    row.referralAttributionJson = JSON.stringify(entity.referralAttribution || null);
    row.qualificationApprover = entity.qualificationApproval ? entity.qualificationApproval.approver : '';
    row.qualificationApprovedAt = entity.qualificationApproval ? entity.qualificationApproval.approvedAt : '';
    row.qualificationReference = entity.qualificationApproval ? entity.qualificationApproval.reference : '';
    row.qualificationExpiresAt = entity.qualificationApproval ? entity.qualificationApproval.expiresAt : '';
  } else if (sheetName === 'Projects') {
    ['highlights', 'useOfFunds', 'risks', 'reports', 'deck', 'memberAllowlist'].forEach(function (field) {
      row[field + 'Json'] = JSON.stringify(entity[field] === undefined ? null : entity[field]);
    });
  } else if (sheetName === 'Subscriptions') {
    row.referralSnapshotJson = JSON.stringify(entity.referralSnapshot || null);
    row.commissionApprovalJson = JSON.stringify(entity.commissionApproval || null);
    row.commissionPaymentJson = JSON.stringify(entity.commissionPayment || null);
    row.partnerApprover = entity.partnerApproval ? entity.partnerApproval.approver : '';
    row.partnerApprovedAt = entity.partnerApproval ? entity.partnerApproval.approvedAt : '';
    row.partnerReference = entity.partnerApproval ? entity.partnerApproval.reference : '';
  } else if (sheetName === 'Audits') {
    row.actorJson = JSON.stringify(entity.actor || null);
    row.beforeJson = JSON.stringify(entity.before === undefined ? null : entity.before);
    row.afterJson = JSON.stringify(entity.after === undefined ? null : entity.after);
  }
  return ZF_SCHEMA[sheetName].map(function (header) {
    return serializeCell_(row[header]);
  });
}

function rowToEntity_(sheetName, values) {
  var row = {};
  ZF_SCHEMA[sheetName].forEach(function (header, index) {
    row[header] = normalizeCell_(values[index], header);
  });
  if (sheetName === 'Members') {
    row.projectAccess = row.projectAccessJson || [];
    row.qualificationApproval = row.qualificationReference ? {
      approver: row.qualificationApprover,
      approvedAt: row.qualificationApprovedAt,
      reference: row.qualificationReference,
      expiresAt: row.qualificationExpiresAt || ''
    } : null;
    row.referralAttribution = row.referralAttributionJson || null;
    delete row.projectAccessJson;
    delete row.qualificationApprover;
    delete row.qualificationApprovedAt;
    delete row.qualificationReference;
    delete row.qualificationExpiresAt;
    delete row.referralAttributionJson;
  } else if (sheetName === 'Projects') {
    ['highlights', 'useOfFunds', 'risks', 'reports', 'deck', 'memberAllowlist'].forEach(function (field) {
      row[field] = row[field + 'Json'];
      delete row[field + 'Json'];
    });
  } else if (sheetName === 'Subscriptions') {
    row.referralSnapshot = row.referralSnapshotJson || null;
    row.commissionApproval = row.commissionApprovalJson || null;
    row.commissionPayment = row.commissionPaymentJson || null;
    row.partnerApproval = row.partnerReference ? {
      approver: row.partnerApprover,
      approvedAt: row.partnerApprovedAt,
      reference: row.partnerReference
    } : null;
    delete row.partnerApprover;
    delete row.partnerApprovedAt;
    delete row.partnerReference;
    delete row.referralSnapshotJson;
    delete row.commissionApprovalJson;
    delete row.commissionPaymentJson;
  } else if (sheetName === 'Audits') {
    row.actor = row.actorJson;
    row.before = row.beforeJson;
    row.after = row.afterJson;
    delete row.actorJson;
    delete row.beforeJson;
    delete row.afterJson;
  }
  return row;
}

function storeList_(sheetName) {
  var sheet = sheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var width = ZF_SCHEMA[sheetName].length;
  return sheet.getRange(2, 1, lastRow - 1, width).getValues().map(function (values) {
    return rowToEntity_(sheetName, values);
  });
}

function storeFindById_(sheetName, id) {
  var records = storeList_(sheetName);
  for (var index = 0; index < records.length; index += 1) {
    if (records[index].id === id) return records[index];
  }
  return null;
}

function findRowNumberByKey_(sheetName, keyName, keyValue) {
  var headers = ZF_SCHEMA[sheetName];
  var keyIndex = headers.indexOf(keyName);
  if (keyIndex === -1) throw domainError_('Unknown key: ' + keyName, 'configuration_error', 500);
  var sheet = sheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var values = sheet.getRange(2, keyIndex + 1, lastRow - 1, 1).getValues();
  for (var rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    if (String(values[rowIndex][0]) === String(keyValue)) return rowIndex + 2;
  }
  return 0;
}

function storeAppend_(sheetName, entity) {
  sheet_(sheetName).appendRow(entityToRow_(sheetName, entity));
  return entity;
}

function storePut_(sheetName, entity) {
  var rowNumber = findRowNumberByKey_(sheetName, 'id', entity.id);
  var values = entityToRow_(sheetName, entity);
  if (rowNumber) {
    sheet_(sheetName).getRange(rowNumber, 1, 1, values.length).setValues([values]);
  } else {
    sheet_(sheetName).appendRow(values);
  }
  return entity;
}

function appendAudit_(input) {
  var audit = {
    id: createId_('audit'),
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    actor: input.actor || { type: 'system', id: 'system' },
    before: input.before === undefined ? null : input.before,
    after: input.after === undefined ? null : input.after,
    reason: input.reason || '',
    requestId: input.requestId || '',
    createdAt: nowIso_()
  };
  storeAppend_('Audits', audit);
  return audit;
}

function clearDataRows_(sheetName) {
  var sheet = sheet_(sheetName);
  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
}

function csvEscape_(value) {
  var text = value === null || value === undefined ? '' :
    (typeof value === 'object' ? JSON.stringify(value) : String(value));
  return '"' + text.replace(/"/g, '""') + '"';
}

function recordsToCsv_(sheetName, records) {
  var headers = ZF_SCHEMA[sheetName];
  var lines = [headers.map(csvEscape_).join(',')];
  records.forEach(function (entity) {
    lines.push(entityToRow_(sheetName, entity).map(csvEscape_).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

function commissionRecordsToCsv_(records) {
  var headers = [
    'subscriptionId', 'memberId', 'memberName', 'projectId', 'projectName',
    'referrerId', 'referrerName', 'referralCode', 'commissionRateBps', 'commissionBasis',
    'agreementReference', 'commissionState', 'commissionBasisAmountTwd',
    'commissionAccruedAmountTwd', 'commissionApproval', 'commissionPayment',
    'commissionVoidReason', 'updatedAt'
  ];
  var lines = [headers.map(csvEscape_).join(',')];
  records.forEach(function (record) {
    var snapshot = record.referralSnapshot || {};
    var row = [
      record.id, record.memberId, record.memberName, record.projectId, record.projectName,
      snapshot.referrerId, snapshot.referrerName, snapshot.referralCode, snapshot.commissionRateBps,
      snapshot.commissionBasis, snapshot.agreementReference, record.commissionState,
      record.commissionBasisAmountTwd, record.commissionAccruedAmountTwd,
      record.commissionApproval, record.commissionPayment, record.commissionVoidReason, record.updatedAt
    ];
    lines.push(row.map(csvEscape_).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}
