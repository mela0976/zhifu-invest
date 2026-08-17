import { callAppsScript } from './apps-script';
import { authenticateAdmin, finishLineLogin, logoutResponse, startLineLogin } from './auth';
import {
  hmacSha256Base64,
  randomToken,
  sha256Hex,
  timingSafeBase64Equal,
  timingSafeStringEqual,
} from './crypto';
import {
  cleanupExpired,
  DECK_TOKEN_TTL_SECONDS,
  deleteSession,
  getSession,
} from './db';
import { appsScriptErrorStatus } from './errors';
import type { Actor, GatewayEnv, Session } from './types';
import { drainWebhookEvents, enqueueWebhookEvents } from './webhook';
import type { LineWebhookPayload } from './webhook';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const JSON_BODY_LIMIT = 64 * 1024;
const WEBHOOK_BODY_LIMIT = 2 * 1024 * 1024;

type RouteMatch = {
  operation: string;
  access: 'public' | 'member' | 'admin';
  params?: Record<string, string>;
};

const fixedRoutes = new Map<string, RouteMatch>([
  ['GET /api/projects', { operation: 'listProjects', access: 'public' }],
  ['POST /api/activation', { operation: 'createActivation', access: 'member' }],
  ['GET /api/bookings', { operation: 'adminList', access: 'admin', params: { resource: 'bookings' } }],
  ['POST /api/bookings', { operation: 'createBooking', access: 'public' }],
  ['GET /api/subscriptions', { operation: 'listSubscriptions', access: 'member' }],
  ['POST /api/subscriptions', { operation: 'createSubscription', access: 'member' }],
  ['GET /api/admin/dashboard', { operation: 'adminDashboard', access: 'admin' }],
  ['GET /api/admin/overview', { operation: 'adminDashboard', access: 'admin' }],
  ['GET /api/admin/members', { operation: 'adminList', access: 'admin', params: { resource: 'members' } }],
  ['GET /api/admin/projects', { operation: 'adminList', access: 'admin', params: { resource: 'projects' } }],
  ['GET /api/admin/subscriptions', { operation: 'adminList', access: 'admin', params: { resource: 'subscriptions' } }],
  ['GET /api/admin/actions', { operation: 'adminDashboard', access: 'admin' }],
  ['GET /api/admin/notifications', { operation: 'adminList', access: 'admin', params: { resource: 'notifications' } }],
  ['POST /api/admin/notifications', { operation: 'adminCreateBulkNotification', access: 'admin' }],
  ['POST /api/admin/notifications/process', { operation: 'adminProcessNotifications', access: 'admin' }],
  ['GET /api/admin/audits', { operation: 'adminList', access: 'admin', params: { resource: 'audits' } }],
  ['GET /api/admin/exports/members.csv', { operation: 'adminExport', access: 'admin', params: { resource: 'members' } }],
  ['GET /api/admin/exports/subscriptions.csv', { operation: 'adminExport', access: 'admin', params: { resource: 'subscriptions' } }],
  ['GET /api/admin/export/members.csv', { operation: 'adminExport', access: 'admin', params: { resource: 'members' } }],
  ['GET /api/admin/export/subscriptions.csv', { operation: 'adminExport', access: 'admin', params: { resource: 'subscriptions' } }],
]);

function matchProxyRoute(method: string, pathname: string): RouteMatch | null {
  const fixed = fixedRoutes.get(`${method} ${pathname}`);
  if (fixed) return fixed;
  const patterns: Array<[string, RegExp, string, RouteMatch['access'], string[]]> = [
    ['GET', /^\/api\/projects\/([^/]+)$/, 'getProject', 'public', ['projectId']],
    ['PATCH', /^\/api\/admin\/members\/([^/]+)$/, 'adminPatchMember', 'admin', ['memberId']],
    ['PATCH', /^\/api\/admin\/projects\/([^/]+)$/, 'adminPatchProject', 'admin', ['projectId']],
    ['PATCH', /^\/api\/admin\/subscriptions\/([^/]+)$/, 'adminPatchSubscription', 'admin', ['subscriptionId']],
    ['POST', /^\/api\/admin\/notifications\/([^/]+)\/send$/, 'adminApproveNotification', 'admin', ['notificationId']],
  ];
  for (const [expectedMethod, pattern, operation, access, names] of patterns) {
    if (method !== expectedMethod) continue;
    const match = pathname.match(pattern);
    if (!match) continue;
    const params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
    return { operation, access, params };
  }
  return null;
}

