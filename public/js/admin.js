import { api, appUrl, request } from './api.js';
import { emptyState, errorState, escapeHtml, formatDate, formatMoney, initShell, openDialog, closeDialog, qualificationExpiryIso, resolveAdminDashboardRoute, setButtonBusy, sourceNotice, toast } from './common.js';
import { statusLabels } from './demo-data.js';

let dashboard = { kpis: {}, members: [], leads: [], subscriptions: [], bookings: [], referrers: [], commissions: [], content: [], matches: [], actions: [] };
let projects = [];
let selectedSubscription = null;
let selectedMember = null;
let selectedReferrer = null;
let selectedCommission = null;
let selectedLead = null;
let selectedContent = null;
let leadImportRows = [];
let newsletterPreview = null;
let activeView = 'overview';

const statusLabel = (value) => statusLabels[value] || value || '待確認';
const commissionStatusLabel = (value) => ({
  pending: '待計提／預估', accrued: '已計提', approved: '已核准', paid: '已付款', void: '已作廢', not_applicable: '不適用',
}[value] || statusLabel(value));
const dateTimeInputValue = (value) => value && !Number.isNaN(new Date(value).getTime())
  ? new Date(value).toISOString().slice(0, 16) : '';
const memberDialog = document.querySelector('#member-dialog');
const subscriptionDialog = document.querySelector('#subscription-admin-dialog');
const referrerDialog = document.querySelector('#referrer-dialog');
const commissionDialog = document.querySelector('#commission-dialog');
const leadDialog = document.querySelector('#lead-dialog');
const leadImportDialog = document.querySelector('#lead-import-dialog');
const contentDialog = document.querySelector('#content-dialog');
const normalizeList = (value, key) => Array.isArray(value) ? value : value?.[key] || value?.items || [];

