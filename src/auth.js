import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signature(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const [rawName, ...rawValue] = part.trim().split('=');
    return [decodeURIComponent(rawName || ''), decodeURIComponent(rawValue.join('='))];
  }).filter(([name]) => name));
}

export function createSessionManager(env = process.env) {
  const demoMode = String(env.DEMO_MODE ?? 'true').toLowerCase() !== 'false';
  const suppliedSecret = env.SESSION_SECRET;
  if (!demoMode && (!suppliedSecret || suppliedSecret.length < 32)) {
    throw new Error('SESSION_SECRET must contain at least 32 characters outside Demo mode');
  }
  const secret = suppliedSecret?.length >= 32 ? suppliedSecret : randomBytes(32).toString('hex');
  const secure = String(env.COOKIE_SECURE ?? (!demoMode)).toLowerCase() === 'true';
  const cookieName = 'zhifu_session';
  const ttlSeconds = Number(env.SESSION_TTL_SECONDS || 8 * 60 * 60);

  function issue(payload, now = Date.now(), customTtlSeconds = ttlSeconds) {
    const body = base64url(JSON.stringify({
      ...payload,
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + customTtlSeconds,
    }));
    return `${body}.${signature(body, secret)}`;
  }

  function verify(token, now = Date.now()) {
    if (!token) return null;
    const [body, provided, extra] = token.split('.');
    if (!body || !provided || extra || !safeEqual(signature(body, secret), provided)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload.exp || payload.exp <= Math.floor(now / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function fromRequest(request) {
    const token = parseCookies(request.header('cookie'))[cookieName];
    return verify(token);
  }

  function cookie(token) {
    const attributes = [
      `${cookieName}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${ttlSeconds}`,
    ];
    if (secure) attributes.push('Secure');
    return attributes.join('; ');
  }

  function clearCookie() {
    return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  function issueState(payload = {}, now = Date.now()) {
    return issue({ type: 'oauth_state', ...payload }, now);
  }

  return { cookieName, issue, verify, fromRequest, cookie, clearCookie, issueState, demoMode };
}

export function requireRole(session, roles) {
  if (!session) return { status: 401, code: 'authentication_required', message: 'Please sign in' };
  if (!roles.includes(session.role)) return { status: 403, code: 'forbidden', message: 'Insufficient permission' };
  return null;
}
