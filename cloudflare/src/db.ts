import { parseCookies, sha256Hex } from './crypto';
import type { GatewayEnv, Session } from './types';

export const SESSION_COOKIE = '__Host-zhifu_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const DECK_TOKEN_TTL_SECONDS = 5 * 60;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const WEBHOOK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type SessionRow = {
  id: string;
  line_user_id: string;
  member_id: string | null;
  display_name: string;
  picture_url: string | null;
  role: 'member' | 'admin';
  friendship_status: 'friend' | 'not_friend' | 'unknown';
  csrf_token: string;
  created_at: number;
  expires_at: number;
};

function cookieSameSite(env: GatewayEnv): 'None' | 'Lax' {
  return String(env.COOKIE_SAME_SITE).toLowerCase() === 'none' ? 'None' : 'Lax';
}

export function sessionCookie(token: string, env: GatewayEnv): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=${cookieSameSite(env)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(env: GatewayEnv): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=${cookieSameSite(env)}; Max-Age=0`;
}

export async function getSession(request: Request, env: GatewayEnv): Promise<Session | null> {
  const rawToken = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!rawToken) return null;
  const id = await sha256Hex(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT id, line_user_id, member_id, display_name, picture_url, role,
            friendship_status, csrf_token, created_at, expires_at
       FROM sessions
      WHERE id = ?1 AND expires_at > ?2`,
  ).bind(id, now).first<SessionRow>();
  if (!row) return null;
  if (row.role === 'member' && !row.member_id?.trim()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
    console.error(JSON.stringify({
      level: 'error',
      event: 'invalid_member_session_removed',
      sessionId: id,
    }));
    return null;
  }

  await env.DB.prepare('UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2')
    .bind(now, id).run();
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    memberId: row.member_id,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    role: row.role,
    friendshipStatus: row.friendship_status,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function deleteSession(request: Request, env: GatewayEnv): Promise<void> {
  const rawToken = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!rawToken) return;
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?1')
    .bind(await sha256Hex(rawToken)).run();
}

export async function cleanupExpired(env: GatewayEnv): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const webhookCutoff = Date.now() - WEBHOOK_RETENTION_MS;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?1').bind(now),
    env.DB.prepare('DELETE FROM deck_tokens WHERE expires_at <= ?1').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now),
    env.DB.prepare('DELETE FROM webhook_events WHERE received_at <= ?1').bind(webhookCutoff),
  ]);
}