function allowedOrigins(env: GatewayEnv): Set<string> {
  return new Set([env.APP_ORIGIN, ...env.ALLOWED_ORIGINS.split(',')]
    .map((origin) => origin.trim()).filter(Boolean).flatMap((origin) => {
      try { return [new URL(origin).origin]; } catch { return []; }
    }));
}

function originError(request: Request, env: GatewayEnv, pathname: string): Response | null {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins(env);
  if (origin && !allowed.has(origin)) {
    return jsonError(403, 'origin_not_allowed', 'Request origin is not allowed');
  }
  if (UNSAFE_METHODS.has(request.method) && pathname !== '/api/line/webhook') {
    if (!origin || !allowed.has(origin)) {
      return jsonError(403, 'csrf_origin_required', 'A trusted Origin header is required');
    }
  }
  return null;
}

function withHeaders(response: Response, request: Request, env: GatewayEnv): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('cache-control', 'no-store');
  const origin = request.headers.get('origin');
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('vary', 'Origin');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: JSON_HEADERS });
}

function actorFor(session: Session | null): Actor {
  if (!session) return { role: 'visitor' };
  return {
    role: session.role,
    sessionId: session.id,
    lineUserId: session.lineUserId,
    memberId: session.memberId,
    displayName: session.displayName,
    friendshipStatus: session.friendshipStatus,
  };
}

function canAccess(required: RouteMatch['access'], session: Session | null): boolean {
  if (required === 'public') return true;
  if (!session) return false;
  if (required === 'admin') return session.role === 'admin';
  return session.role === 'admin' || (session.role === 'member' && Boolean(session.memberId?.trim()));
}

function csrfError(request: Request, session: Session | null, pathname: string): Response | null {
  if (!session || !UNSAFE_METHODS.has(request.method) || pathname === '/api/line/webhook') return null;
  if (pathname === '/api/auth/admin') return null;
  const supplied = request.headers.get('x-csrf-token') || '';
  if (!supplied || !timingSafeStringEqual(session.csrfToken, supplied)) {
    return jsonError(403, 'csrf_token_invalid', 'CSRF token is missing or invalid');
  }
  return null;
}

async function requestPayload(request: Request, match: RouteMatch, session: Session | null): Promise<Record<string, unknown>> {
  const url = new URL(request.url);
  let body: Record<string, unknown> = {};
  if (UNSAFE_METHODS.has(request.method)) {
    const contentType = request.headers.get('content-type') || '';
    const declaredLength = Number(request.headers.get('content-length') || '0');
    if (declaredLength > JSON_BODY_LIMIT) throw new Error('payload_too_large');
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > JSON_BODY_LIMIT) throw new Error('payload_too_large');
    if (raw) {
      if (!contentType.toLowerCase().includes('application/json')) throw new Error('content_type');
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
        body = parsed;
      } catch { throw new Error('invalid_json'); }
    }
  }
  const requestId = crypto.randomUUID();
  const actor = actorFor(session);
  const context = {
    role: actor.role,
    actorId: actor.memberId || actor.lineUserId || 'anonymous',
    memberId: actor.memberId || '',
    requestId,
  };
  const base = { context };
  const params = match.params || {};
  if (match.operation === 'getProject') return { ...base, projectId: params.projectId };
  if (match.operation === 'createBooking') return { ...base, booking: body };
  if (match.operation === 'createActivation') return { ...base, activation: body };
  if (match.operation === 'createSubscription') {
    return {
      ...base,
      projectId: body.projectId,
      requestedAmountTwd: body.requestedAmountTwd ?? body.requestedAmount,
      riskAcknowledged: body.riskAcknowledged === true || body.riskAcknowledged === 'true',
      idempotencyKey: request.headers.get('idempotency-key') || body.idempotencyKey,
    };
  }
  if (match.operation === 'adminList' || match.operation === 'adminExport') {
    return { ...base, resource: params.resource, ...Object.fromEntries(url.searchParams) };
  }
  if (match.operation === 'adminPatchMember' || match.operation === 'adminPatchProject' || match.operation === 'adminPatchSubscription') {
    const { reason, ...patch } = body;
    const normalizedPatch = match.operation === 'adminPatchSubscription' ? {
      ...patch,
      ...(patch.subscriptionStatus !== undefined ? { subscriptionState: patch.subscriptionStatus } : {}),
      ...(patch.fundingStatus !== undefined ? { fundingState: patch.fundingStatus } : {}),
      ...(patch.allocationStatus !== undefined ? { allocationState: patch.allocationStatus } : {}),
      ...(patch.approvedAmount !== undefined ? { approvedAmountTwd: patch.approvedAmount } : {}),
      ...(patch.receivedAmount !== undefined ? { receivedAmountTwd: patch.receivedAmount } : {}),
      ...(patch.allocatedAmount !== undefined ? { allocatedAmountTwd: patch.allocatedAmount } : {}),
      ...(patch.refundedAmount !== undefined ? { refundedAmountTwd: patch.refundedAmount } : {}),
    } : patch;
    return { ...base, ...params, patch: normalizedPatch, reason };
  }
  if (match.operation === 'adminApproveNotification') return { ...base, ...params, reason: body.reason };
  if (match.operation === 'adminCreateBulkNotification') {
    return {
      ...base,
      memberIds: body.memberIds || (body.memberId ? [body.memberId] : []),
      announcementId: body.announcementId || null,
    };
  }
  if (match.operation === 'adminProcessNotifications') return { ...base, limit: body.limit };
  return base;
}

