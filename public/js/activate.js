import { api, appUrl } from './api.js';
import { activationSourceFromUrl, escapeHtml, setButtonBusy, toast } from './common.js';

const form = document.querySelector('#activation-form');
const card = document.querySelector('#activation-card');
const lineStatus = document.querySelector('#line-status');
const lineActions = document.querySelector('#line-actions');
const lineLogin = document.querySelector('#line-login');
const addFriend = document.querySelector('#add-friend');

function prefillCommunitySource() {
  const source = activationSourceFromUrl(window.location.search);
  const sourceCode = document.querySelector('#activation-code');
  const sourceName = document.querySelector('#activation-source');
  if (source.sourceCode && !sourceCode.value) sourceCode.value = source.sourceCode;
  if (source.sourceName && !sourceName.value) sourceName.value = source.sourceName;
}

function lineLoginUrlWithReturnTo(value) {
  try {
    const url = new URL(value, window.location.href);
    url.searchParams.set('return_to', window.location.href);
    url.searchParams.set('returnTo', `${window.location.pathname}${window.location.search}`);
    return url.toString();
  } catch {
    return value;
  }
}

function markStep(name) {
  const steps = [...document.querySelectorAll('[data-step-label]')];
  const activeIndex = steps.findIndex((item) => item.dataset.stepLabel === name);
  steps.forEach((item, index) => item.classList.toggle('is-current', index <= activeIndex));
}

function showAuthenticated(member) {
  const user = member?.member || member?.user || member;
  const name = user?.name || user?.displayName || 'LINE 會員';
  lineStatus.innerHTML = `<span class="line-lockup__mark" aria-hidden="true">✓</span><div><strong>已連結 ${escapeHtml(name)}</strong><div class="micro">接著加入官方帳號並填寫社群來源。</div></div>`;
  lineActions.hidden = true;
  form.hidden = false;
  document.querySelector('#activation-name').value = user?.name || '';
  document.querySelector('#line-user-id').value = user?.lineUserId || user?.id || '';
  markStep('identity');
}

async function initialize() {
  try {
    const config = await api.detectConfig();
    if (config?.lineLoginUrl) lineLogin.href = lineLoginUrlWithReturnTo(config.lineLoginUrl);
    if (config?.lineAddFriendUrl) addFriend.href = config.lineAddFriendUrl;
    else if (config?.lineOaBasicId || config?.lineOfficialAccountBasicId) addFriend.href = `https://line.me/R/ti/p/${encodeURIComponent(config.lineOaBasicId || config.lineOfficialAccountBasicId)}`;
    else addFriend.addEventListener('click', (event) => {
      event.preventDefault();
      toast('正式 LINE 官方帳號尚待設定；Demo 可勾選完成流程。', 'error');
    });
  } catch (error) {
    toast('LINE 設定暫時無法讀取，仍可使用 Demo 流程。', 'error');
  }

  try {
    const session = await api.me();
    if (session.data?.authenticated) showAuthenticated(session.data.member || session.data);
  } catch (error) {
    if (error.status !== 401) toast('目前尚未連結 LINE 身分。', 'error');
  }
}

document.querySelectorAll('[data-demo-login]').forEach((button) => {
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    setButtonBusy(button, true, '登入中…');
    try {
      const session = await api.demoLogin('member', button.dataset.memberId);
      showAuthenticated(session);
    } catch (error) {
      toast(`Demo 登入失敗：${error.message}`, 'error');
    } finally {
      setButtonBusy(button, false);
    }
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, '正在送出…');
  try {
    const input = Object.fromEntries(new FormData(form));
    await api.activate({ ...input, lineFriendConfirmed: true, privacyConsent: true });
    markStep('review');
    const environmentNote = api.isDemo()
      ? 'Demo 環境會立即保留這筆操作；正式審核仍須由管理後台確認。'
      : '申請已安全送交營運端；會員狀態仍須由雪芬姐人工確認。';
    card.innerHTML = `<div class="success-panel"><span class="success-panel__mark" aria-hidden="true">✓</span><p class="eyebrow">Application received</p><h2>申請已送出</h2><p>雪芬姐將核對你的社群來源。確認完成後，LINE 只會通知「狀態已更新」，請回到會員中心查看內容。</p><a class="button" href="${escapeHtml(appUrl('/member.html'))}">查看會員中心</a></div><p class="micro" style="margin-top:18px;text-align:center">${escapeHtml(environmentNote)}</p>`;
  } catch (error) {
    toast(`申請未送出：${error.message}`, 'error');
  } finally {
    setButtonBusy(button, false);
  }
});

prefillCommunitySource();
initialize();
