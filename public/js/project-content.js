function list(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    // Plain text values are accepted from spreadsheet-backed project records.
  }
  return value.split(/[\n、；;]/).map((item) => item.trim()).filter(Boolean);
}

export function approvedProjectReports(project = {}) {
  const reports = project.protected?.reports ?? project.reports ?? [];
  const normalized = Array.isArray(reports) ? reports : [];
  return normalized.filter((report) => {
    const type = String(report?.type || report?.reportType || '').toLowerCase();
    const approved = report?.approved === true
      || report?.status === 'approved'
      || report?.approvalState === 'approved';
    return approved && ['ai', 'expert'].includes(type);
  }).map((report) => ({
    id: String(report.id || ''),
    type: String(report.type || report.reportType).toLowerCase(),
    version: report.version ?? report.versionNumber ?? '—',
    basisDate: report.basisDate || report.dataBasisDate || report.basis_date || '',
    reviewedBy: report.reviewedBy || report.reviewer || report.approvedBy || '',
  }));
}

export function protectedProjectContent(project = {}) {
  const data = project.protected || {};
  return {
    companyName: data.companyName || project.companyName || '',
    round: data.round || project.round || '',
    teamSummary: data.teamSummary || project.teamSummary || '',
    useOfFunds: list(data.useOfFunds ?? project.useOfFunds),
    financialSummary: data.financialSummary || project.financialSummary || '',
    valuationNote: data.valuationNote || project.valuationNote || '',
    reports: approvedProjectReports(project),
  };
}