function showView(view, updateHash = true) {
  const next = ['overview', 'members', 'leads', 'subscriptions', 'referrals', 'bookings', 'projects', 'content', 'notifications', 'audit'].includes(view) ? view : 'overview';
  activeView = next;
  document.querySelectorAll('[data-admin-view]').forEach((section) => { section.hidden = section.dataset.adminView !== next; });
  document.querySelectorAll('[data-admin-nav]').forEach((link) => {
    if (link.dataset.adminNav === next) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (updateHash) history.replaceState(null, '', `#${next}`);
  if (next === 'notifications') loadNotifications();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function renderKpis() {
  const kpis = dashboard.kpis || dashboard.overview || {};
  const items = [
    ['會員總數', kpis.totalMembers ?? kpis.memberCount ?? dashboard.members.length, `${kpis.pendingMembers ?? kpis.pendingMemberCount ?? 0} 位待確認`, '01', false],
    ['申請總額', kpis.requestedAmount ?? kpis.requestedAmountTwd, '所有認購意向', '02', true],
    ['合作方核准', kpis.approvedAmount ?? kpis.approvedAmountTwd, '不等於實際入金', '03', true],
    ['實際入金', kpis.receivedAmount ?? kpis.receivedAmountTwd, '站外結果已登錄', '04', true],
    ['最終分配', kpis.allocatedAmount ?? kpis.allocatedAmountTwd, '已完成配置', '05', true],
    ['待補件', dashboard.overview?.needsInformationCount ?? dashboard.members.filter((item) => (item.qualification || item.qualificationState) === 'needs_information').length, '資格資料不完整', '06', false],
    ['合作方待審', dashboard.overview?.pendingPartnerReviewCount ?? dashboard.subscriptions.filter((item) => (item.subscriptionStatus || item.subscriptionState) === 'partner_review').length, '需登錄核准證據', '07', false],
    ['通知異常', dashboard.overview?.notificationAttentionCount ?? 0, '重試或人工確認', '08', false],
  ];
  document.querySelector('#kpi-grid').innerHTML = items.map(([label, value, note, index, money]) => `<article class="kpi-card" data-kpi="${escapeHtml(label)}" data-testid="admin-kpi"><div class="kpi-card__top"><span class="kpi-card__label">${escapeHtml(label)}</span><span class="kpi-card__index">${index}</span></div><strong class="kpi-card__value">${money ? formatMoney(value, true) : Number(value || 0).toLocaleString('zh-TW')}</strong><span class="kpi-card__note">${escapeHtml(note)}</span></article>`).join('');
}

function renderActions() {
  const list = dashboard.actions || [];
  document.querySelector('#action-list').innerHTML = list.length ? list.map((action) => `<li class="action-item" data-priority="${escapeHtml(action.priority)}"><span class="action-item__dot" aria-hidden="true"></span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.detail || action.type || '營運待辦')}</p></div><time>${escapeHtml(action.due || `${action.count ?? 0} 筆`)}</time></li>`).join('') : '<li class="empty-state"><span class="empty-state__mark">✓</span><h3>目前沒有待辦</h3><p>新的會員或認購事件會出現在這裡。</p></li>';
}

function memberState(item) { return item.membership || item.membershipState || 'pending'; }
function qualificationState(item) { return typeof item.qualification === 'string' ? item.qualification : item.qualificationState || item.qualification?.status || 'not_applied'; }
function referralAttribution(item) { return item.referralAttribution || {}; }
function referralName(item) {
  const attribution = referralAttribution(item);
  const referrer = dashboard.referrers.find((candidate) => candidate.id === attribution.referrerId);
  return item.referrerName || attribution.referrerName || attribution.displayName || attribution.name || referrer?.displayName || referrer?.name || '尚未歸屬';
}
function referralSnapshot(item) { return item.referralSnapshot || {}; }
function snapshotName(item) {
  const snapshot = referralSnapshot(item);
  return snapshot.referrerName || snapshot.name || item.referrerName || '無引薦快照';
}
function snapshotRate(item) {
  const snapshot = referralSnapshot(item);
  return Number(snapshot.commissionRateBps ?? snapshot.rateBps ?? snapshot.defaultCommissionRateBps ?? item.commissionRateBps ?? 0);
}
function bpsLabel(value) {
  const bps = Number(value || 0);
  return `${bps.toLocaleString('zh-TW')} bps (${(bps / 100).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}%)`;
}
function referrerStatusLabel(value) { return value === 'disabled' ? '已停用' : '合作中'; }

function memberRows(items) {
  const desktop = `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>會員</th><th>來源</th><th>引薦方</th><th>會員狀態</th><th>投資資格</th><th>LINE</th><th>申請總額</th><th>實際入金</th><th>操作</th></tr></thead><tbody>${items.map((item) => `<tr><td class="data-table__primary"><strong>${escapeHtml(item.name || item.displayName)}</strong><small>${escapeHtml(item.id)}</small></td><td>${escapeHtml(item.source || item.sourceGroup || '—')}</td><td><strong>${escapeHtml(referralName(item))}</strong><small class="table-note">${escapeHtml(referralAttribution(item).evidenceReference || referralAttribution(item).reference || '證據待登錄')}</small></td><td><span class="status" data-status="${escapeHtml(memberState(item))}">${escapeHtml(statusLabel(memberState(item)))}</span></td><td><span class="status" data-status="${escapeHtml(qualificationState(item))}">${escapeHtml(statusLabel(qualificationState(item)))}</span></td><td>${item.lineFriend || item.lineFriendshipState === 'friend' ? '已加好友' : '待確認'}</td><td class="data-table__money">${formatMoney(item.requested, true)}</td><td class="data-table__money">${formatMoney(item.received, true)}</td><td><button class="button button--secondary button--small" type="button" data-member-manage="${escapeHtml(item.id)}">確認／管理</button></td></tr>`).join('')}</tbody></table></div>`;
  const mobile = `<div class="mobile-records">${items.map((item) => `<article class="mobile-record"><div class="mobile-record__top"><div><strong>${escapeHtml(item.name || item.displayName)}</strong><div class="mono micro">${escapeHtml(item.id)}</div></div><span class="status" data-status="${escapeHtml(memberState(item))}">${escapeHtml(statusLabel(memberState(item)))}</span></div><p class="referral-line"><span>引薦</span><strong>${escapeHtml(referralName(item))}</strong></p><div class="mobile-record__meta"><div><span>資格</span><strong>${escapeHtml(statusLabel(qualificationState(item)))}</strong></div><div><span>申請總額</span><strong>${formatMoney(item.requested, true)}</strong></div></div><button class="button button--secondary button--small button--wide" type="button" data-member-manage="${escapeHtml(item.id)}">確認／管理</button></article>`).join('')}</div>`;
  return desktop + mobile;
}

function subscriptionState(item) { return item.subscriptionStatus || item.subscriptionState || 'submitted'; }
function fundingState(item) { return item.fundingStatus || item.fundingState || 'unpaid'; }

function subscriptionRows(items, compact = false) {
  const rows = items.map((item) => `<tr data-testid="subscription-row" data-subscription-id="${escapeHtml(item.id)}"><td class="data-table__primary"><strong>${escapeHtml(item.memberName || item.memberId)}</strong><small>${escapeHtml(item.memberId)}</small></td><td class="data-table__primary"><strong>${escapeHtml(item.projectName || item.projectId)}</strong><small>${escapeHtml(item.id)}</small></td><td><span class="snapshot-chip">認購快照</span><strong class="snapshot-name">${escapeHtml(snapshotName(item))}</strong><small class="table-note">${escapeHtml(referralSnapshot(item).referralCode || referralSnapshot(item).referrerCode || referralSnapshot(item).code || '—')} · ${escapeHtml(bpsLabel(snapshotRate(item)))}</small></td><td class="data-table__money">${formatMoney(item.requestedAmount ?? item.requestedAmountTwd)}</td><td class="data-table__money">${formatMoney(item.approvedAmount ?? item.approvedAmountTwd)}</td><td class="data-table__money">${formatMoney(item.receivedAmount ?? item.receivedAmountTwd)}</td><td><span class="status" data-status="${escapeHtml(subscriptionState(item))}">${escapeHtml(statusLabel(subscriptionState(item)))}</span></td><td><span class="status" data-status="${escapeHtml(fundingState(item))}">${escapeHtml(statusLabel(fundingState(item)))}</span></td><td><button class="button button--secondary button--small" type="button" data-subscription-manage="${escapeHtml(item.id)}" data-testid="subscription-confirm">${subscriptionState(item) === 'submitted' ? '營運確認' : '管理紀錄'}</button></td></tr>`).join('');
  const desktop = `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>會員</th><th>專案／案號</th><th>引薦快照</th><th>申請</th><th>核准</th><th>入金</th><th>認購狀態</th><th>入金狀態</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const mobile = `<div class="mobile-records">${items.map((item) => `<article class="mobile-record" data-testid="subscription-row" data-subscription-id="${escapeHtml(item.id)}"><div class="mobile-record__top"><div><strong>${escapeHtml(item.memberName || item.memberId)}</strong><div class="mono micro">${escapeHtml(item.id)}</div></div><span class="status" data-status="${escapeHtml(subscriptionState(item))}">${escapeHtml(statusLabel(subscriptionState(item)))}</span></div><p class="micro">${escapeHtml(item.projectName || item.projectId)}</p><p class="referral-line"><span>認購快照</span><strong>${escapeHtml(snapshotName(item))}</strong></p><div class="mobile-record__meta"><div><span>申請</span><strong>${formatMoney(item.requestedAmount ?? item.requestedAmountTwd, true)}</strong></div><div><span>實際入金</span><strong>${formatMoney(item.receivedAmount ?? item.receivedAmountTwd, true)}</strong></div></div><button class="button button--secondary button--small button--wide" type="button" data-subscription-manage="${escapeHtml(item.id)}" data-testid="subscription-confirm">${subscriptionState(item) === 'submitted' ? '營運確認' : '管理紀錄'}</button></article>`).join('')}</div>`;
  return desktop + mobile;
}

function renderMembers() {
  const query = document.querySelector('#member-search').value.trim().toLowerCase();
  const filter = document.querySelector('#member-filter').value;
  const items = dashboard.members.filter((item) => {
    const haystack = `${item.name || item.displayName} ${item.id} ${item.source || item.sourceGroup}`.toLowerCase();
    return (!query || haystack.includes(query)) && (filter === 'all' || memberState(item) === filter);
  });
  document.querySelector('#member-table').innerHTML = items.length ? memberRows(items) : emptyState('找不到會員', '調整搜尋字詞或狀態篩選。');
}

const leadStatusLabel = (value) => ({
  new: '新名單', contacted: '已聯繫', qualified: '已確認意向', converted: '已轉會員', archived: '不再追蹤',
}[value] || statusLabel(value));

function leadRows(items) {
  const contact = (item) => item.contact || item.maskedContact || item.email || item.phone || '—';
  const ownerName = (item) => item.ownerName || dashboard.referrers.find((referrer) => referrer.id === (item.ownerReferrerId || item.owner))?.displayName || item.ownerReferrerId || item.owner || '待核對';
  const evidence = (item) => item.privacyEvidence?.reference || item.sourceEvidence || '—';
  const importer = (item) => item.importedBy || item.createdBy || item.createdActor || '營運管理員（見稽核事件）';
  const memberId = (item) => item.memberId || item.linkedMemberId || item.linkMemberId || '';
  const rows = items.map((item) => `<tr data-testid="lead-row" data-lead-id="${escapeHtml(item.id)}"><td class="data-table__primary"><strong>${escapeHtml(item.displayName || item.name)}</strong><small>${escapeHtml(item.id)}</small></td><td>${escapeHtml(contact(item))}</td><td><strong>${escapeHtml(item.channel || '—')}</strong><small class="table-note mono">${escapeHtml(item.sourceReference || item.source || '—')}</small></td><td><span class="immutable-chip">來源鎖定</span><strong class="mono">${escapeHtml(evidence(item))}</strong><small class="table-note">導入者：${escapeHtml(importer(item))} · ${formatDate(item.importedAt || item.createdAt)}</small></td><td><span class="status" data-status="${escapeHtml(item.status || 'new')}">${escapeHtml(leadStatusLabel(item.status || 'new'))}</span></td><td>${escapeHtml(ownerName(item))}</td><td>${memberId(item) ? `<strong>${escapeHtml(item.linkedMemberName || item.memberName || memberId(item))}</strong><small class="table-note mono">${escapeHtml(memberId(item))}</small>` : '<span class="micro">尚未連結</span>'}</td><td><button class="button button--secondary button--small" type="button" data-lead-manage="${escapeHtml(item.id)}">管理</button></td></tr>`).join('');
  const mobile = items.map((item) => `<article class="mobile-record lead-record" data-testid="lead-row" data-lead-id="${escapeHtml(item.id)}"><div class="mobile-record__top"><div><strong>${escapeHtml(item.displayName || item.name)}</strong><div class="mono micro">${escapeHtml(item.id)}</div></div><span class="status" data-status="${escapeHtml(item.status || 'new')}">${escapeHtml(leadStatusLabel(item.status || 'new'))}</span></div><p class="micro">${escapeHtml(item.channel || '—')}｜${escapeHtml(item.sourceReference || item.source || '—')}</p><div class="immutable-evidence"><span>不可變來源證據</span><strong class="mono">${escapeHtml(evidence(item))}</strong><small>導入者：${escapeHtml(importer(item))}</small></div><div class="mobile-record__meta"><div><span>負責引薦方</span><strong>${escapeHtml(ownerName(item))}</strong></div><div><span>會員連結</span><strong>${escapeHtml(item.linkedMemberName || item.memberName || memberId(item) || '尚未連結')}</strong></div></div><button class="button button--secondary button--small button--wide" type="button" data-lead-manage="${escapeHtml(item.id)}">管理潛客</button></article>`).join('');
  return `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>潛客</th><th>聯絡</th><th>來源</th><th>來源證據／導入者</th><th>狀態</th><th>負責人</th><th>會員連結</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobile-records">${mobile}</div>`;
}

function renderLeads() {
  const search = document.querySelector('#lead-search');
  const filterControl = document.querySelector('#lead-filter');
  if (!search || !filterControl) return;
  const query = search.value.trim().toLowerCase();
  const filter = filterControl.value;
  const items = dashboard.leads.filter((item) => {
    const haystack = `${item.displayName || item.name} ${item.contact || item.email || item.phone} ${item.channel} ${item.sourceReference || item.source} ${item.privacyEvidence?.reference || item.sourceEvidence} ${item.ownerReferrerId || item.owner} ${item.memberId || item.linkedMemberId}`.toLowerCase();
    return (!query || haystack.includes(query)) && (filter === 'all' || (item.status || 'new') === filter);
  });
  const counts = {
    total: dashboard.leads.length,
    new: dashboard.leads.filter((item) => (item.status || 'new') === 'new').length,
    active: dashboard.leads.filter((item) => ['contacted', 'qualified'].includes(item.status)).length,
    converted: dashboard.leads.filter((item) => item.linkedMemberId || item.status === 'converted').length,
  };
  document.querySelector('#lead-kpis').innerHTML = [
    ['名單總數', counts.total, 'TOTAL'], ['待首次聯繫', counts.new, 'NEW'], ['追蹤中', counts.active, 'ACTIVE'], ['已連結會員', counts.converted, 'LINKED'],
  ].map(([label, value, code]) => `<article><span>${escapeHtml(label)}</span><strong>${Number(value).toLocaleString('zh-TW')}</strong><small>${code}</small></article>`).join('');
  document.querySelector('#lead-table').innerHTML = items.length ? leadRows(items) : emptyState('找不到潛客', '調整搜尋字詞或狀態篩選；來源證據不會因篩選而變更。');
}

const contentTypeLabel = (value) => ({ video: '投資影音', article: '研究文章', project_update: '專案更新' }[value] || value || '內容');

function renderContent() {
  const filter = document.querySelector('#content-filter')?.value || 'all';
  const items = dashboard.content.filter((item) => filter === 'all' || item.status === filter);
  const cards = items.map((item) => `<article class="content-register-card" data-testid="content-row" data-content-id="${escapeHtml(item.id)}"><div class="content-register-card__top"><span class="content-type">${escapeHtml(contentTypeLabel(item.type))}</span><span class="status" data-status="${escapeHtml(item.status || 'draft')}">${escapeHtml(statusLabel(item.status || 'draft'))}</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary || '尚未填寫摘要')}</p><dl><div><dt>專案</dt><dd>${escapeHtml(item.projectName || item.projectId || '一般內容')}</dd></div><div><dt>公開首頁</dt><dd>${item.status === 'published' && item.publicSafe ? '可顯示' : '不顯示'}</dd></div></dl><p class="risk-copy">${escapeHtml(item.riskNotice || item.riskDisclosure || '風險提示待補')}</p><button class="button button--secondary button--small button--wide" type="button" data-content-edit="${escapeHtml(item.id)}">編輯內容</button></article>`).join('');
  document.querySelector('#content-table').innerHTML = items.length ? `<div class="content-register-grid">${cards}</div>` : emptyState('目前沒有內容', '建立影音、文章或專案更新草稿。');
}

function renderNewsletterPreview() {
  const target = document.querySelector('#newsletter-preview');
  if (!target) return;
  if (!newsletterPreview) {
    target.innerHTML = emptyState('尚無摘要預覽', '重新整理後會依已發布內容與媒合結果產生預覽。');
    return;
  }
  const previews = Array.isArray(newsletterPreview) ? newsletterPreview : normalizeList(newsletterPreview.previews || newsletterPreview.generated, 'previews');
  const digest = previews[0] || newsletterPreview;
  const content = normalizeList(digest.content || digest.contentItems || digest.newContent, 'content');
  const matches = normalizeList(digest.matches || digest.matchedProjects || digest.projectMatches || digest.recommendations, 'matches');
  target.innerHTML = `<div class="digest-preview" data-testid="newsletter-preview"><span class="mono micro">${escapeHtml(digest.date || new Date().toISOString().slice(0, 10))}</span><h3>${escapeHtml(digest.headline || digest.title || '今日投資摘要')}</h3><p>${previews.length ? `${previews.length} 位會員預覽 · ` : ''}${content.length} 則新內容 · ${matches.length} 個推薦專案</p><ol>${content.slice(0, 3).map((item) => `<li>${escapeHtml(item.title)}</li>`).join('')}</ol><div class="notice"><strong>產生不等於傳送</strong><br>外部傳送仍須符合會員每日摘要同意與可用通知管道。</div></div>`;
}

function renderSubscriptions() {
  const query = document.querySelector('#subscription-search').value.trim().toLowerCase();
  const filter = document.querySelector('#subscription-filter').value;
  const items = dashboard.subscriptions.filter((item) => {
    const haystack = `${item.memberName} ${item.memberId} ${item.projectName} ${item.projectId} ${item.id}`.toLowerCase();
    return (!query || haystack.includes(query)) && (filter === 'all' || subscriptionState(item) === filter);
  });
  document.querySelector('#subscription-table').innerHTML = items.length ? subscriptionRows(items) : emptyState('找不到認購紀錄', '調整搜尋字詞或狀態篩選。');
  document.querySelector('#overview-subscriptions').innerHTML = dashboard.subscriptions.length ? subscriptionRows(dashboard.subscriptions.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 5), true) : emptyState('沒有近期異動', '新的認購事件會出現在這裡。');
}

function commissionRecords() {
  const merged = new Map();
  dashboard.commissions.forEach((commission) => {
    const subscriptionId = commission.subscriptionId || commission.id;
    if (subscriptionId) merged.set(subscriptionId, { ...commission, subscriptionId });
  });
  dashboard.subscriptions.filter((item) => item.referralSnapshot || item.commissionState).forEach((subscription) => {
    merged.set(subscription.id, { ...(merged.get(subscription.id) || {}), ...subscription, subscriptionId: subscription.id });
  });
  return [...merged.values()].map((commission) => {
    const subscriptionId = commission.subscriptionId || commission.id;
    const subscription = dashboard.subscriptions.find((item) => item.id === subscriptionId) || {};
    return {
      ...subscription,
      ...commission,
      subscriptionId,
      referralSnapshot: commission.referralSnapshot || subscription.referralSnapshot || {},
      commissionState: commission.commissionState || subscription.commissionState || 'pending',
      commissionBasisAmountTwd: commission.commissionBasisAmountTwd ?? subscription.commissionBasisAmountTwd ?? 0,
      commissionAccruedAmountTwd: commission.commissionAccruedAmountTwd ?? subscription.commissionAccruedAmountTwd ?? 0,
      commissionApproval: commission.commissionApproval || subscription.commissionApproval || null,
      commissionPayment: commission.commissionPayment || subscription.commissionPayment || null,
    };
  });
}

function commissionActionLabel(state) {
  if (state === 'accrued') return '審核分潤';
  if (state === 'approved') return '登錄付款';
  if (state === 'paid') return '查看付款';
  if (state === 'void') return '查看作廢';
  return '查看計提';
}

function referrerStats(referrer, records) {
  const referrerId = referrer.id;
  const referrerCode = String(referrer.code || '').toLowerCase();
  const attributedMembers = dashboard.members.filter((member) => {
    const attribution = referralAttribution(member);
    return attribution.state === 'verified' && (attribution.referrerId === referrerId || (referrerCode && String(attribution.referralCode || attribution.referrerCode || '').toLowerCase() === referrerCode));
  }).length;
  const attributedDeals = records.filter((record) => {
    const snapshot = referralSnapshot(record);
    return snapshot.referrerId === referrerId || (referrerCode && String(snapshot.referralCode || snapshot.referrerCode || snapshot.code || '').toLowerCase() === referrerCode);
  });
  const sum = (selector) => attributedDeals.reduce((total, item) => total + Number(selector(item) || 0), 0);
  return {
    attributedMembers,
    basis: sum((item) => item.commissionBasisAmountTwd),
    accrued: sum((item) => item.commissionState === 'void' ? 0 : item.commissionAccruedAmountTwd),
    approved: sum((item) => ['approved', 'paid'].includes(item.commissionState) ? item.commissionAccruedAmountTwd : 0),
    paid: sum((item) => item.commissionState === 'paid' ? item.commissionAccruedAmountTwd : 0),
  };
}

function renderReferrers(records) {
  const target = document.querySelector('#referrer-table');
  if (!dashboard.referrers.length) {
    target.innerHTML = emptyState('尚未建立引薦方', '新增第一位合作引薦方，為後續會員來源與成交分潤留下可稽核依據。');
    return;
  }
  const desktopRows = dashboard.referrers.map((referrer) => {
    const stats = referrerStats(referrer, records);
    return `<tr data-testid="referral-row" data-referrer-id="${escapeHtml(referrer.id)}"><td class="data-table__primary"><strong>${escapeHtml(referrer.displayName || referrer.name)}</strong><small>${escapeHtml(referrer.code)}</small></td><td><span class="status" data-status="${escapeHtml(referrer.status || 'active')}">${escapeHtml(referrerStatusLabel(referrer.status))}</span></td><td class="data-table__money">${escapeHtml(bpsLabel(referrer.defaultCommissionRateBps ?? referrer.defaultRateBps))}</td><td class="data-table__money">${stats.attributedMembers.toLocaleString('zh-TW')} 位</td><td class="data-table__money">${formatMoney(stats.basis)}</td><td class="data-table__money">${formatMoney(stats.accrued)}</td><td class="data-table__money">${formatMoney(stats.approved)}</td><td class="data-table__money">${formatMoney(stats.paid)}</td><td><button class="button button--secondary button--small" type="button" data-referrer-edit="${escapeHtml(referrer.id)}">編輯</button></td></tr>`;
  }).join('');
  const mobileRows = dashboard.referrers.map((referrer) => {
    const stats = referrerStats(referrer, records);
    return `<article class="mobile-record referral-record" data-testid="referral-row" data-referrer-id="${escapeHtml(referrer.id)}"><div class="mobile-record__top"><div><strong>${escapeHtml(referrer.displayName || referrer.name)}</strong><div class="mono micro">${escapeHtml(referrer.code)}</div></div><span class="status" data-status="${escapeHtml(referrer.status || 'active')}">${escapeHtml(referrerStatusLabel(referrer.status))}</span></div><p class="referral-rate">${escapeHtml(bpsLabel(referrer.defaultCommissionRateBps ?? referrer.defaultRateBps))}</p><div class="mobile-record__meta"><div><span>歸屬會員</span><strong>${stats.attributedMembers.toLocaleString('zh-TW')} 位</strong></div><div><span>成交基礎</span><strong>${formatMoney(stats.basis, true)}</strong></div><div><span>已計提</span><strong>${formatMoney(stats.accrued, true)}</strong></div><div><span>已核准</span><strong>${formatMoney(stats.approved, true)}</strong></div><div><span>已付款</span><strong>${formatMoney(stats.paid, true)}</strong></div></div><button class="button button--secondary button--small button--wide" type="button" data-referrer-edit="${escapeHtml(referrer.id)}">編輯引薦方</button></article>`;
  }).join('');
  target.innerHTML = `<div class="data-table-wrap"><table class="data-table referral-table"><thead><tr><th>引薦方／代碼</th><th>狀態</th><th>預設比例</th><th>歸屬會員</th><th>成交基礎</th><th>已計提</th><th>已核准</th><th>已付款</th><th>操作</th></tr></thead><tbody>${desktopRows}</tbody></table></div><div class="mobile-records">${mobileRows}</div>`;
}

function renderCommissionRows(records) {
  const target = document.querySelector('#commission-table');
  const filter = document.querySelector('#commission-filter')?.value || 'all';
  const items = records.filter((item) => filter === 'all' || item.commissionState === filter);
  if (!items.length) {
    target.innerHTML = emptyState('沒有符合條件的分潤', '成交完成並產生分潤計提後，紀錄會出現在這裡。');
    return;
  }
  const detail = (item) => {
    const snapshot = referralSnapshot(item);
    return `<span class="snapshot-chip">不可變快照</span><strong class="snapshot-name">${escapeHtml(snapshotName(item))}</strong><small class="table-note">${escapeHtml(snapshot.referralCode || snapshot.referrerCode || snapshot.code || '—')} · ${escapeHtml(bpsLabel(snapshotRate(item)))}</small><small class="table-note">協議 ${escapeHtml(snapshot.agreementReference || '—')}</small>`;
  };
  const evidence = (item) => {
    if (item.commissionState === 'paid') return `付款 ${escapeHtml(item.commissionPayment?.reference || item.commissionPayment?.payoutReference || '已登錄')}`;
    if (item.commissionState === 'approved') return `核准 ${escapeHtml(item.commissionApproval?.reference || item.commissionApproval?.approvalReference || '已登錄')}`;
    if (item.commissionState === 'void') return `作廢 ${escapeHtml(item.commissionVoid?.reason || item.voidReason || '已登錄')}`;
    return '等待人工審核';
  };
  const desktopRows = items.map((item) => `<tr data-testid="commission-row" data-subscription-id="${escapeHtml(item.subscriptionId)}"><td class="data-table__primary"><strong>${escapeHtml(item.memberName || item.memberId)}</strong><small>${escapeHtml(item.memberId || '—')}</small></td><td class="data-table__primary"><strong>${escapeHtml(item.projectName || item.projectId)}</strong><small>${escapeHtml(item.subscriptionId)}</small></td><td class="snapshot-cell">${detail(item)}</td><td class="data-table__money">${formatMoney(item.commissionBasisAmountTwd)}</td><td class="data-table__money"><strong>${formatMoney(item.commissionAccruedAmountTwd)}</strong><small class="table-note">系統衍生</small></td><td><span class="status" data-status="${escapeHtml(item.commissionState)}">${escapeHtml(commissionStatusLabel(item.commissionState))}</span><small class="table-note">${evidence(item)}</small></td><td><button class="button button--secondary button--small" type="button" data-commission-manage="${escapeHtml(item.subscriptionId)}">${commissionActionLabel(item.commissionState)}</button></td></tr>`).join('');
  const mobileRows = items.map((item) => `<article class="mobile-record commission-record" data-testid="commission-row" data-subscription-id="${escapeHtml(item.subscriptionId)}"><div class="mobile-record__top"><div><strong>${escapeHtml(item.memberName || item.memberId)}</strong><div class="mono micro">${escapeHtml(item.subscriptionId)}</div></div><span class="status" data-status="${escapeHtml(item.commissionState)}">${escapeHtml(commissionStatusLabel(item.commissionState))}</span></div><p class="micro">${escapeHtml(item.projectName || item.projectId)}</p><div class="snapshot-box">${detail(item)}</div><div class="mobile-record__meta"><div><span>成交基礎</span><strong>${formatMoney(item.commissionBasisAmountTwd, true)}</strong></div><div><span>預估／計提</span><strong>${formatMoney(item.commissionAccruedAmountTwd, true)}</strong></div></div><p class="micro">${evidence(item)}</p><button class="button button--secondary button--small button--wide" type="button" data-commission-manage="${escapeHtml(item.subscriptionId)}">${commissionActionLabel(item.commissionState)}</button></article>`).join('');
  target.innerHTML = `<div class="data-table-wrap"><table class="data-table commission-table"><thead><tr><th>投資人</th><th>專案／認購</th><th>引薦快照</th><th>成交基礎</th><th>預估／計提分潤</th><th>狀態／證據</th><th>操作</th></tr></thead><tbody>${desktopRows}</tbody></table></div><div class="mobile-records">${mobileRows}</div>`;
}

function renderReferrals() {
  const records = commissionRecords();
  const activeReferrers = dashboard.referrers.filter((item) => (item.status || 'active') === 'active').length;
  const attributedMembers = dashboard.members.filter((item) => referralAttribution(item).state === 'verified').length;
  const basis = records.reduce((total, item) => total + Number(item.commissionBasisAmountTwd || 0), 0);
  const accrued = records.reduce((total, item) => total + (item.commissionState === 'void' ? 0 : Number(item.commissionAccruedAmountTwd || 0)), 0);
  const summary = [
    ['合作引薦方', activeReferrers, 'active'],
    ['已歸屬投資人', `${attributedMembers.toLocaleString('zh-TW')} 位`, 'members'],
    ['成交計算基礎', formatMoney(basis, true), 'basis'],
    ['預估／已計提', formatMoney(accrued, true), 'accrued'],
  ];
  document.querySelector('#referral-summary').innerHTML = summary.map(([label, value, key]) => `<article class="referral-summary__item" data-summary="${key}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`).join('');
  renderReferrers(records);
  renderCommissionRows(records);
}

function renderBookings() {
  const target = document.querySelector('#admin-booking-list');
  if (!target) return;
  const items = dashboard.bookings.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  target.innerHTML = items.length ? `<div class="record-list">${items.map((item) => `<article class="record-card" data-testid="admin-booking"><div class="record-card__head"><div><span class="mono micro">${escapeHtml(item.id)}</span><h3>${escapeHtml(item.topic || item.advisorType || '顧問預約')}</h3></div><span class="status" data-status="${escapeHtml(item.status || 'requested')}">${escapeHtml(statusLabel(item.status || 'requested'))}</span></div><div class="record-card__body"><p><strong>${escapeHtml(item.contactName || item.memberName || item.memberId || '訪客')}</strong></p><p class="micro">偏好：${formatDate(item.preferredDate)}｜${escapeHtml(item.preferredTime || '時段待確認')}</p><p class="micro">身分：${escapeHtml(item.identityType || 'investor')}｜會員：${escapeHtml(item.memberId || '未綁定')}</p>${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}</div></article>`).join('')}</div>` : emptyState('目前沒有預約', '公開或會員顧問預約送出後會出現在這裡。');
}

function renderProjects() {
  document.querySelector('#admin-project-grid').innerHTML = projects.length ? projects.map((project) => {
    const protectedData = project.protected || {};
    return `<article class="project-card"><div class="project-card__rail"></div><div class="project-card__head"><span class="project-card__code">${escapeHtml(project.id)}</span><span class="status">${escapeHtml(project.publicVisibility || 'anonymous')}</span></div><div class="project-card__body"><h3>${escapeHtml(project.displayName)}</h3><p>${escapeHtml(project.summary)}</p><ul class="project-card__meta"><li><span>Industry</span><strong>${escapeHtml(project.industry)}</strong></li><li><span>Target</span><strong>${formatMoney(protectedData.targetAmountTwd, true)}</strong></li><li><span>Allowlist</span><strong>${Number(project.memberAllowlist?.length || 0)} 位</strong></li><li><span>Updated</span><strong>${formatDate(project.updatedAt)}</strong></li></ul></div><div class="project-card__foot"><span class="micro">${project.demo ? 'DEMO' : '正式資料'}</span><button class="button button--quiet button--small" type="button" data-placeholder-action="專案編輯">編輯設定</button></div></article>`;
  }).join('') : emptyState('尚無專案', '建立草稿後，先完成內容審核再決定公開程度。');

  document.querySelector('#project-progress').innerHTML = projects.length ? projects.slice(0, 4).map((project) => {
    const target = Number(project.protected?.targetAmountTwd || project.targetAmount || 0);
    const requested = dashboard.subscriptions.filter((item) => item.projectId === project.id).reduce((sum, item) => sum + Number(item.requestedAmount || item.requestedAmountTwd || 0), 0);
    const percent = target ? Math.min(100, Math.round(requested / target * 100)) : 0;
    return `<div style="margin-bottom:18px"><div style="display:flex;justify-content:space-between;gap:10px"><strong style="font-size:13px">${escapeHtml(project.displayName)}</strong><span class="mono micro">${percent}%</span></div><div style="height:4px;margin-top:8px;background:var(--line)"><div style="width:${percent}%;height:100%;background:var(--gold-500)"></div></div></div>`;
  }).join('') : '<p class="micro">尚無進度資料。</p>';
}

function renderAll() { renderKpis(); renderActions(); renderMembers(); renderLeads(); renderSubscriptions(); renderReferrals(); renderBookings(); renderProjects(); renderContent(); renderNewsletterPreview(); }

function openMember(id) {
  selectedMember = dashboard.members.find((item) => String(item.id) === String(id));
  if (!selectedMember) return;
  document.querySelector('#member-id').value = selectedMember.id;
  document.querySelector('#member-dialog-summary').innerHTML = `<strong>${escapeHtml(selectedMember.name || selectedMember.displayName)}</strong><br><span class="micro">${escapeHtml(selectedMember.id)}｜${escapeHtml(selectedMember.source || selectedMember.sourceGroup || '來源待確認')}</span>`;
  document.querySelector('#membership-state').value = memberState(selectedMember);
  document.querySelector('#qualification-state').value = qualificationState(selectedMember);
  const approval = selectedMember.qualificationApproval || {};
  document.querySelector('#qualification-approver').value = approval.approver || '';
  document.querySelector('#qualification-approved-at').value = dateTimeInputValue(approval.approvedAt);
  document.querySelector('#qualification-reference').value = approval.reference || '';
  document.querySelector('#qualification-expires-at').value = String(approval.expiresAt || '').slice(0, 10);
  const attribution = referralAttribution(selectedMember);
  const referrerOptions = dashboard.referrers.map((referrer) => `<option value="${escapeHtml(referrer.id)}">${escapeHtml(referrer.displayName || referrer.name)}｜${escapeHtml(referrer.code)}${referrer.status === 'disabled' ? '（已停用）' : ''}</option>`).join('');
  document.querySelector('#member-referrer').innerHTML = `<option value="">尚未歸屬</option>${referrerOptions}`;
  document.querySelector('#member-referrer').value = attribution.referrerId || '';
  document.querySelector('#referral-evidence-reference').value = attribution.evidenceReference || attribution.reference || '';
  document.querySelector('#member-reason').value = '';
  openDialog(memberDialog);
}

function openLead(id = '') {
  selectedLead = id ? dashboard.leads.find((item) => String(item.id) === String(id)) : null;
  document.querySelector('#lead-dialog-title').textContent = selectedLead ? '管理潛在投資人' : '新增潛在投資人';
  document.querySelector('#lead-id').value = selectedLead?.id || '';
  document.querySelector('#lead-name').value = selectedLead?.displayName || selectedLead?.name || '';
  document.querySelector('#lead-contact').value = selectedLead?.contact || selectedLead?.email || selectedLead?.phone || '';
  document.querySelector('#lead-channel').value = selectedLead?.channel || '';
  const source = document.querySelector('#lead-source');
  source.value = selectedLead?.sourceReference || selectedLead?.source || '';
  source.readOnly = Boolean(selectedLead);
  source.setAttribute('aria-readonly', String(Boolean(selectedLead)));
  const evidence = document.querySelector('#lead-source-evidence');
  evidence.value = selectedLead?.privacyEvidence?.reference || selectedLead?.sourceEvidence || '';
  evidence.readOnly = Boolean(selectedLead);
  evidence.setAttribute('aria-readonly', String(Boolean(selectedLead)));
  document.querySelector('#lead-status').value = selectedLead?.status || 'new';
  const owner = document.querySelector('#lead-owner');
  owner.innerHTML = `<option value="">請選擇</option>${dashboard.referrers.filter((item) => item.status !== 'disabled' || item.id === selectedLead?.ownerReferrerId).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.displayName || item.name)}｜${escapeHtml(item.code || item.id)}</option>`).join('')}`;
  owner.value = selectedLead?.ownerReferrerId || selectedLead?.owner || '';
  owner.disabled = Boolean(selectedLead);
  document.querySelector('#lead-member').innerHTML = `<option value="">尚未連結</option>${dashboard.members.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name || item.displayName)}｜${escapeHtml(item.id)}</option>`).join('')}`;
  document.querySelector('#lead-member').value = selectedLead?.memberId || selectedLead?.linkedMemberId || selectedLead?.linkMemberId || '';
  document.querySelector('#lead-reason').value = '';
  const metadata = document.querySelector('#lead-import-metadata');
  metadata.hidden = !selectedLead;
  document.querySelector('#lead-imported-by').textContent = selectedLead?.importedBy || selectedLead?.createdBy || selectedLead?.createdActor || '營運管理員（見稽核事件）';
  document.querySelector('#lead-imported-at').textContent = selectedLead ? `導入時間 ${formatDate(selectedLead.importedAt || selectedLead.createdAt)}` : '建立時由伺服器寫入';
  openDialog(leadDialog);
}