async function proxy(request: Request, env: GatewayEnv, match: RouteMatch, session: Session | null): Promise<Response> {
  if (!canAccess(match.access, session)) {
    return session
      ? jsonError(403, 'forbidden', 'This account cannot perform the requested operation')
      : jsonError(401, 'authentication_required', 'Please sign in with LINE');
  }
  let payload: Record<string, unknown>;
  try {
    payload = await requestPayload(request, match, session);
  } catch (error) {
    if (error instanceof Error && error.message === 'payload_too_large') {
      return jsonError(413, 'payload_too_large', 'JSON request body exceeds 64 KB');
    }
    return error instanceof Error && error.message === 'content_type'
      ? jsonError(415, 'json_required', 'State-changing requests must use application/json')
      : jsonError(400, 'invalid_json', 'Request body must be valid JSON');
  }
  const result = await callAppsScript(env, match.operation, payload);
  if (result.ok && match.operation === 'adminExport') {
    const data = result.data;
    if (!isCsvExport(data)) {
      return jsonError(502, 'apps_script_invalid_response', 'Operations backend returned an invalid CSV export');
    }
    const filename = data.filename.trim() || 'zhifu-export.csv';
    return new Response(data.csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  }
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : appsScriptErrorStatus(result.error.code),
    headers: JSON_HEADERS,
  });
}

function isCsvExport(value: unknown): value is { filename: string; csv: string } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.filename === 'string' && typeof candidate.csv === 'string';
}

async function createDeckToken(request: Request, env: GatewayEnv, projectId: string, session: Session | null): Promise<Response> {
  if (!session) return jsonError(401, 'authentication_required', 'Please sign in with LINE');
  if (!session.memberId?.trim()) {
    return jsonError(403, 'identity_not_linked', 'Member identity is not linked');
  }
  const authorization = await callAppsScript<{
    allowed?: boolean;
    deckId?: string;
    objectKey?: string;
    filename?: string;
    contentType?: string;
    authorization?: { allowed?: boolean; deckId?: string; objectKey?: string; filename?: string; contentType?: string };
  }>(env, 'authorizeDeck', {
    projectId,
    context: {
      role: session.role,
      actorId: session.memberId || session.lineUserId,
      memberId: session.memberId || '',
      requestId: crypto.randomUUID(),
    },
  });
  if (!authorization.ok) {
    return jsonError(
      appsScriptErrorStatus(authorization.error.code),
      authorization.error.code,
      authorization.error.message,
    );
  }
  const decision = authorization.data.authorization || authorization.data;
  const objectKey = decision.objectKey || decision.deckId;
  if (decision.allowed === false || !objectKey) {
    return jsonError(403, 'deck_access_denied', 'Qualified investor approval is required');
  }
  const object = await env.DECKS.head(objectKey);
  if (!object) return jsonError(404, 'deck_not_found', 'Protected document is not available');

  const rawToken = randomToken(32);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO deck_tokens (
       token_hash, session_id, project_id, object_key, filename, content_type, created_at, expires_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    await sha256Hex(rawToken),
    session.id,
    projectId,
    objectKey,
    decision.filename || `${projectId}-pitch-deck.pdf`,
    decision.contentType || object.httpMetadata?.contentType || 'application/pdf',
    now,
    now + DECK_TOKEN_TTL_SECONDS,
  ).run();
  return Response.json({
    ok: true,
    data: {
      token: rawToken,
      url: new URL(`/api/decks/${rawToken}`, request.url).toString(),
      expiresIn: DECK_TOKEN_TTL_SECONDS,
    },
  });
}

