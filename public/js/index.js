import { api } from './api.js';
import { emptyState, errorState, escapeHtml, formatMoney, initShell, openDialog, setButtonBusy, sourceNotice, toast } from './common.js';

const grid = document.querySelector('#project-grid');
const filters = document.querySelector('#project-filters');
const projectDialog = document.querySelector('#project-dialog');
const dialogTitle = document.querySelector('#project-dialog-title');
const dialogBody = document.querySelector('#project-dialog-body');
let projects = [];
let activeFilter = 'all';

function normalizeProjects(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.projects || payload?.items || [];
}

function projectCard(project) {
  const id = escapeHtml(project.id || project.code);
  return `<article class="project-card" data-industry="${escapeHtml(project.industry)}" data-testid="project-card">
    <div class="project-card__rail"></div>
    <div class="project-card__head"><span class="project-card__code">${escapeHtml(project.code || project.id)}</span><span class="status">${escapeHtml(project.status || '研究中')}</span></div>
    <div class="project-card__body">
      <h3>${escapeHtml(project.displayName || project.name)}</h3>
      <p>${escapeHtml(project.summary || '專案摘要整理中。')}</p>
      <ul class="project-card__meta">
        <li><span>Industry</span><strong>${escapeHtml(project.industry || '待分類')}</strong></li>
        <li><span>Stage</span><strong>${escapeHtml(project.stage || '待確認')}</strong></li>
        <li><span>Region</span><strong>${escapeHtml(project.region || '台灣')}</strong></li>
        <li><span>Access</span><strong>${project.visibility === 'member' ? '正式會員' : '逐案授權'}</strong></li>
      </ul>
    </div>
    <div class="project-card__foot"><span class="micro">公開匿名摘要</span><button class="button button--quiet button--small project-card__link" type="button" data-project-open="${id}">查看研究摘要</button></div>
  </article>`;
}

function renderProjects() {
  const shown = activeFilter === 'all' ? projects : projects.filter((project) => project.industry === activeFilter);
  grid.innerHTML = shown.length
    ? shown.map(projectCard).join('')
    : emptyState('此分類尚無研究', '切換其他產業，或稍後回來查看更新。');
}

function renderFilters() {
  const industries = [...new Set(projects.map((project) => project.industry).filter(Boolean))];
  filters.innerHTML = `<button class="filter-chip" type="button" aria-pressed="true" data-filter="all">全部研究</button>${industries.map((industry) => `<button class="filter-chip" type="button" aria-pressed="false" data-filter="${escapeHtml(industry)}">${escapeHtml(industry)}</button>`).join('')}`;
}

function showProject(id) {
  const project = projects.find((item) => String(item.id || item.code) === id);
  if (!project) return;
  dialogTitle.textContent = project.displayName || project.name;
  const highlights = project.highlights || [];
  const demoPrefix = project.demo || api.isDemo() ? '<strong>DEMO</strong>｜' : '';
  dialogBody.innerHTML = `
    <p class="notice">${demoPrefix}公開頁只提供匿名摘要，完整公司資料與募資條件須完成資格及逐案授權。</p>
    <p class="lede" style="font-size:17px">${escapeHtml(project.summary)}</p>
    <dl class="qualification"><div class="qualification__head"><h3>研究索引</h3><span class="status">${escapeHtml(project.status || '研究中')}</span></div><dl>
      <dt>產業</dt><dd>${escapeHtml(project.industry)}</dd><dt>階段</dt><dd>${escapeHtml(project.stage)}</dd><dt>地區</dt><dd>${escapeHtml(project.region)}</dd><dt>最低認購</dt><dd>登入並取得權限後查看</dd>
    </dl></dl>
    ${highlights.length ? `<h3 style="margin-top:24px">核心觀察</h3><ul>${highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
    <h3 style="margin-top:24px">一般風險提示</h3><p class="micro">${escapeHtml(project.risk || '新創與未上市投資具有高度不確定性，可能損失全部投入資金。')}</p>`;
  openDialog(projectDialog);
}

async function loadProjects() {
  grid.innerHTML = '<div class="loading-state" style="grid-column:1/-1"><div><p>正在整理研究索引</p><div class="loading-line"></div></div></div>';
  try {
    const result = await api.projects();
    projects = normalizeProjects(result.data);
    sourceNotice(result.source, document.querySelector('#project-source'));
    renderFilters();
    renderProjects();
  } catch (error) {
    grid.innerHTML = errorState('研究索引暫時無法載入', '連線沒有完成，請確認網路後重試。', 'retry-projects');
    document.querySelector('#retry-projects')?.addEventListener('click', loadProjects);
  }
}

filters.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-filter]');
  if (!chip) return;
  activeFilter = chip.dataset.filter;
  filters.querySelectorAll('[data-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button === chip)));
  renderProjects();
});

grid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-project-open]');
  if (button) showProject(button.dataset.projectOpen);
});

document.querySelector('#booking-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在送出…');
  try {
    await api.createBooking(Object.fromEntries(new FormData(form)));
    form.reset();
    toast('預約需求已送出，引薦人確認後會通知你。');
  } catch (error) {
    toast(`預約未送出：${error.message}`, 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

initShell();
loadProjects();