function csvFields(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { values.push(value.trim()); value = ''; }
    else value += character;
  }
  values.push(value.trim());
  return values;
}

function parseLeadCsv(value) {
  const lines = String(value || '').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const first = csvFields(lines[0]);
  const hasHeader = /姓名|name/i.test(first[0] || '') && /聯絡|contact/i.test(first[1] || '');
  return lines.slice(hasHeader ? 1 : 0).map(csvFields).filter((fields) => fields.some(Boolean)).map((fields) => {
    const contact = fields[1] || '';
    return {
      displayName: fields[0] || '', contact, ...(contact.includes('@') ? { email: contact } : { phone: contact }),
      channel: fields[2] || '其他', sourceReference: fields[3] || '',
    };
  }).filter((item) => item.displayName && item.contact && item.sourceReference);
}

function renderLeadImportPreview() {
  const target = document.querySelector('#lead-import-preview');
  const button = document.querySelector('#lead-import-submit');
  button.disabled = leadImportRows.length === 0;
  button.textContent = `匯入 ${leadImportRows.length} 筆`;
  target.innerHTML = leadImportRows.length ? `<div class="import-preview__head"><strong>準備匯入 ${leadImportRows.length} 筆</strong><span>只顯示前 5 筆</span></div><ol>${leadImportRows.slice(0, 5).map((item) => `<li><strong>${escapeHtml(item.displayName)}</strong><span>${escapeHtml(item.contact)}｜${escapeHtml(item.channel)}｜${escapeHtml(item.sourceReference)}</span></li>`).join('')}</ol>` : '<p class="micro">沒有可匯入的完整資料；每列至少需要姓名、聯絡方式與唯一來源參考編號。</p>';
}