async function downloadDeck(
  env: GatewayEnv,
  ctx: ExecutionContext,
  rawToken: string,
  session: Session | null,
): Promise<Response> {
  if (!session) return jsonError(401, 'authentication_required', 'Please sign in with LINE');
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT project_id, object_key, filename, content_type
       FROM deck_tokens
      WHERE token_hash = ?1 AND session_id = ?2 AND expires_at > ?3`,
  ).bind(await sha256Hex(rawToken), session.id, now).first<{
    project_id: string;
    object_key: string;
    filename: string;
    content_type: string;
  }>();
  if (!row) return jsonError(403, 'invalid_deck_token', 'Download token is invalid for this session or expired');
  const object = await env.DECKS.get(row.object_key);
  if (!object) return jsonError(404, 'deck_not_found', 'Protected document is not available');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('content-type', row.content_type);
  headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
  headers.set('content-length', String(object.size));
  headers.set('cache-control', 'private, no-store');
  ctx.waitUntil(callAppsScript(env, 'deckDownloadAudit', {
    context: {
      role: session.role,
      actorId: session.memberId || session.lineUserId,
      memberId: session.memberId || '',
      requestId: crypto.randomUUID(),
    },
    projectId: row.project_id,
    objectKey: row.object_key,
    downloadedAt: Date.now(),
  }).then((result) => {
    if (!result.ok) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'deck_download_audit_failed',
        code: result.error.code,
        projectId: row.project_id,
      }));
    }
  }));
  return new Response(object.body, { headers });
}

async function acceptWebhook(request: Request, env: GatewayEnv, ctx: ExecutionContext): Promise<Response> {
  if (!env.LINE_MESSAGING_CHANNEL_SECRET) {
    return jsonError(503, 'line_webhook_not_configured', 'LINE webhook verification is not configured');
  }
  const declaredLength = Number(request.headers.get('content-length') || '0');
  if (declaredLength > WEBHOOK_BODY_LIMIT) {
    return jsonError(413, 'payload_too_large', 'LINE webhook body exceeds 2 MB');
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > WEBHOOK_BODY_LIMIT) {
    return jsonError(413, 'payload_too_large', 'LINE webhook body exceeds 2 MB');
  }
  const provided = request.headers.get('x-line-signature') || '';
  const expected = await hmacSha256Base64(env.LINE_MESSAGING_CHANNEL_SECRET, raw);
  if (!timingSafeBase64Equal(expected, provided)) {
    return jsonError(401, 'invalid_line_signature', 'LINE webhook signature is invalid');
  }
  let payload: LineWebhookPayload;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return jsonError(400, 'invalid_json', 'Webhook body must be a JSON object');
    }
    payload = decoded;
  } catch {
    return jsonError(400, 'invalid_json', 'Webhook body must be valid JSON');
  }
  try {
    await enqueueWebhookEvents(env, payload);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'line_webhook_persist_failed',
      message: error instanceof Error ? error.message : String(error),
    }));
    return jsonError(503, 'webhook_persistence_failed', 'LINE webhook could not be persisted');
  }
  ctx.waitUntil(drainWebhookEvents(env).catch((error) => {
    console.error(JSON.stringify({
      level: 'error',
      event: 'line_webhook_drain_failed',
      message: error instanceof Error ? error.message : String(error),
    }));
  }));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
}

async function handle(request: Request, env: GatewayEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const originFailure = originError(request, env, url.pathname);
  if (originFailure) return originFailure;

  if (request.method === 'OPTIONS') {
    if (!request.headers.get('origin')) return jsonError(400, 'origin_required', 'Origin header is required');
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, idempotency-key, x-csrf-token',
        'access-control-max-age': '86400',
      },
    });
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return Response.json({ ok: true, service: 'zhifu-invest-gateway', environment: env.ENVIRONMENT });
  }
  if (request.method === 'GET' && url.pathname === '/api/config') {
    const lineOaBasicId = env.LINE_OA_BASIC_ID || null;
    return Response.json({
      ok: true,
      data: {
        appOrigin: env.APP_ORIGIN,
        lineLoginEnabled: Boolean(env.LINE_LOGIN_CHANNEL_ID && env.LINE_LOGIN_CALLBACK_URL),
        lineLoginUrl: new URL('/api/auth/line', request.url).toString(),
        lineOaBasicId,
        addFriendUrl: lineOaBasicId ? `https://line.me/R/ti/p/${encodeURIComponent(lineOaBasicId)}` : null,
        lineAddFriendUrl: lineOaBasicId ? `https://line.me/R/ti/p/${encodeURIComponent(lineOaBasicId)}` : null,
        adminDashboardUrl: env.ADMIN_DASHBOARD_URL?.trim() || null,
        gatewayMode: 'cloudflare',
      },
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/auth/line') return startLineLogin(request, env);
  if (request.method === 'GET' && url.pathname === '/api/auth/line/callback') return finishLineLogin(request, env);
  if (request.method === 'POST' && url.pathname === '/api/line/webhook') return acceptWebhook(request, env, ctx);

  const session = await getSession(request, env);
  const csrfFailure = csrfError(request, session, url.pathname);
  if (csrfFailure) return csrfFailure;
  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    if (!session) return Response.json({ ok: true, data: { authenticated: false, role: 'visitor', member: null } });
    let member = {
      id: session.memberId || `line:${session.lineUserId}`,
      displayName: session.displayName,
      pictureUrl: session.pictureUrl,
      lineFriendshipState: session.friendshipStatus,
    };
    if (session.role === 'member' && session.memberId) {
      const profile = await callAppsScript<{ member?: Record<string, unknown> }>(env, 'getMember', {
        context: {
          role: 'member',
          actorId: session.memberId,
          memberId: session.memberId,
          requestId: crypto.randomUUID(),
        },
      });
      if (profile.ok && profile.data.member) member = { ...member, ...profile.data.member };
    }
    return Response.json({
      ok: true,
      data: {
        authenticated: true,
        role: session.role,
        csrfToken: session.csrfToken,
        member,
      },
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/admin') {
    return authenticateAdmin(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    await deleteSession(request, env);
    return logoutResponse(env);
  }

  const tokenMatch = request.method === 'POST' && url.pathname.match(/^\/api\/projects\/([^/]+)\/deck-token$/);
  if (tokenMatch) return createDeckToken(request, env, decodeURIComponent(tokenMatch[1]), session);
  const downloadMatch = request.method === 'GET' && url.pathname.match(/^\/api\/decks\/([^/]+)$/);
  if (downloadMatch) return downloadDeck(env, ctx, decodeURIComponent(downloadMatch[1]), session);

  const proxyMatch = matchProxyRoute(request.method, url.pathname);
  if (proxyMatch) return proxy(request, env, proxyMatch, session);
  return jsonError(404, 'not_found', 'Route was not found');
}

export default {
  async fetch(request: Request, env: GatewayEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return withHeaders(await handle(request, env, ctx), request, env);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'gateway_unhandled_error',
        message: error instanceof Error ? error.message : String(error),
      }));
      return withHeaders(jsonError(500, 'internal_error', 'Unexpected gateway error'), request, env);
    }
  },
  async scheduled(_controller: ScheduledController, env: GatewayEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      await drainWebhookEvents(env);
      await cleanupExpired(env);
    })().catch((error) => {
      console.error(JSON.stringify({
        level: 'error',
        event: 'gateway_scheduled_maintenance_failed',
        message: error instanceof Error ? error.message : String(error),
      }));
    }));
  },
} satisfies ExportedHandler<GatewayEnv>;
