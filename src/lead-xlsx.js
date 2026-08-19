import * as XLSX from 'xlsx';

export const LEAD_EXPORT_SCHEMA_VERSION = 'lead-export-v1';
export const LEAD_EXPORT_FIELDS = Object.freeze([
  'schemaVersion', 'id', 'displayName', 'phone', 'email', 'channel', 'sourceReference',
  'privacyEvidenceReference', 'privacyConsentedAt', 'privacyNoticeVersion', 'ownerReferrerId',
  'memberId', 'status', 'importedBy', 'importedAt', 'subscriptionCount',
  'attributableRequestedAmountTwd', 'attributableAllocatedAmountTwd',
]);

const NUMERIC_FIELDS = new Set([
  'subscriptionCount', 'attributableRequestedAmountTwd', 'attributableAllocatedAmountTwd',
]);

export function leadExportRows(data) {
  return (data.leads || []).map((lead) => {
    const subscriptions = data.subscriptions.filter((item) => (
      item.acquisitionAttributionSnapshot?.leadId === lead.id
      && item.acquisitionAttributionSnapshot.ownerReferrerId === lead.ownerReferrerId
    ));
    return {
      schemaVersion: LEAD_EXPORT_SCHEMA_VERSION,
      id: String(lead.id || ''),
      displayName: String(lead.displayName || ''),
      phone: String(lead.phone || ''),
      email: String(lead.email || ''),
      channel: String(lead.channel || ''),
      sourceReference: String(lead.sourceReference || ''),
      privacyEvidenceReference: String(lead.privacyEvidence?.reference || ''),
      privacyConsentedAt: String(lead.privacyEvidence?.consentedAt || ''),
      privacyNoticeVersion: String(lead.privacyEvidence?.noticeVersion || ''),
      ownerReferrerId: String(lead.ownerReferrerId || ''),
      memberId: String(lead.memberId || ''),
      status: String(lead.status || ''),
      importedBy: String(lead.importedBy || ''),
      importedAt: String(lead.importedAt || lead.createdAt || ''),
      subscriptionCount: subscriptions.length,
      attributableRequestedAmountTwd: subscriptions.reduce((sum, item) => sum + item.requestedAmountTwd, 0),
      attributableAllocatedAmountTwd: subscriptions.reduce((sum, item) => sum + item.allocatedAmountTwd, 0),
    };
  });
}

export function createLeadXlsx(data) {
  const rows = leadExportRows(data);
  const values = [
    [...LEAD_EXPORT_FIELDS],
    ...rows.map((row) => LEAD_EXPORT_FIELDS.map((field) => (
      NUMERIC_FIELDS.has(field) ? Number(row[field]) : String(row[field] ?? '')
    ))),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(values);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', compression: true });
}

export function leadXlsxFilename(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `zhifu-leads-v1-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}.xlsx`;
}