function openLeadImport() {
  document.querySelector('#lead-import-form').reset();
  document.querySelector('#lead-import-owner').innerHTML = `<option value="">請選擇</option>${dashboard.referrers.filter((item) => item.status !== 'disabled').map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.displayName || item.name)}｜${escapeHtml(item.code || item.id)}</option>`).join('')}`;
  leadImportRows = [];
  renderLeadImportPreview();
  openDialog(leadImportDialog);
}

function openContent(id = '') {
  selectedContent = id ? dashboard.content.find((item) => String(item.id) === String(id)) : null;
  document.querySelector('#content-dialog-title').textContent = selectedContent ? '編輯內容' : '新增內容';
  document.querySelector('#content-id').value = selectedContent?.id || '';
  document.querySelector('#content-type').value = selectedContent?.type || 'video';
  document.querySelector('#content-status').value = selectedContent?.status || 'draft';
  document.querySelector('#content-title-input').value = selectedContent?.title || '';
  document.querySelector('#content-url').value = selectedContent?.videoUrl || selectedContent?.url || '';
  document.querySelector('#content-project').innerHTML = `<option value="">一般內容</option>${projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.displayName || project.name)}｜${escapeHtml(project.id)}</option>`).join('')}`;
  document.querySelector('#content-project').value = selectedContent?.projectId || '';
  document.querySelector('#content-summary').value = selectedContent?.summary || '';
  document.querySelector('#content-risk').value = selectedContent?.riskNotice || selectedContent?.riskDisclosure || '';
  document.querySelector('#content-public-safe').checked = Boolean(selectedContent?.publicSafe);
  document.querySelector('#content-reason').value = '';
  openDialog(contentDialog);
}

