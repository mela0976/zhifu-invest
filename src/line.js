import { createHmac, timingSafeEqual } from 'node:crypto';

function isConfigured(env) {
  return Boolean(env.LINE_LOGIN_CHANNEL_ID && env.LINE_LOGIN_CHANNEL_SECRET && env.LINE_LOGIN_CALLBACK_URL);
}

export function createLineProvider(env = process.env) {
  const demoMode = String(env.DEMO_MODE ?? 'true').toLowerCase() !== 'false';
  const loginConfigured = isConfigured(env);
  const messagingConfigured = Boolean(env.LINE_MESSAGING_ACCESS_TOKEN && env.LINE_MESSAGING_CHANNEL_SECRET);

  function authorizationUrl(state) {
    if (!loginConfigured) {
      if (!demoMode) throw new Error('LINE Login is not configured');
      const callback = env.LINE_LOGIN_CALLBACK_URL || `${env.APP_ORIGIN || 'http://localhost:4173'}/api/auth/line/callback`;
      return `${callback}?state=${encodeURIComponent(state)}&demo_member=member-001`;
    }
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: env.LINE_LOGIN_CHANNEL_ID,
      redirect_uri: env.LINE_LOGIN_CALLBACK_URL,
      state,
      scope: 'openid profile',
      bot_prompt: 'aggressive',
    });
    return `https://access.line.me/oauth2/v2.1/authorize?${query}`;
  }

  async function exchange(code) {
    if (!loginConfigured) throw new Error('LINE Login is not configured');
    const response = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.LINE_LOGIN_CALLBACK_URL,
        client_id: env.LINE_LOGIN_CHANNEL_ID,
        client_secret: env.LINE_LOGIN_CHANNEL_SECRET,
      }),
    });
    if (!response.ok) throw new Error(`LINE token exchange failed (${response.status})`);
    return response.json();
  }

  async function profile(accessToken) {
    const response = await fetch('https://api.line.me/v2/profile', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`LINE profile failed (${response.status})`);
    return response.json();
  }

  function verifyWebhook(rawBody, providedSignature) {
    const channelSecret = env.LINE_MESSAGING_CHANNEL_SECRET;
    if (!channelSecret || !providedSignature) return false;
    const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
    const left = Buffer.from(expected);
    const right = Buffer.from(providedSignature);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  async function push(lineUserId, messages) {
    if (!messagingConfigured) {
      if (!demoMode) throw new Error('LINE Messaging API is not configured');
      return { demo: true, requestId: `demo-push-${Date.now()}` };
    }
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.LINE_MESSAGING_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to: lineUserId, messages }),
    });
    if (!response.ok) throw new Error(`LINE push failed (${response.status})`);
    return { demo: false, requestId: response.headers.get('x-line-request-id') };
  }

  return {
    demoMode,
    loginConfigured,
    messagingConfigured,
    authorizationUrl,
    exchange,
    profile,
    verifyWebhook,
    push,
  };
}

export function statusMessage(eventType) {
  const labels = {
    'activation.received': '會員啟用申請已收到',
    'membership.active': '會員身分已確認',
    'qualification.needs_information': '資格審核需要補充資料',
    'qualification.approved': '資格審核狀態已更新',
    'qualification.rejected': '資格審核狀態已更新',
    'subscription.submitted': '認購意向申請已收到',
    'subscription.approved': '認購意向狀態已更新',
    'subscription.rejected': '認購意向狀態已更新',
    'funding.paid': '入金紀錄狀態已更新',
    'allocation.final': '分配紀錄狀態已更新',
    'booking.received': '顧問預約申請已收到',
    'operations.activation_received': '收到新的會員啟用申請',
    'operations.subscription_received': '收到新的認購意向申請',
    'operations.booking_received': '收到新的顧問預約申請',
  };
  return `${labels[eventType] || '致富投資狀態已更新'}，請登入會員中心查看。訊息不包含個人金額資料。`;
}
