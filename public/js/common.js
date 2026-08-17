import { api, appUrl } from './api.js';

const moneyFormatter = new Intl.NumberFormat('zh-TW', {
  style: 'currency', currency: 'TWD', maximumFractionDigits: 0,
});

export function formatMoney(value, compact = false) {
  const number = Number(value || 0);
  if (compact && number >= 100000000) return `NT$ ${(number / 100000000).toFixed(1)} 億`;
  if (compact && number >= 10000) return `NT$ ${(number / 10000).toFixed(number % 10000 ? 1 : 0)} 萬`;
  return moneyFormatter.format(number).replace('$', '$ ');
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatDate(value) {
  if (!value) return '尚未設定';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export function announce(message) {
  const live = document.querySelector('#live-region');
  if (live) live.textContent = message;
}

export function toast(message, tone = 'success') {
  let region = document.querySelector('.toast-region');
  if (!region) {
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  const item = document.createElement('div');
  item.className = `toast toast--${tone}`;
  item.innerHTML = `<span class="toast__mark" aria-hidden="true">${tone === 'error' ? '!' : '✓'}</span><span>${escapeHtml(message)}</span>`;
  region.append(item);
  window.setTimeout(() => item.classList.add('is-visible'), 20);
  window.setTimeout(() => {
    item.classList.remove('is-visible');
    window.setTimeout(() => item.remove(), 220);
  }, 4200);
}

export function setButtonBusy(button, busy, busyText = '處理中…') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

export function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

export function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

export function bindDialogDismissals() {
  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-dialog-close]');
    if (close) closeDialog(close.closest('dialog'));
    if (event.target instanceof HTMLDialogElement) {
      const box = event.target.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) closeDialog(event.target);
    }
  });
}

export function activationSourceFromUrl(search = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const clean = (value, limit) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
  const first = (names, limit) => clean(names.map((name) => params.get(name)).find(Boolean), limit);
  return {
    sourceCode: first(['sourceCode', 'source_code', 'source', 'sc'], 40),
    sourceName: first(['sourceName', 'source_name', 'group', 'openChat', 'openchat'], 100),
  };
}

export function normalizeExternalHttpsUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function resolveAdminDashboardRoute(config = {}, liveApi = false) {
  if (!liveApi) return { mode: 'local', url: '' };
  const url = normalizeExternalHttpsUrl(config?.adminDashboardUrl);
  return url ? { mode: 'redirect', url } : { mode: 'blocked', url: '' };
}

export function qualificationExpiryIso(value, now = Date.now()) {
  const expiresAt = new Date(`${String(value || '').trim()}T23:59:59+08:00`);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Number(now)) return '';
  return expiresAt.toISOString();
}

function setDemoControlsVisible(visible) {
  document.querySelectorAll('[data-demo-login], [data-demo-access]').forEach((element) => {
    element.hidden = !visible;
    if ('disabled' in element) element.disabled = !visible;
  });
}

export function initShell() {
  if (api.hasLiveApi()) setDemoControlsVisible(false);
  document.querySelectorAll('a[href^="/api/"]').forEach((link) => {
    link.href = api.apiUrl(link.getAttribute('href'));
  });

  const menuButton = document.querySelector('[data-menu-toggle]');
  const menu = document.querySelector('[data-mobile-menu]');
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!open));
    menu?.toggleAttribute('data-open', !open);
  });

  document.querySelectorAll('[data-scroll-to]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const selector = link.getAttribute('href');
      if (!selector?.startsWith('#')) return;
      const target = document.querySelector(selector);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      menuButton?.setAttribute('aria-expanded', 'false');
      menu?.removeAttribute('data-open');
    });
  });

  document.querySelectorAll('[data-demo-login]').forEach((button) => {
    button.addEventListener('click', async () => {
      const role = button.dataset.demoLogin;
      const memberId = button.dataset.memberId;
      setButtonBusy(button, true, '切換中…');
      try {
        await api.demoLogin(role, memberId);
        window.location.href = appUrl(role === 'admin' ? '/admin.html' : '/member.html');
      } catch (error) {
        toast(`無法切換 Demo 身分：${error.message}`, 'error');
        setButtonBusy(button, false);
      }
    });
  });

  document.querySelectorAll('[data-logout]').forEach((button) => {
    button.addEventListener('click', async () => {
      try { await api.logout(); } catch (error) { console.info(error.message); }
      window.location.href = appUrl('/');
    });
  });

  bindDialogDismissals();
  api.detectConfig()
    .then((config) => {
      setDemoControlsVisible(!api.hasLiveApi() || Boolean(config?.demoMode));
      if (config?.demoMode || api.isDemo()) document.documentElement.dataset.demo = 'true';
      if (config?.staticPreview || api.isStaticPreview()) {
        const strip = document.querySelector('.demo-strip');
        if (strip) strip.textContent = 'GITHUB STATIC PREVIEW｜唯讀介面預覽，不會儲存或送出任何資料';
      } else if (api.hasLiveApi()) {
        const strip = document.querySelector('.demo-strip');
        if (strip) strip.textContent = config?.demoMode
          ? 'CONNECTED DEMO API｜資料由遠端 Demo 服務提供，不會回退瀏覽器內建會員資料'
          : 'SECURE ONLINE SERVICE｜會員資料需登入並通過資格驗證';
      }
    })
    .catch(() => {
      if (api.hasLiveApi()) setDemoControlsVisible(false);
    });
}

export function sourceNotice(source, target) {
  if (!target || source === 'api') return;
  target.hidden = false;
  target.textContent = source === 'demo-fallback'
    ? api.isStaticPreview()
      ? 'GitHub 唯讀預覽｜顯示虛構資料，所有送出與狀態異動均已停用。'
      : '目前顯示本機 Demo 資料，正式服務連線後會自動切換。'
    : 'Demo 環境｜所有人物、公司與金額均為示意。';
}

export function emptyState(title, detail, action = '') {
  return `<div class="empty-state"><span class="empty-state__mark" aria-hidden="true">＋</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p>${action}</div>`;
}

export function errorState(title, detail, retryId = '') {
  return `<div class="empty-state empty-state--error"><span class="empty-state__mark" aria-hidden="true">!</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p>${retryId ? `<button class="button button--secondary" type="button" id="${escapeHtml(retryId)}">重新載入</button>` : ''}</div>`;
}