function openSubscription(id) {
  selectedSubscription = dashboard.subscriptions.find((item) => String(item.id) === String(id));
  if (!selectedSubscription) return;
  document.querySelector('#admin-subscription-id').value = selectedSubscription.id;
  document.querySelector('#subscription-admin-summary').innerHTML = `<div class="amount-ledger subscription-summary-ledger"><div class="amount-ledger__item"><span class="amount-ledger__label">會員</span><strong style="display:block;margin-top:8px">${escapeHtml(selectedSubscription.memberName || selectedSubscription.memberId)}</strong></div><div class="amount-ledger__item"><span class="amount-ledger__label">申請金額</span><strong class="amount-ledger__value">${formatMoney(selectedSubscription.requestedAmount ?? selectedSubscription.requestedAmountTwd, true)}</strong></div><div class="amount-ledger__item"><span class="amount-ledger__label">不可變引薦快照</span><strong style="display:block;margin-top:8px">${escapeHtml(snapshotName(selectedSubscription))}</strong><small class="table-note">${escapeHtml(bpsLabel(snapshotRate(selectedSubscription)))}</small></div></div>`;
  const current = subscriptionState(selectedSubscription);
  document.querySelector('#admin-subscription-status').value = current === 'submitted' ? 'operations_confirmed' : current;
  document.querySelector('#admin-approved-amount').value = selectedSubscription.approvedAmount ?? selectedSubscription.approvedAmountTwd ?? 0;
  document.querySelector('#admin-received-amount').value = selectedSubscription.receivedAmount ?? selectedSubscription.receivedAmountTwd ?? 0;
  document.querySelector('#admin-allocated-amount').value = selectedSubscription.allocatedAmount ?? selectedSubscription.allocatedAmountTwd ?? 0;
  document.querySelector('#admin-refunded-amount').value = selectedSubscription.refundedAmount ?? selectedSubscription.refundedAmountTwd ?? 0;
  document.querySelector('#admin-partner-reference').value = selectedSubscription.partnerApproval?.reference || '';
  document.querySelector('#operation-reason').value = '';
  openDialog(subscriptionDialog);
}

