import { api, appUrl, request } from './api.js';
import { emptyState, errorState, escapeHtml, formatDate, formatMoney, initShell, openDialog, closeDialog, setButtonBusy, sourceNotice, toast } from './common.js';
import { statusLabels } from './demo-data.js';

let dashboard = { kpis: {}, members: [], subscriptions: [], actions: [] };
let projects = [];
let selectedSubscription = null;
let selectedMember = null;
let activeView = 'overview';

const statusLabel = (value) => statusLabels[value] || value || '待確認';
const memberDialog = document.querySelector('#member-dialog');
const subscriptionDialog = document.querySelector('#subscription-admin-dialog');

function showView(view, updateHash = true) {
  const next = ['overview', 'members', 'subscriptions', 'projects', 'content', 'notifications', 'audit'].includes(view) ? view : 'overview';
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

function memberRows(items) {
  const desktop = `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>會員</th><th>來源</th><th>會員狀態</th><th>投資資格</th><th>LINE</th><th>申請總額</th><th>實際入金</th><th>操作</th></tr></thead><tbody>${items.map((item) => `<tr><td class="data-table__primary"><strong>${escapeHtml(item.name || item.displayName)}</strong><small>${escapeHtml(item.id)}</small></td><td>${escapeHtml(item.source || item.sourceGroup || '—')}</td><td><span class="status" data-status="${escapeHtml(memberState(item))}">${escapeHtml(statusLabel(memberState(item)))}</span></td><td><span class="status" data-status="${escapeHtml(qualificationState(item))}">${escapeHtml(statusLabel(qualificationState(item)))}</span></td><td>${item.lineFriend || item.lineFriendshipState === 'friend' ? '已加好友' : '待確認'}</td><td class="data-table__money">${formatMoney(item.requested, true)}</td><td class="data-table__money">${formatMoney(item.received, true)}</td><td><button class="button button--secondary button--small" type="button" data-member-manage="${escapeHtml(item.id)}">確認／管理</button></td></tr>`).join('')}</tbody></table></div>`;
  const mobile = `<div class="mobile-records">${items.map((item) => `<article class="mobile-record"><div class="mobile-record__top"><div><strong>${escapeHtml(item.name || item.displayName)}</strong><div class="mono micro">${escapeHtml(item.id)}</div></div><span class="status" data-status="${escapeHtml(memberState(item))}">${escapeHtml(statusLabel(memberState(item)))}</span></div><div class="mobile-record__meta"><div><span>資格</span><strong>${escapeHtml(statusLabel(qualificationState(item)))}</strong></div><div><span>申請總額</span><strong>${formatMoney(item.requested, true)}</strong></div></div><button class="button button--secondary button--small button--wide" type="button" data-member-manage="${escapeHtml(item.id)}">確認／管理</button></article>`).join('')}</div>`;
  return desktop + mobile;
}

function subscriptionState(item) { return item.subscriptionStatus || item.subscriptionState || 'submitted'; }
function fundingState(item) { return item.fundingStatus || item.fundingState || 'unpaid'; }

function subscriptionRows(items, compact = false) {
  const rows = items.map((item) => `<tr data-testid="subscription-row" data-subscription-id="${escapeHtml(item.id)}"><td class="data-table__primary"><strong>${escapeHtml(item.memberName || item.memberId)}</strong><small>${escapeHtml(item.memberId)}</small></td><td class="data-table__primary"><strong>${escapeHtml(item.projectName || item.projectId)}</strong><small>${escapeHtml(item.id)}</small></td><td class="data-table__money">${formatMoney(item.requestedAmount ?? item.requestedAmountTwd)}</td><td class="data-table__money">${formatMoney(item.approvedAmount ?? item.approvedAmountTwd)}</td><td class="data-table__money">${formatMoney(item.receivedAmount ?? item.receivedAmountTwd)}</td><td><span class="status" data-status="${escapeHtml(subscriptionState(item))}">${escapeHtml(statusLabel(subscriptionState(item)))}</span></td><td><span class="status" data-status="${escapeHtml(fundingState(item))}">${escapeHtml(statusLabel(fundingState(item)))}</span></td><td><button class="button button--secondary button--small" type="button" data-subscription-manage="${escapeHtml(item.id)}" data-testid="subscription-confirm">${subscriptionState(item) === 'submitted' ? '營運確認' : '管理紀錄'}</button></td></tr>`).join('');
  const desktop = `<div class="data-table-wrap"><table class="data-table"><thead><tr><th>會員</th><th>專案／案號</th><th>申請</th><th>核准</th><th>入金</th><th>認購狀態</th><th>入金狀態</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const mobile = `<div class="mobile-records">${items.map((item) => `<article class="mobile-record" data-testid="subscription-row" data-subscription-id="${escapeHtml(item.id)}"><div class="mobile-record__top"><div><strong>${escapeHtml(item.memberName || item.memberId)}</strong><div class="mono micro">${escapeHtml(item.id)}</div></div><span class="status" data-status="${escapeHtml(subscriptionState(item))}">${escapeHtml(statusLabel(subscriptionState(item)))}</span></div><p class="micro">${escapeHtml(item.projectName || item.projectId)}</p><div class="mobile-record__meta"><div><span>申請</span><strong>${formatMoney(item.requestedAmount ?? item.requestedAmountTwd, true)}</strong></div><div><span>實際入金</span><strong>${formatMoney(item.receivedAmount ?? item.receivedAmountTwd, true)}</strong></div></div><button class="button button--secondary button--small button--wide" type="button" data-subscription-manage="${escapeHtml(item.id)}" data-testid="subscription-confirm">${subscriptionState(item) === 'submitted' ? '營運確認' : '管理紀錄'}</button></article>`).join('')}</div>`;
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

function renderAll() { renderKpis(); renderActions(); renderMembers(); renderSubscriptions(); renderProjects(); }

function openMember(id) {
  selectedMember = dashboard.members.find((item) => String(item.id) === String(id));
  if (!selectedMember) return;
  document.querySelector('#member-id').value = selectedMember.id;
  document.querySelector('#member-dialog-summary').innerHTML = `<strong>${escapeHtml(selectedMember.name || selectedMember.displayName)}</strong><br><span class="micro">${escapeHtml(selectedMember.id)}｜${escapeHtml(selectedMember.source || selectedMember.sourceGroup || '來源待確認')}</span>`;
  document.querySelector('#membership-state').value = memberState(selectedMember);
  document.querySelector('#member-reason').value = '';
  openDialog(memberDialog);
}

function openSubscription(id) {
  selectedSubscription = dashboard.subscriptions.find((item) => String(item.id) === String(id));
  if (!selectedSubscription) return;
  document.querySelector('#admin-subscription-id').value = selectedSubscription.id;
  document.querySelector('#subscription-admin-summary').innerHTML = `<div class="amount-ledger" style="grid-template-columns:1fr 1fr"><div class="amount-ledger__item"><span class="amount-ledger__label">會員</span><strong style="display:block;margin-top:8px">${escapeHtml(selectedSubscription.memberName || selectedSubscription.memberId)}</strong></div><div class="amount-ledger__item"><span class="amount-ledger__label">申請金額</span><strong class="amount-ledger__value">${formatMoney(selectedSubscription.requestedAmount ?? selectedSubscription.requestedAmountTwd, true)}</strong></div></div>`;
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

async function loadDashboard() {
  try {
    const [result, projectResult] = await Promise.all([api.adminDashboard(), api.projects()]);
    dashboard = { ...dashboard, ...(result.data || {}) };
    dashboard.members = Array.isArray(dashboard.members) ? dashboard.members : [];
    dashboard.subscriptions = Array.isArray(dashboard.subscriptions) ? dashboard.subscriptions : [];
    dashboard.actions = Array.isArray(dashboard.actions) ? dashboard.actions : [];
    projects = Array.isArray(projectResult.data) ? projectResult.data : projectResult.data?.projects || [];
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
  const subscriptionButton = event.target.closest('[data-subscription-manage]');
  if (subscriptionButton) openSubscription(subscriptionButton.dataset.subscriptionManage);
  const placeholder = event.target.closest('[data-placeholder-action]');
  if (placeholder) toast(`${placeholder.dataset.placeholderAction}已建立介面入口；正式素材與審核流程接入後啟用。`);
  const notification = event.target.closest('[data-notification-send]');
  if (notification) {
    setButtonBusy(notification, true, '傳送中…');
    try { await request(`/api/admin/notifications/${encodeURIComponent(notification.dataset.notificationSend)}/send`, { method: 'POST' }); toast('LINE 通知已送入傳送佇列。'); loadNotifications(); } catch (error) { toast(`通知未送出：${error.message}`, 'error'); setButtonBusy(notification, false); }
  }
});

document.querySelector('#member-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在儲存…');
  try {
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const updated = await api.updateMember(data.memberId, { membershipState: data.membershipState, reason: data.reason });
    dashboard.members = dashboard.members.map((item) => item.id === data.memberId ? { ...item, ...updated, membership: updated.membershipState } : item);
    renderMembers(); renderKpis();
    closeDialog(memberDialog); toast('會員狀態已更新並寫入稽核紀錄。');
  } catch (error) { toast(`會員狀態未更新：${error.message}`, 'error'); }
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
    renderSubscriptions(); renderKpis(); renderActions();
    closeDialog(subscriptionDialog); toast('認購流程已更新，變更前後值已保留。');
  } catch (error) { toast(`認購流程未更新：${error.message}`, 'error'); }
  finally { setButtonBusy(button, false); }
});

['member-search', 'member-filter'].forEach((id) => document.querySelector(`#${id}`).addEventListener('input', renderMembers));
['subscription-search', 'subscription-filter'].forEach((id) => document.querySelector(`#${id}`).addEventListener('input', renderSubscriptions));
document.querySelector('#notification-refresh').addEventListener('click', loadNotifications);
document.querySelector('#audit-refresh').addEventListener('click', loadAudits);
window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));

initShell();
showView(location.hash.slice(1) || 'overview', false);
loadDashboard();
