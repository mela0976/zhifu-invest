import { callAppsScript } from './apps-script';
import { randomToken, sha256Hex } from './crypto';
import { appsScriptErrorStatus } from './errors';
import {
  clearSessionCookie,
  OAUTH_STATE_TTL_SECONDS,
  sessionCookie,
  SESSION_TTL_SECONDS,
} from './db';
import type { GatewayEnv } from './types';

type LineTokenResponse = {
  access_token: string;
  expires_in: number;
  id_token: string;
  token_type: string;
};

type VerifiedIdToken = {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nonce?: string;
  name?: string;
  picture?: string;
};

type ResolvedIdentity = {
  id?: string;
  memberId?: string | null;
};

type AdminIdentity = {
  adminId: string;
  displayName: string;
};

function required(env: GatewayEnv, key: keyof GatewayEnv): string {
  const value = env[key];
  if (typeof value !== 'string' || !value) throw new Error(`${String(key)} is not configured`);
  return value;
}

function safeReturnTo(value: string | null, env: GatewayEnv): string {
  const fallback = env.MEMBER_REDIRECT_URL || `${env.APP_ORIGIN}/member.html`;
  if (!value) return fallback;
  try {
    const candidate = new URL(value, env.APP_ORIGIN);
    const allowed = new Set([env.APP_ORIGIN, ...env.ALLOWED_ORIGINS.split(',')]
      .map((origin) => origin.trim()).filter(Boolean).map((origin) => new URL(origin).origin));
    return allowed.has(candidate.origin) ? candidate.toString() : fallback;
  } catch {
    return fallback;
  }
}

async function lineForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`LINE endpoint rejected the request (${response.status})`);
  return response.json<T>();
}

export async function startLineLogin(request: Request, env: GatewayEnv): Promise<Response> {
  const channelId = required(env, 'LINE_LOGIN_CHANNEL_ID');
  const callbackUrl = required(env, 'LINE_LOGIN_CALLBACK_URL');
  const url = new URL(request.url);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO oauth_states (state_hash, nonce, return_to, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(
    await sha256Hex(state),
    nonce,
    safeReturnTo(url.searchParams.get('return_to'), env),
    now,
    now + OAUTH_STATE_TTL_SECONDS,
  ).run();

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: channelId,
    redirect_uri: callbackUrl,
    state,
    scope: 'openid profile',
    nonce,
    bot_prompt: 'aggressive',
  });
  return Response.redirect(`https://access.line.me/oauth2/v2.1/authorize?${query}`, 302);
}

export async function finishLineLogin(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code) return authError('missing_oauth_parameters', 'LINE callback is missing state or code');

  const now = Math.floor(Date.now() / 1000);
  const stateHash = await sha256Hex(state);
  const saved = await env.DB.prepare(
    `SELECT nonce, return_to
       FROM oauth_states
      WHERE state_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2`,
  ).bind(stateHash, now).first<{ nonce: string; return_to: string }>();
  if (!saved) return authError('invalid_oauth_state', 'LINE login state is invalid or expired');

  const consumed = await env.DB.prepare(
    `UPDATE oauth_states SET consumed_at = ?1
      WHERE state_hash = ?2 AND consumed_at IS NULL AND expires_at > ?1`,
  ).bind(now, stateHash).run();
  if (consumed.meta.changes !== 1) return authError('oauth_state_already_used', 'LINE login state was already used');

  try {
    const channelId = required(env, 'LINE_LOGIN_CHANNEL_ID');
    const callbackUrl = required(env, 'LINE_LOGIN_CALLBACK_URL');
    const token = await lineForm<LineTokenResponse>(
      'https://api.line.me/oauth2/v2.1/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: channelId,
        client_secret: required(env, 'LINE_LOGIN_CHANNEL_SECRET'),
      }),
    );
    const identity = await lineForm<VerifiedIdToken>(
      'https://api.line.me/oauth2/v2.1/verify',
      new URLSearchParams({ id_token: token.id_token, client_id: channelId, nonce: saved.nonce }),
    );
    if (!identity.sub || identity.aud !== channelId || identity.nonce !== saved.nonce) {
      return authError('invalid_id_token', 'LINE ID token identity validation failed');
    }

    let friendshipStatus: 'friend' | 'not_friend' | 'unknown' = 'unknown';
    try {
      const friendshipResponse = await fetch('https://api.line.me/friendship/v1/status', {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      if (friendshipResponse.ok) {
        const friendship = await friendshipResponse.json<{ friendFlag: boolean }>();
        friendshipStatus = friendship.friendFlag ? 'friend' : 'not_friend';
      }
    } catch {
      friendshipStatus = 'unknown';
    }

    const resolution = await callAppsScript<ResolvedIdentity>(env, 'upsertLineMember', {
      context: { role: 'service', actorId: 'cloudflare-line-login', requestId: crypto.randomUUID() },
      member: {
        lineUserId: identity.sub,
        displayName: identity.name || 'LINE 會員',
        pictureUrl: identity.picture || null,
        lineFriendshipState: friendshipStatus,
      },
    });
    if (!resolution.ok) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'line_member_resolution_failed',
        code: resolution.error.code,
        lineUserId: identity.sub,
      }));
      return authError(
        resolution.error.code,
        'LINE member account could not be linked',
        appsScriptErrorStatus(resolution.error.code),
      );
    }
    const memberIdValue = resolution.data.memberId || resolution.data.id;
    const memberId = typeof memberIdValue === 'string' ? memberIdValue.trim() : '';
    if (!memberId) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'line_member_resolution_invalid',
        lineUserId: identity.sub,
      }));
      return authError('member_resolution_invalid', 'LINE member account could not be linked', 502);
    }

    const rawSession = randomToken(48);
    const sessionId = await sha256Hex(rawSession);
    const csrfToken = randomToken(32);
    await env.DB.prepare(
      `INSERT INTO sessions (
         id, line_user_id, member_id, display_name, picture_url, role,
         friendship_status, csrf_token, created_at, expires_at, last_seen_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9)`,
    ).bind(
      sessionId,
      identity.sub,
      memberId,
      identity.name || 'LINE 會員',
      identity.picture || null,
      'member',
      friendshipStatus,
      csrfToken,
      now,
      now + SESSION_TTL_SECONDS,
    ).run();

    const response = Response.redirect(saved.return_to, 302);
    response.headers.append('set-cookie', sessionCookie(rawSession, env));
    return response;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'line_oauth_callback_failed',
      message: error instanceof Error ? error.message : String(error),
    }));
    return authError('line_oauth_failed', 'LINE login could not be completed', 502);
  }
}