function openReferrer(id = '') {
  selectedReferrer = id ? dashboard.referrers.find((item) => String(item.id) === String(id)) : null;
  document.querySelector('#referrer-dialog-title').textContent = selectedReferrer ? '編輯引薦方' : '新增引薦方';
  document.querySelector('#referrer-id').value = selectedReferrer?.id || '';
  document.querySelector('#referrer-name').value = selectedReferrer?.displayName || selectedReferrer?.name || '';
  document.querySelector('#referrer-code').value = selectedReferrer?.code || '';
  document.querySelector('#referrer-legal-name').value = selectedReferrer?.legalName || '';
  document.querySelector('#referrer-contact-name').value = selectedReferrer?.contactName || '';
  document.querySelector('#referrer-contact-email').value = selectedReferrer?.contactEmail || '';
  document.querySelector('#referrer-status').value = selectedReferrer?.status === 'disabled' ? 'disabled' : 'active';
  document.querySelector('#referrer-rate').value = selectedReferrer?.defaultCommissionRateBps ?? selectedReferrer?.defaultRateBps ?? 0;
  document.querySelector('#referrer-effective-date').value = String(selectedReferrer?.effectiveAt || selectedReferrer?.agreementEffectiveDate || new Date().toISOString()).slice(0, 10);
  document.querySelector('#referrer-expires-date').value = String(selectedReferrer?.expiresAt || '').slice(0, 10);
  document.querySelector('#referrer-agreement-reference').value = selectedReferrer?.agreementReference || '';
  document.querySelector('#referrer-reason').value = '';
  openDialog(referrerDialog);
}

function syncCommissionFields() {
  const action = document.querySelector('#commission-action').value;
  document.querySelectorAll('[data-commission-field]').forEach((field) => { field.hidden = field.dataset.commissionField !== action; });
  document.querySelector('#commission-approval-reference').required = action === 'approve';
  document.querySelector('#commission-payout-reference').required = action === 'pay';
  document.querySelector('#commission-void-reason').required = action === 'void';
}

function openCommission(subscriptionId) {
  selectedCommission = commissionRecords().find((item) => String(item.subscriptionId) === String(subscriptionId));
  if (!selectedCommission) return;
  const snapshot = referralSnapshot(selectedCommission);
  document.querySelector('#commission-subscription-id').value = selectedCommission.subscriptionId;
  document.querySelector('#commission-dialog-summary').innerHTML = `<div class="commission-chain" aria-label="分潤計算鏈"><div><span>引薦快照</span><strong>${escapeHtml(snapshotName(selectedCommission))}</strong><small>${escapeHtml(snapshot.referralCode || snapshot.referrerCode || snapshot.code || '—')} · ${escapeHtml(bpsLabel(snapshotRate(selectedCommission)))}</small></div><i aria-hidden="true">→</i><div><span>成交基礎</span><strong>${formatMoney(selectedCommission.commissionBasisAmountTwd, true)}</strong><small>最終分配金額</small></div><i aria-hidden="true">→</i><div><span>系統計提</span><strong>${formatMoney(selectedCommission.commissionAccruedAmountTwd, true)}</strong><small>唯讀，不可改額</small></div></div>`;
  const action = selectedCommission.commissionState === 'approved' ? 'pay' : selectedCommission.commissionState === 'paid' ? 'pay' : selectedCommission.commissionState === 'void' ? 'void' : 'approve';
  document.querySelector('#commission-action').value = action;
  document.querySelector('#commission-action').disabled = ['paid', 'void'].includes(selectedCommission.commissionState);
  document.querySelector('#commission-approval-reference').value = selectedCommission.commissionApproval?.reference || selectedCommission.commissionApproval?.approvalReference || '';
  document.querySelector('#commission-payout-reference').value = selectedCommission.commissionPayment?.reference || selectedCommission.commissionPayment?.payoutReference || '';
  document.querySelector('#commission-void-reason').value = selectedCommission.commissionVoid?.reason || selectedCommission.voidReason || '';
  document.querySelector('#commission-reason').value = '';
  const save = document.querySelector('#commission-form [type="submit"]');
  save.hidden = ['paid', 'void', 'pending', 'not_applicable'].includes(selectedCommission.commissionState);
  syncCommissionFields();
  openDialog(commissionDialog);
}

async function loadDashboard() {
  try {
    const [result, projectResult, bookingResult, leadResult, contentResult, matchResult, newsletterResult] = await Promise.all([
      api.adminDashboard(), api.projects(), api.bookings().catch(() => []), api.adminLeads(), api.adminContent(), api.adminMatches(), api.newsletterPreview(),
    ]);
    dashboard = { ...dashboard, ...(result.data || {}) };
    dashboard.members = Array.isArray(dashboard.members) ? dashboard.members : [];
    dashboard.subscriptions = Array.isArray(dashboard.subscriptions) ? dashboard.subscriptions : [];
    dashboard.referrers = Array.isArray(dashboard.referrers) ? dashboard.referrers : [];
    dashboard.commissions = Array.isArray(dashboard.commissions) ? dashboard.commissions : [];
    dashboard.bookings = Array.isArray(bookingResult) ? bookingResult : bookingResult?.bookings || bookingResult?.items || [];
    dashboard.leads = normalizeList(leadResult.data || leadResult, 'leads');
    dashboard.content = normalizeList(contentResult.data || contentResult, 'content');
    dashboard.matches = normalizeList(matchResult.data || matchResult, 'matches');
    dashboard.actions = Array.isArray(dashboard.actions) ? dashboard.actions : [];
    projects = Array.isArray(projectResult.data) ? projectResult.data : projectResult.data?.projects || [];
    newsletterPreview = newsletterResult.data || newsletterResult || null;
    sourceNotice(result.source, document.querySelector('#admin-source'));
    renderAll();
  } catch (error) {
    if (error.status === 401 || error.status === 403) { window.location.href = appUrl('/'); return; }
    document.querySelector('#kpi-grid').innerHTML = errorState('營運資料暫時無法讀取', '請確認登入狀態後重新載入。', 'admin-retry');
    document.querySelector('#admin-retry')?.addEventListener('click', loadDashboard);
  }
}

async function loadNotifications() {
  const target = document.querySelector('#notification-list');
  target.innerHTML = '<div class="loading-state"><div class="loading-line"></div></div>';
  try {
    const data = await request('/api/admin/notifications');
    const items = Array.isArray(data) ? data : data?.notifications || [];
    target.innerHTML = items.length ? `<div class="record-list">${items.map((item) => `<article class="record-card"><div class="record-card__head"><div><span class="mono micro">${escapeHtml(item.id)}</span><h3>${escapeHtml(item.message || item.eventType)}</h3></div><span class="status" data-status="${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div><div class="record-card__body"><p class="micro">對象：${escapeHtml(item.memberId)}｜範本 v${Number(item.templateVersion || 1)}｜嘗試 ${Number(item.attempts || 0)} 次</p>${['awaiting_confirmation', 'failed'].includes(item.status) ? `<button class="button button--secondary button--small" type="button" data-notification-send="${escapeHtml(item.id)}">確認並重送</button>` : ''}</div></article>`).join('')}</div>` : emptyState('目前沒有 LINE 通知', '狀態變更後，通知會進入這個傳送紀錄。');
  } catch (error) { target.innerHTML = errorState('LINE 通知紀錄無法讀取', error.message, 'notification-retry'); document.querySelector('#notification-retry')?.addEventListener('click', loadNotifications); }
}

