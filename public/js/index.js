import { api } from './api.js';
import { emptyState, errorState, escapeHtml, formatMoney, initShell, openDialog, setButtonBusy, sourceNotice, toast } from './common.js';
import { t } from './i18n.js';

const grid = document.querySelector('#project-grid');
const filters = document.querySelector('#project-filters');
const projectDialog = document.querySelector('#project-dialog');
const dialogTitle = document.querySelector('#project-dialog-title');
const dialogBody = document.querySelector('#project-dialog-body');
let projects = [];
let activeFilter = 'all';

function safeExternalUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}

function normalizeProjects(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.projects || payload?.items || [];
}

function projectCard(project) {
  const id = escapeHtml(project.id || project.code);
  return `<article class="project-card" data-industry="${escapeHtml(project.industry)}" data-testid="project-card">
    <div class="project-card__rail"></div>
    <div class="project-card__head"><span class="project-card__code">${escapeHtml(project.code || project.id)}</span><span class="status">${escapeHtml(t(project.status || '研究中'))}</span></div>
    <div class="project-card__body">
      <h3>${escapeHtml(project.displayName || project.name)}</h3>
      <p>${escapeHtml(t(project.summary || '專案摘要整理中。'))}</p>
      <ul class="project-card__meta">
        <li><span>Industry</span><strong>${escapeHtml(t(project.industry || '待分類'))}</strong></li>
        <li><span>Stage</span><strong>${escapeHtml(t(project.stage || '待確認'))}</strong></li>
        <li><span>Region</span><strong>${escapeHtml(t(project.region || '台灣'))}</strong></li>
        <li><span>Access</span><strong>${escapeHtml(t(project.visibility === 'member' ? '正式會員' : '逐案授權'))}</strong></li>
      </ul>
    </div>
    <div class="project-card__foot"><span class="micro">${escapeHtml(t('公開匿名摘要'))}</span><button class="button button--quiet button--small project-card__link" type="button" data-project-open="${id}">${escapeHtml(t('查看研究摘要'))}</button></div>
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
  filters.innerHTML = `<button class="filter-chip" type="button" aria-pressed="true" data-filter="all">${escapeHtml(t('全部研究'))}</button>${industries.map((industry) => `<button class="filter-chip" type="button" aria-pressed="false" data-filter="${escapeHtml(industry)}">${escapeHtml(t(industry))}</button>`).join('')}`;
}

function showProject(id) {
  const project = projects.find((item) => String(item.id || item.code) === id);
  if (!project) return;
  dialogTitle.textContent = project.displayName || project.name;
  const highlights = project.highlights || [];
  const demoPrefix = project.demo || api.isDemo() ? '<strong>DEMO</strong>｜' : '';
  dialogBody.innerHTML = `
    <p class="notice">${demoPrefix}${escapeHtml(t('公開頁只提供匿名摘要，完整公司資料與募資條件須完成資格及逐案授權。'))}</p>
    <p class="lede" style="font-size:17px">${escapeHtml(t(project.summary))}</p>
    <dl class="qualification"><div class="qualification__head"><h3>${escapeHtml(t('研究索引'))}</h3><span class="status">${escapeHtml(t(project.status || '研究中'))}</span></div><dl>
      <dt>${escapeHtml(t('產業'))}</dt><dd>${escapeHtml(t(project.industry))}</dd><dt>${escapeHtml(t('階段'))}</dt><dd>${escapeHtml(t(project.stage))}</dd><dt>${escapeHtml(t('地區'))}</dt><dd>${escapeHtml(t(project.region))}</dd><dt>${escapeHtml(t('最低認購'))}</dt><dd>${escapeHtml(t('登入並取得權限後查看'))}</dd>
    </dl></dl>
    ${highlights.length ? `<h3 style="margin-top:24px">${escapeHtml(t('核心觀察'))}</h3><ul>${highlights.map((item) => `<li>${escapeHtml(t(item))}</li>`).join('')}</ul>` : ''}
    <h3 style="margin-top:24px">${escapeHtml(t('一般風險提示'))}</h3><p class="micro">${escapeHtml(t(project.risk || '新創與未上市投資具有高度不確定性，可能損失全部投入資金。'))}</p>`;
  openDialog(projectDialog);
}

async function loadProjects() {
  grid.innerHTML = `<div class="loading-state" style="grid-column:1/-1"><div><p>${escapeHtml(t('正在整理研究索引'))}</p><div class="loading-line"></div></div></div>`;
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

async function loadPublicVideos() {
  const target = document.querySelector('#public-video-feed');
  if (!target) return;
  try {
    const result = await api.publicContentFeed();
    const data = result.data || result;
    const items = (Array.isArray(data) ? data : data?.content || data?.items || [])
      .filter((item) => item.type === 'video' && item.status === 'published' && item.publicSafe === true && safeExternalUrl(item.videoUrl || item.url));
    target.innerHTML = items.length ? items.slice(0, 3).map((item, index) => `<article class="landing-video-card" data-testid="public-video"><span>VIDEO / ${String(index + 1).padStart(2, '0')}</span><h4>${escapeHtml(t(item.title))}</h4><p>${escapeHtml(t(item.summary || ''))}</p><a href="${escapeHtml(safeExternalUrl(item.videoUrl || item.url))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(t(`觀看${item.title}`))}">觀看影音 <b aria-hidden="true">↗</b></a><small>${escapeHtml(t(item.riskNotice || item.riskDisclosure || '一般研究資訊，不構成投資建議。'))}</small></article>`).join('') : emptyState('目前沒有公開影音', '完成內容核准與公開安全檢核後，最新影音會顯示在這裡。');
  } catch (error) {
    target.innerHTML = errorState('投資影音暫時無法載入', '稍後重新整理即可；募資研究索引不受影響。');
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
    toast(t('預約需求已送出，引薦人確認後會通知你。'));
  } catch (error) {
    toast(`預約未送出：${error.message}`, 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

initShell();
loadProjects();
loadPublicVideos();