export function authError(code: string, message: string, status = 400): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

export async function authenticateAdmin(request: Request, env: GatewayEnv): Promise<Response> {
  let body: { credential?: string; twoFactorCode?: string };
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 64 * 1024) {
      return authError('payload_too_large', 'Admin authentication payload exceeds 64 KB', 413);
    }
    body = JSON.parse(raw);
  } catch {
    return authError('invalid_json', 'Admin authentication body must be valid JSON');
  }
  if (!body.credential || !body.twoFactorCode) {
    return authError('admin_credentials_required', 'Google credential and two-factor code are required');
  }
  const verified = await callAppsScript<AdminIdentity>(env, 'authenticateAdmin', {
    context: { role: 'service', actorId: 'cloudflare-admin-login', requestId: crypto.randomUUID() },
    googleCredential: body.credential,
    twoFactorCode: body.twoFactorCode,
  });
  if (!verified.ok) {
    return authError(
      verified.error.code,
      verified.error.message,
      appsScriptErrorStatus(verified.error.code),
    );
  }
  if (!verified.data.adminId || !verified.data.displayName) {
    return authError('admin_identity_invalid', 'Admin identity response is invalid', 502);
  }
  const now = Math.floor(Date.now() / 1000);
  const rawSession = randomToken(48);
  const sessionId = await sha256Hex(rawSession);
  const csrfToken = randomToken(32);
  await env.DB.prepare(
    `INSERT INTO sessions (
       id, line_user_id, member_id, display_name, picture_url, role,
       friendship_status, csrf_token, created_at, expires_at, last_seen_at
     ) VALUES (?1, ?2, ?3, ?4, NULL, 'admin', 'unknown', ?5, ?6, ?7, ?6)`,
  ).bind(
    sessionId,
    `google:${verified.data.adminId}`,
    verified.data.adminId,
    verified.data.displayName,
    csrfToken,
    now,
    now + SESSION_TTL_SECONDS,
  ).run();
  const response = Response.json({
    ok: true,
    data: {
      authenticated: true,
      role: 'admin',
      redirectUrl: env.ADMIN_DASHBOARD_URL?.trim() || null,
      adminDashboardUrl: env.ADMIN_DASHBOARD_URL?.trim() || null,
    },
  });
  response.headers.append('set-cookie', sessionCookie(rawSession, env));
  return response;
}

export function logoutResponse(env: GatewayEnv): Response {
  const response = Response.json({ ok: true, data: { authenticated: false } });
  response.headers.append('set-cookie', clearSessionCookie(env));
  return response;
}