async function loadAudits() {
  const target = document.querySelector('#audit-list');
  target.innerHTML = '<div class="loading-state"><div class="loading-line"></div></div>';
  try {
    const data = await request('/api/admin/audits');
    const items = Array.isArray(data) ? data : data?.audits || [];
    target.innerHTML = items.length ? `<ol class="timeline">${items.slice().reverse().slice(0, 20).map((item) => `<li><strong>${escapeHtml(item.action)}</strong><time>${formatDate(item.createdAt)}</time><p>${escapeHtml(item.entityType)} / ${escapeHtml(item.entityId)}｜${escapeHtml(item.reason || '')}</p></li>`).join('')}</ol>` : emptyState('目前沒有稽核事件', '第一筆資料異動後會開始累積。');
  } catch (error) { target.innerHTML = errorState('稽核紀錄無法讀取', error.message); }
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-admin-nav], [data-admin-go]');
  if (nav) { event.preventDefault(); showView(nav.dataset.adminNav || nav.dataset.adminGo); }
  const memberButton = event.target.closest('[data-member-manage]');
  if (memberButton) openMember(memberButton.dataset.memberManage);
  const leadButton = event.target.closest('[data-lead-manage]');
  if (leadButton) openLead(leadButton.dataset.leadManage);
  const contentButton = event.target.closest('[data-content-edit]');
  if (contentButton) openContent(contentButton.dataset.contentEdit);
  const subscriptionButton = event.target.closest('[data-subscription-manage]');
  if (subscriptionButton) openSubscription(subscriptionButton.dataset.subscriptionManage);
  const referrerEdit = event.target.closest('[data-referrer-edit]');
  if (referrerEdit) openReferrer(referrerEdit.dataset.referrerEdit);
  const commissionButton = event.target.closest('[data-commission-manage]');
  if (commissionButton) openCommission(commissionButton.dataset.commissionManage);
  const placeholder = event.target.closest('[data-placeholder-action]');
  if (placeholder) toast(`${placeholder.dataset.placeholderAction}已建立介面入口；正式素材與審核流程接入後啟用。`);
  const notification = event.target.closest('[data-notification-send]');
  if (notification) {
    setButtonBusy(notification, true, '傳送中…');
    try { await request(`/api/admin/notifications/${encodeURIComponent(notification.dataset.notificationSend)}/send`, { method: 'POST' }); toast('LINE 通知已送入傳送佇列。'); loadNotifications(); } catch (error) { toast(`通知未送出：${error.message}`, 'error'); setButtonBusy(notification, false); }
  }
});

document.querySelector('#lead-create').addEventListener('click', () => openLead());
document.querySelector('#lead-import-open').addEventListener('click', openLeadImport);
document.querySelector('#content-create').addEventListener('click', () => openContent());

document.querySelector('#lead-csv-text').addEventListener('input', (event) => {
  leadImportRows = parseLeadCsv(event.currentTarget.value);
  renderLeadImportPreview();
});

document.querySelector('#lead-csv-file').addEventListener('change', async (event) => {
  const [file] = event.currentTarget.files || [];
  if (!file) return;
  try {
    const csv = await file.text();
    document.querySelector('#lead-csv-text').value = csv;
    leadImportRows = parseLeadCsv(csv);
    renderLeadImportPreview();
  } catch (error) { toast(`CSV 無法讀取：${error.message}`, 'error'); }
});

document.querySelector('#lead-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在儲存…');
  try {
    const fields = Object.fromEntries(new FormData(form));
    const projectMember = dashboard.members.find((item) => item.id === fields.linkMemberId);
    const payload = {
      displayName: String(fields.displayName || '').trim(),
      contact: String(fields.contact || '').trim(),
      channel: String(fields.channel || '').trim(),
      status: fields.status,
      linkMemberId: fields.linkMemberId || null,
      reason: String(fields.reason || '').trim(),
    };
    if (payload.contact.includes('@')) payload.email = payload.contact;
    else payload.phone = payload.contact;
    if (!fields.leadId) {
      payload.ownerReferrerId = String(fields.ownerReferrerId || '').trim();
      payload.sourceReference = String(fields.sourceReference || '').trim();
      payload.sourceEvidence = String(fields.sourceEvidence || '').trim();
    }
    if (!payload.reason) throw new Error('請填寫操作理由。');
    if (!fields.leadId && (!payload.ownerReferrerId || !payload.sourceReference || !payload.sourceEvidence)) throw new Error('新增潛客必須填寫負責引薦方、唯一來源參考與證據。');
    const result = fields.leadId ? await api.updateLead(fields.leadId, payload) : await api.createLead(payload);
    const saved = result?.lead || result;
    const normalized = { ...selectedLead, ...saved, linkedMemberName: saved.linkedMemberName || saved.memberName || projectMember?.name || projectMember?.displayName };
    dashboard.leads = fields.leadId ? dashboard.leads.map((item) => item.id === fields.leadId ? normalized : item) : [normalized, ...dashboard.leads];
    renderLeads(); closeDialog(leadDialog);
    toast(fields.leadId ? '潛客資料已更新；原始導入者與來源證據維持不變。' : '潛客已建立並鎖定來源證據。');
  } catch (error) { toast(`潛客未儲存：${error.message}`, 'error'); }
  finally { setButtonBusy(button, false); }
});

document.querySelector('#lead-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在匯入…');
  try {
    const fields = Object.fromEntries(new FormData(form));
    if (!leadImportRows.length) throw new Error('沒有可匯入的完整資料。');
    const payload = { rows: leadImportRows.map((item) => ({ ...item, ownerReferrerId: fields.ownerReferrerId })), sourceEvidence: String(fields.sourceEvidence || '').trim(), reason: String(fields.reason || '').trim() };
    if (!fields.ownerReferrerId || !payload.sourceEvidence || !payload.reason) throw new Error('請選擇負責引薦方，並填寫本批來源證據與匯入理由。');
    const result = await api.importLeads(payload);
    const imported = normalizeList(result?.leads || result?.imported || result, 'leads');
    dashboard.leads = imported.length ? [...imported, ...dashboard.leads] : dashboard.leads;
    renderLeads(); closeDialog(leadImportDialog);
    toast(`已匯入 ${Number(result?.count ?? imported.length ?? leadImportRows.length)} 筆潛客；導入者與來源證據已鎖定。`);
  } catch (error) { toast(`CSV 未匯入：${error.message}`, 'error'); }
  finally { setButtonBusy(button, false); }
});

document.querySelector('#content-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在儲存…');
  try {
    const fields = Object.fromEntries(new FormData(form));
    const project = projects.find((item) => item.id === fields.projectId);
    const payload = {
      type: fields.type,
      title: String(fields.title || '').trim(),
      url: String(fields.url || '').trim(),
      projectId: fields.projectId || null,
      summary: String(fields.summary || '').trim(),
      riskNotice: String(fields.riskNotice || '').trim(),
      status: fields.status,
      publicSafe: fields.publicSafe === 'true',
      reason: String(fields.reason || '').trim(),
    };
    if (!payload.url.startsWith('https://')) throw new Error('內容網址必須使用 HTTPS。');
    if (payload.status === 'published' && !payload.riskNotice) throw new Error('發布前必須填寫風險提示。');
    const result = fields.contentId ? await api.updateContent(fields.contentId, payload) : await api.createContent(payload);
    const saved = { ...selectedContent, ...(result?.content || result), projectName: (result?.content || result)?.projectName || project?.displayName || project?.name || '' };
    dashboard.content = fields.contentId ? dashboard.content.map((item) => item.id === fields.contentId ? saved : item) : [saved, ...dashboard.content];
    renderContent(); closeDialog(contentDialog);
    toast(payload.status === 'published' ? '內容已發布；公開首頁仍只顯示通過公開安全檢核的項目。' : '內容草稿已儲存。');
  } catch (error) { toast(`內容未儲存：${error.message}`, 'error'); }
  finally { setButtonBusy(button, false); }
});

document.querySelector('#member-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在儲存…');
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const payload = {
      membershipState: data.membershipState,
      qualificationState: data.qualificationState,
      reason: data.reason,
    };
    if (data.referrerId && !String(data.referralEvidenceReference || '').trim()) {
      throw new Error('指定引薦方時必須填寫引薦證據參考。');
    }
    payload.referralAttribution = data.referrerId
      ? { referrerId: data.referrerId, evidenceReference: String(data.referralEvidenceReference).trim() }
      : null;
    if (data.qualificationState === 'approved') {
      if (!data.qualificationApprover || !data.qualificationApprovedAt || !data.qualificationReference || !data.qualificationExpiresAt) {
        throw new Error('資格核准必須填寫合作機構核准人、核准時間、參考編號與到期日。');
      }
      const expiresAt = qualificationExpiryIso(data.qualificationExpiresAt);
      if (!expiresAt) throw new Error('資格到期日必須晚於今天。');
      payload.qualificationApproval = {
        approver: data.qualificationApprover,
        approvedAt: new Date(data.qualificationApprovedAt).toISOString(),
        reference: data.qualificationReference,
        expiresAt,
      };
    }
    const result = await api.updateMember(data.memberId, payload);
    const updated = result?.member || result;
    dashboard.members = dashboard.members.map((item) => item.id === data.memberId ? { ...item, ...updated, membership: updated.membershipState || updated.membership } : item);
    renderMembers(); renderKpis(); renderReferrals();
    closeDialog(memberDialog); toast('會員狀態與引薦歸屬已更新；只影響未來認購。');
  } catch (error) { toast(`會員狀態未更新：${error.message}`, 'error'); }
  finally { setButtonBusy(button, false); }
});

