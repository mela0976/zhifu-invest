import { api, appUrl } from './api.js';
import { emptyState, errorState, escapeHtml, formatDate, formatMoney, initShell, openDialog, closeDialog, setButtonBusy, sourceNotice, toast } from './common.js';
import { statusLabels } from './demo-data.js';
import { protectedProjectContent } from './project-content.js';

let member = {};
let projects = [];
let subscriptions = [];
let bookings = [];
let selectedProject = null;
let submissionKey = null;
let activeProjectFilter = 'all';

const detailDialog = document.querySelector('#project-detail-dialog');
const subscriptionDialog = document.querySelector('#subscription-dialog');

const statusLabel = (value) => statusLabels[value] || value || '待確認';
const normalizeList = (value, key) => Array.isArray(value) ? value : value?.[key] || value?.items || [];

function showView(view, updateHash = true) {
  const valid = ['home', 'projects', 'investments', 'more'];
  const next = valid.includes(view) ? view : 'home';
  document.querySelectorAll('[data-member-view]').forEach((section) => { section.hidden = section.dataset.memberView !== next; });
  document.querySelectorAll('[data-nav-view]').forEach((link) => {
    if (link.dataset.navView === next) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (updateHash) history.replaceState(null, '', `#${next}`);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function projectCard(project, compact = false) {
  return `<article class="project-card" ${compact ? '' : 'data-testid="project-card"'} data-industry="${escapeHtml(project.industry)}">
    <div class="project-card__rail"></div><div class="project-card__head"><span class="project-card__code">${escapeHtml(project.code || project.id)}</span><span class="status">${escapeHtml(project.status || '研究中')}</span></div>
    <div class="project-card__body"><h3>${escapeHtml(project.displayName || project.name)}</h3><p>${escapeHtml(project.summary)}</p>${compact ? '' : `<ul class="project-card__meta"><li><span>目標</span><strong>${formatMoney(project.targetAmount, true)}</strong></li><li><span>最低</span><strong>${formatMoney(project.minimumAmount, true)}</strong></li><li><span>階段</span><strong>${escapeHtml(project.stage)}</strong></li><li><span>截止</span><strong>${formatDate(project.closingDate)}</strong></li></ul>`}</div>
    <div class="project-card__foot"><span class="micro">逐案授權</span><button class="button button--quiet button--small project-card__link" type="button" data-member-project-open="${escapeHtml(project.id)}">查看資料</button></div>
  </article>`;
}

function amountLedger(subscription) {
  const items = [
    ['申請金額', subscription.requestedAmount], ['核准金額', subscription.approvedAmount],
    ['實際入金', subscription.receivedAmount], ['最終分配', subscription.allocatedAmount], ['退款金額', subscription.refundedAmount],
  ];
  return `<div class="amount-ledger">${items.map(([label, value], index) => `<div class="amount-ledger__item ${value > 0 && index > 0 ? 'is-current' : ''}"><span class="amount-ledger__label">${label}</span><strong class="amount-ledger__value">${formatMoney(value, true)}</strong></div>`).join('')}</div>`;
}

function timeline(items = []) {
  return items.length ? `<ol class="timeline">${items.map((item) => `<li><strong>${escapeHtml(item.label)}</strong><time>${formatDate(item.date)}</time><p>${escapeHtml(item.detail || '')}</p></li>`).join('')}</ol>` : '<p class="micro">送出後，狀態異動會依序顯示在這裡。</p>';
}

function subscriptionRecord(item, expanded = true) {
  return `<article class="record-card" data-testid="member-private-record" data-record-id="${escapeHtml(item.id)}">
    <div class="record-card__head"><div><span class="mono micro">${escapeHtml(item.id)}</span><h3>${escapeHtml(item.projectName || item.project?.displayName || item.projectId)}</h3></div><span class="status" data-status="${escapeHtml(item.subscriptionStatus)}">${escapeHtml(statusLabel(item.subscriptionStatus))}</span></div>
    <div class="record-card__body">${amountLedger(item)}${expanded ? `<div style="margin-top:24px"><h3>處理時間軸</h3>${timeline(item.timeline)}</div>` : ''}</div>
  </article>`;
}

function reportRegister(reports) {
  if (!reports.length) return '<p class="micro">目前沒有已核准發布的 AI 或專家報告。</p>';
  return `<div class="record-list">${reports.map((report) => `<article class="record-card" data-testid="approved-report" data-report-type="${escapeHtml(report.type)}"><div class="record-card__head"><div><span class="mono micro">${escapeHtml(report.id || 'REPORT')}</span><h3>${report.type === 'ai' ? 'AI 增強報告' : '專家審閱報告'}</h3></div><span class="status status--success">已核准</span></div><div class="record-card__body qualification"><dl><dt>版本</dt><dd class="mono">v${escapeHtml(report.version)}</dd><dt>資料基準日</dt><dd>${formatDate(report.basisDate)}</dd><dt>審閱者</dt><dd>${escapeHtml(report.reviewedBy || '尚未登錄')}</dd></dl></div></article>`).join('')}</div>`;
}

function renderIdentity() {
  const identity = document.querySelector('#member-identity');
  const qualification = member.qualification || {};
  const name = member.name || member.displayName || '會員';
  const id = member.id || member.memberId || 'M-——';
  identity.dataset.memberId = id;
  identity.innerHTML = `<div class="identity-card__top"><span class="mono micro" style="color:#c4cdd3">MEMBER CREDENTIAL</span><span class="status status--success">${member.lineFriend === false ? 'LINE 未加好友' : 'LINE 已連結'}</span></div><h2>${escapeHtml(name)}</h2><p>${escapeHtml(member.source || '社群來源待確認')}</p><div class="identity-card__meta"><div><span>會員方案</span><strong>${escapeHtml(member.tier || '一般會員')}</strong></div><div><span>會員編號</span><strong class="mono">${escapeHtml(id)}</strong></div></div>`;
  document.querySelector('#header-name').textContent = name;
  document.querySelector('#header-initial').textContent = name.slice(0, 1);
  document.querySelector('#settings-name').textContent = name;
  document.querySelector('#settings-phone').textContent = member.maskedPhone || member.phone || '手機號碼已遮罩';
  document.querySelector('#tier-status').textContent = member.tier || '一般會員';
  qualification && (document.querySelector('#qualification').innerHTML = `<div class="qualification__head"><h3>合格投資人資格</h3><span class="status" data-status="${escapeHtml(qualification.status)}">${escapeHtml(qualification.label || statusLabel(qualification.status))}</span></div><dl><dt>審核機構</dt><dd>${escapeHtml(qualification.organization || '待確認')}</dd><dt>核准日期</dt><dd>${formatDate(qualification.approvedAt)}</dd><dt>有效期限</dt><dd>${formatDate(qualification.expiresAt)}</dd><dt>參考編號</dt><dd class="mono">${escapeHtml(qualification.reference || '尚未登錄')}</dd></dl>`);
}

function renderProjects() {
  const shown = activeProjectFilter === 'all' ? projects : projects.filter((project) => project.industry === activeProjectFilter);
  const grid = document.querySelector('#member-project-grid');
  grid.innerHTML = shown.length ? shown.map((project) => projectCard(project)).join('') : emptyState('沒有符合的專案', '切換其他產業或等待新的逐案授權。');
  document.querySelector('#home-projects').innerHTML = projects.length ? projects.slice(0, 2).map((project) => projectCard(project, true)).join('') : emptyState('尚未開放專案', '資格通過後，獲准查看的研究會出現在這裡。');
  const industries = [...new Set(projects.map((project) => project.industry).filter(Boolean))];
  document.querySelector('#member-project-filters').innerHTML = `<button class="filter-chip" type="button" aria-pressed="${activeProjectFilter === 'all'}" data-filter="all">全部</button>${industries.map((industry) => `<button class="filter-chip" type="button" aria-pressed="${activeProjectFilter === industry}" data-filter="${escapeHtml(industry)}">${escapeHtml(industry)}</button>`).join('')}`;
}

function renderSubscriptions() {
  const list = document.querySelector('#subscription-list');
  list.innerHTML = subscriptions.length ? subscriptions.map((item) => subscriptionRecord(item)).join('') : emptyState('還沒有認購紀錄', '從已授權的募資研究提出認購意向後，五種金額與時間軸會顯示在這裡。', '<button class="button" type="button" data-go-view="projects">瀏覽募資研究</button>');
  document.querySelector('#home-subscription').innerHTML = subscriptions.length ? subscriptionRecord(subscriptions[0], false) : emptyState('沒有待處理認購', '你可以先瀏覽已獲授權的募資研究。');
  const totals = subscriptions.reduce((sum, item) => ({
    requestedAmount: sum.requestedAmount + Number(item.requestedAmount || 0),
    approvedAmount: sum.approvedAmount + Number(item.approvedAmount || 0),
    receivedAmount: sum.receivedAmount + Number(item.receivedAmount || 0),
    allocatedAmount: sum.allocatedAmount + Number(item.allocatedAmount || 0),
    refundedAmount: sum.refundedAmount + Number(item.refundedAmount || 0),
  }), { requestedAmount: 0, approvedAmount: 0, receivedAmount: 0, allocatedAmount: 0, refundedAmount: 0 });
  document.querySelector('#portfolio-totals').innerHTML = [
    ['申請總額', totals.requestedAmount], ['核准總額', totals.approvedAmount], ['實際入金', totals.receivedAmount], ['最終分配', totals.allocatedAmount], ['退款總額', totals.refundedAmount],
  ].map(([label, value]) => `<div class="amount-ledger__item"><span class="amount-ledger__label">${label}</span><strong class="amount-ledger__value">${formatMoney(value, true)}</strong></div>`).join('');
}

function renderBookings() {
  const target = document.querySelector('#member-booking-list');
  if (!target) return;
  target.innerHTML = bookings.length ? `<div class="record-list">${bookings.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map((item) => `<article class="record-card" data-testid="member-booking"><div class="record-card__head"><div><span class="mono micro">${escapeHtml(item.id)}</span><h3>${escapeHtml(item.topic || item.advisorType || '顧問預約')}</h3></div><span class="status" data-status="${escapeHtml(item.status || 'requested')}">${escapeHtml(statusLabel(item.status || 'requested'))}</span></div><div class="record-card__body"><p class="micro">偏好日期：${formatDate(item.preferredDate)}｜${escapeHtml(item.preferredTime || '時段待確認')}</p>${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ''}</div></article>`).join('')}</div>` : emptyState('目前沒有預約', '從首頁提出顧問預約後，進度會顯示在這裡。');
}

async function loadBookings() {
  const target = document.querySelector('#member-booking-list');
  if (!target) return;
  try {
    const result = await api.bookings();
    bookings = normalizeList(result, 'bookings');
    renderBookings();
  } catch (error) {
    target.innerHTML = errorState('目前無法讀取預約', '預約資料未納入本頁載入條件；其他會員資料不受影響。', 'booking-retry');
    document.querySelector('#booking-retry')?.addEventListener('click', loadBookings);
  }
}

function openProject(id) {
  selectedProject = projects.find((item) => String(item.id) === String(id));
  if (!selectedProject) return;
  document.querySelector('#member-project-dialog-title').textContent = selectedProject.displayName || selectedProject.name;
  const progress = selectedProject.targetAmount ? Math.min(100, Math.round(Number(selectedProject.committedAmount || 0) / Number(selectedProject.targetAmount) * 100)) : 0;
  const content = protectedProjectContent(selectedProject);
  const demoLabel = selectedProject.demo || api.isDemo() ? 'DEMO｜' : '';
  document.querySelector('#member-project-dialog-body').innerHTML = `<span class="status status--success">已授權閱覽</span><p class="lede" style="margin-top:18px;font-size:17px">${escapeHtml(selectedProject.summary)}</p><div class="amount-ledger" style="grid-template-columns:1fr 1fr 1fr"><div class="amount-ledger__item"><span class="amount-ledger__label">目標金額</span><strong class="amount-ledger__value">${formatMoney(selectedProject.targetAmount, true)}</strong></div><div class="amount-ledger__item"><span class="amount-ledger__label">目前進度</span><strong class="amount-ledger__value">${progress}%</strong></div><div class="amount-ledger__item"><span class="amount-ledger__label">最低認購</span><strong class="amount-ledger__value">${formatMoney(selectedProject.minimumAmount, true)}</strong></div></div><section class="qualification" style="margin-top:24px" data-testid="protected-company"><div class="qualification__head"><h3>企業與募資資料</h3><span class="status">${escapeHtml(content.round || '輪次待確認')}</span></div><dl><dt>公司</dt><dd>${escapeHtml(content.companyName || '待核准揭露')}</dd><dt>團隊摘要</dt><dd>${escapeHtml(content.teamSummary || '待核准揭露')}</dd><dt>財務摘要</dt><dd>${escapeHtml(content.financialSummary || '待核准揭露')}</dd><dt>估值註記</dt><dd>${escapeHtml(content.valuationNote || '以合作方正式文件為準')}</dd></dl>${content.useOfFunds.length ? `<h3 style="margin-top:20px">資金用途</h3><ul>${content.useOfFunds.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}</section><h3 style="margin-top:24px">已核准報告</h3>${reportRegister(content.reports)}<h3 style="margin-top:24px">主要風險</h3><p class="micro">${escapeHtml(selectedProject.risk || '未上市投資可能損失全部本金，且流動性有限。')}</p><div class="notice" style="margin:20px 0 0">${demoLabel}AI 與專家報告分開標示；只顯示已核准版本，並保留審閱者與資料基準日。</div>`;
  openDialog(detailDialog);
}

function openSubscription() {
  if (!selectedProject) return;
  closeDialog(detailDialog);
  submissionKey = crypto.randomUUID();
  document.querySelector('#subscription-project').value = selectedProject.displayName || selectedProject.name;
  document.querySelector('#subscription-project-id').value = selectedProject.id;
  const amount = document.querySelector('#subscription-amount');
  amount.min = selectedProject.minimumAmount || 100000;
  amount.step = selectedProject.stepAmount || 100000;
  amount.value = selectedProject.minimumAmount || 100000;
  document.querySelector('#subscription-rule').textContent = `最低 ${formatMoney(amount.min)}，每次增加 ${formatMoney(amount.step)}。`;
  document.querySelector('#subscription-result').innerHTML = '';
  openDialog(subscriptionDialog);
  amount.focus();
}

async function openDeck() {
  if (!selectedProject) return;
  const button = document.querySelector('[data-deck-open]');
  setButtonBusy(button, true, '正在取得授權…');
  try {
    const result = await api.deckToken(selectedProject.id);
    const path = result?.url || result?.downloadUrl || (result?.token ? `/api/decks/${encodeURIComponent(result.token)}` : '');
    if (!path) throw new Error('文件授權回應缺少下載位置');
    window.open(api.apiUrl(path), '_blank', 'noopener');
    toast('已建立短效文件授權，下載行為已記錄。');
  } catch (error) {
    toast(`文件尚未開放：${error.message}`, 'error');
  } finally { setButtonBusy(button, false); }
}

async function loadDashboard() {
  try {
    const result = await api.dashboard();
    const data = result.data || {};
    const rawMember = data.member || data.user || {};
    member = {
      ...rawMember,
      name: rawMember.name || rawMember.displayName,
      maskedPhone: rawMember.maskedPhone || rawMember.phoneMasked,
      source: rawMember.source || rawMember.sourceGroup,
      lineFriend: rawMember.lineFriend ?? rawMember.lineFriendshipState === 'friend',
      qualification: typeof rawMember.qualification === 'object' ? rawMember.qualification : {
        status: rawMember.qualificationState || rawMember.qualification,
        label: statusLabel(rawMember.qualificationState || rawMember.qualification),
        organization: rawMember.qualificationApproval?.approver,
        approvedAt: rawMember.qualificationApproval?.approvedAt,
        expiresAt: rawMember.qualificationApproval?.expiresAt,
        reference: rawMember.qualificationApproval?.reference,
      },
    };
    projects = normalizeList(data.projects, 'projects').filter((project) => project.access === 'qualified' || project.protected).map((project) => ({
      ...project,
      targetAmount: project.targetAmount ?? project.protected?.targetAmountTwd,
      minimumAmount: project.minimumAmount ?? project.protected?.minimumAmountTwd,
      stepAmount: project.stepAmount ?? project.protected?.incrementAmountTwd,
      closingDate: project.closingDate ?? project.protected?.deadline,
      risk: project.risk ?? project.protected?.risks?.join('；'),
    }));
    subscriptions = normalizeList(data.subscriptions, 'subscriptions').map((item) => ({
      ...item,
      subscriptionStatus: item.subscriptionStatus || item.subscriptionState,
      fundingStatus: item.fundingStatus || item.fundingState,
      allocationStatus: item.allocationStatus || item.allocationState,
      requestedAmount: item.requestedAmount ?? item.requestedAmountTwd,
      approvedAmount: item.approvedAmount ?? item.approvedAmountTwd,
      receivedAmount: item.receivedAmount ?? item.receivedAmountTwd,
      allocatedAmount: item.allocatedAmount ?? item.allocatedAmountTwd,
      refundedAmount: item.refundedAmount ?? item.refundedAmountTwd,
      timeline: Array.isArray(item.timeline) ? item.timeline : [],
    }));
    sourceNotice(result.source, document.querySelector('#member-source'));
    renderIdentity(); renderProjects(); renderSubscriptions();
    loadBookings();
  } catch (error) {
    if (error.status === 401) { window.location.href = appUrl('/activate.html'); return; }
    document.querySelector('#home-subscription').innerHTML = errorState('無法讀取會員紀錄', '請重新登入或稍後再試。', 'member-retry');
    document.querySelector('#member-retry')?.addEventListener('click', loadDashboard);
  }
}

document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-nav-view], [data-go-view]');
  if (nav) { event.preventDefault(); showView(nav.dataset.navView || nav.dataset.goView); }
  const open = event.target.closest('[data-member-project-open]');
  if (open) openProject(open.dataset.memberProjectOpen);
  if (event.target.closest('[data-subscription-open]')) openSubscription();
  if (event.target.closest('[data-deck-open]')) openDeck();
});

document.querySelector('#member-project-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-filter]');
  if (!chip) return;
  activeProjectFilter = chip.dataset.filter;
  renderProjects();
});

document.querySelector('#subscription-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const amountInput = document.querySelector('#subscription-amount');
  const requestedAmount = Number(amountInput.value);
  const minimum = Number(amountInput.min);
  const step = Number(amountInput.step);
  if (requestedAmount < minimum || (requestedAmount - minimum) % step !== 0) {
    amountInput.setAttribute('aria-invalid', 'true');
    document.querySelector('#subscription-result').innerHTML = `<p class="field__error">金額須至少為 ${formatMoney(minimum)}，並以 ${formatMoney(step)} 為增加級距。</p>`;
    return;
  }
  amountInput.removeAttribute('aria-invalid');
  setButtonBusy(button, true, '正在送出…');
  try {
    const created = await api.createSubscription({ projectId: selectedProject.id, requestedAmountTwd: requestedAmount, riskAcknowledged: true }, submissionKey);
    document.querySelector('#subscription-result').innerHTML = '<div class="notice" style="margin-top:18px"><strong>認購意向已送出</strong>｜目前狀態：待雪芬姐確認</div>';
    toast('認購意向已送出；這不是付款或契約。');
    const newRecord = created?.subscription || created;
    if (newRecord?.id) subscriptionDialog.dataset.createdRecordId = newRecord.id;
  } catch (error) {
    document.querySelector('#subscription-result').innerHTML = `<p class="field__error">未送出：${escapeHtml(error.message)}</p>`;
  } finally { setButtonBusy(button, false); }
});

window.addEventListener('hashchange', () => showView(location.hash.slice(1), false));
initShell();
showView(location.hash.slice(1) || 'home', false);
loadDashboard();