document.querySelector('#referrer-create').addEventListener('click', () => openReferrer());

document.querySelector('#referrer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在儲存…');
  try {
    const fields = Object.fromEntries(new FormData(form));
    const code = String(fields.code || '').trim().toUpperCase();
    const duplicate = dashboard.referrers.some((item) => item.id !== fields.referrerId && String(item.code || '').toUpperCase() === code);
    if (duplicate) throw new Error(`引薦碼 ${code} 已存在，請使用不同代碼。`);
    const payload = {
      displayName: String(fields.displayName || '').trim(),
      code,
      legalName: String(fields.legalName || '').trim(),
      contactName: String(fields.contactName || '').trim(),
      contactEmail: String(fields.contactEmail || '').trim().toLowerCase(),
      status: fields.status,
      defaultCommissionRateBps: Number(fields.defaultCommissionRateBps),
      commissionBasis: 'allocated_amount',
      agreementReference: String(fields.agreementReference || '').trim(),
      effectiveAt: new Date(`${fields.effectiveAt}T00:00:00+08:00`).toISOString(),
      expiresAt: fields.expiresAt ? new Date(`${fields.expiresAt}T00:00:00+08:00`).toISOString() : null,
      reason: String(fields.reason || '').trim(),
    };
    const result = fields.referrerId
      ? await api.updateReferrer(fields.referrerId, payload)
      : await api.createReferrer(payload);
    const saved = result?.referrer || result;
    dashboard.referrers = fields.referrerId
      ? dashboard.referrers.map((item) => item.id === fields.referrerId ? { ...item, ...saved } : item)
      : [...dashboard.referrers, saved];
    renderReferrals();
    closeDialog(referrerDialog);
    toast(fields.referrerId ? '引薦方設定已更新；既有認購快照不變。' : '引薦方已建立，可開始歸屬投資人。');
  } catch (error) { toast(`引薦方未儲存：${error.message}`, 'error'); }
  finally { setButtonBusy(button, false); }
});

document.querySelector('#commission-action').addEventListener('change', syncCommissionFields);

document.querySelector('#commission-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在登錄…');
  try {
    const fields = Object.fromEntries(new FormData(form));
    const payload = { action: fields.action, reason: String(fields.reason || '').trim() };
    if (!payload.reason) throw new Error('請填寫操作理由。');
    if (fields.action === 'approve') {
      if (!String(fields.approvalReference || '').trim()) throw new Error('核准分潤必須填寫核准參考編號。');
      payload.approvalReference = String(fields.approvalReference).trim();
    }
    if (fields.action === 'pay') {
      if (!String(fields.payoutReference || '').trim()) throw new Error('登錄付款必須填寫付款參考編號。');
      payload.payoutReference = String(fields.payoutReference).trim();
    }
    if (fields.action === 'void') {
      if (!String(fields.voidReason || '').trim()) throw new Error('作廢分潤必須填寫作廢原因。');
      payload.voidReason = String(fields.voidReason).trim();
    }
    const result = await api.updateCommission(fields.subscriptionId, payload);
    const updatedCommission = result?.commission || result;
    const updatedSubscription = result?.subscription || updatedCommission;
    const currentRecord = commissionRecords().find((item) => item.subscriptionId === fields.subscriptionId) || {};
    const nextCommission = { ...currentRecord, ...updatedCommission, subscriptionId: fields.subscriptionId };
    dashboard.commissions = dashboard.commissions.some((item) => (item.subscriptionId || item.id) === fields.subscriptionId)
      ? dashboard.commissions.map((item) => (item.subscriptionId || item.id) === fields.subscriptionId ? nextCommission : item)
      : [...dashboard.commissions, nextCommission];
    dashboard.subscriptions = dashboard.subscriptions.map((item) => item.id === fields.subscriptionId ? { ...item, ...updatedSubscription } : item);
    renderReferrals(); renderSubscriptions();
    closeDialog(commissionDialog);
    toast(fields.action === 'approve' ? '分潤已核准並保留核准證據。' : fields.action === 'pay' ? '付款參考已登錄。' : '分潤已作廢並保留原因。');
  } catch (error) { toast(`分潤操作未完成：${error.message}`, 'error'); }
  finally { setButtonBusy(button, false); }
});

document.querySelector('#subscription-admin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在儲存…');
  try {
    const fields = Object.fromEntries(new FormData(form));
    const payload = {
      subscriptionStatus: fields.subscriptionStatus,
      approvedAmount: Number(fields.approvedAmount || 0),
      receivedAmount: Number(fields.receivedAmount || 0),
      allocatedAmount: Number(fields.allocatedAmount || 0),
      refundedAmount: Number(fields.refundedAmount || 0),
      reason: fields.reason,
    };
    if (fields.subscriptionStatus === 'approved') {
      payload.partnerApproval = { approver: 'DEMO 持牌合作機構', approvedAt: new Date().toISOString(), reference: fields.partnerReference };
    }
    const updated = await api.updateSubscription(fields.subscriptionId, payload);
    dashboard.subscriptions = dashboard.subscriptions.map((item) => item.id === fields.subscriptionId ? { ...item, ...updated } : item);
    const hasCommission = dashboard.commissions.some((item) => (item.subscriptionId || item.id) === fields.subscriptionId);
    dashboard.commissions = hasCommission
      ? dashboard.commissions.map((item) => (item.subscriptionId || item.id) === fields.subscriptionId
        ? { ...item, ...updated, subscriptionId: fields.subscriptionId }
        : item)
      : updated.referralSnapshot
        ? [...dashboard.commissions, { ...updated, subscriptionId: fields.subscriptionId }]
        : dashboard.commissions;
    renderSubscriptions(); renderReferrals(); renderKpis(); renderActions();
    closeDialog(subscriptionDialog); toast('認購流程已更新，變更前後值已保留。');
  } catch (error) { toast(`認購流程未更新：${error.message}`, 'error'); }
  finally { setButtonBusy(button, false); }
});

['member-search', 'member-filter'].forEach((id) => document.querySelector(`#${id}`).addEventListener('input', renderMembers));
['lead-search', 'lead-filter'].forEach((id) => document.querySelector(`#${id}`).addEventListener('input', renderLeads));
['subscription-search', 'subscription-filter'].forEach((id) => document.querySelector(`#${id}`).addEventListener('input', renderSubscriptions));
document.querySelector('#commission-filter').addEventListener('input', () => renderCommissionRows(commissionRecords()));
document.querySelector('#content-filter').addEventListener('input', renderContent);
document.querySelector('#newsletter-refresh').addEventListener('click', async (event) => {
  setButtonBusy(event.currentTarget, true, '讀取中…');
  try {
    const result = await api.newsletterPreview();
    newsletterPreview = result.data || result;
    renderNewsletterPreview();
  } catch (error) { toast(`摘要預覽無法讀取：${error.message}`, 'error'); }
  finally { setButtonBusy(event.currentTarget, false); }
});
document.querySelector('#newsletter-generate').addEventListener('click', async (event) => {
  setButtonBusy(event.currentTarget, true, '產生中…');
  try {
    const result = await api.generateNewsletter({ date: new Date().toISOString().slice(0, 10), send: false, reason: '營運人工確認產生每日摘要，不啟動外部傳送' });
    newsletterPreview = result?.preview || result?.newsletter || result?.generated || result;
    renderNewsletterPreview();
    toast('今日摘要已產生；產生不等於外部傳送，仍依會員同意與管道可用性決定。');
  } catch (error) { toast(`摘要未產生：${error.message}`, 'error'); }
  finally { setButtonBusy(event.currentTarget, false); }
});
document.querySelector('#notification-refresh').addEventListener('click', loadNotifications);
document.querySelector('#audit-refresh').addEventListener('click', loadAudits);
window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));

function renderAdminUnavailable(message) {
  document.querySelector('.admin-sidebar')?.setAttribute('hidden', '');
  document.querySelector('.mobile-admin-bar')?.setAttribute('hidden', '');
  const main = document.querySelector('#admin-main');
  if (main) main.innerHTML = `<section class="panel" data-testid="admin-unavailable"><div class="panel__body">${errorState('正式營運後台未開放', message)}</div></section>`;
}

async function initializeAdmin() {
  initShell();
  if (api.hasLiveApi()) {
    let config;
    try {
      config = await api.detectConfig();
    } catch {
      renderAdminUnavailable('無法驗證正式營運後台設定，請聯絡系統管理員。');
      return;
    }
    const route = resolveAdminDashboardRoute(config, true);
    if (route.mode !== 'redirect') {
      renderAdminUnavailable('正式 API 尚未提供 adminDashboardUrl；為保護會員與認購資料，本頁不會載入 Demo 後台。');
      return;
    }
    if (route.url === window.location.href) {
      renderAdminUnavailable('營運後台網址不可指回目前頁面，請聯絡系統管理員修正設定。');
      return;
    }
    window.location.replace(route.url);
    return;
  }
  showView(location.hash.slice(1) || 'overview', false);
  loadDashboard();
}

initializeAdmin();
