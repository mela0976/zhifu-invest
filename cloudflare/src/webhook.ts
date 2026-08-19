import { callAppsScript } from './apps-script';
import type { GatewayEnv } from './types';

const MAX_WEBHOOK_ATTEMPTS = 3;
const WEBHOOK_BATCH_SIZE = 25;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const RETRY_BASE_MS = 5 * 60 * 1000;

export type LineWebhookEvent = {
  webhookEventId?: string;
  type?: string;
  timestamp?: number;
  mode?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: { id?: string; type?: string; text?: string };
  postback?: { data?: string };
};

export type LineWebhookPayload = {
  events?: unknown;
  destination?: unknown;
};

type StoredWebhookEvent = {
  webhook_event_id: string;
  payload_json: string;
  destination: string | null;
  received_at: number;
  attempts: number;
};

function limitedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function isLineWebhookEvent(value: unknown): value is LineWebhookEvent {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function minimalLineEvent(event: LineWebhookEvent) {
  return {
    webhookEventId: limitedString(event.webhookEventId, 256) || '',
    type: limitedString(event.type, 40) || 'unknown',
    source: event.source ? {
      type: limitedString(event.source.type, 40),
      userId: limitedString(event.source.userId, 256),
      groupId: limitedString(event.source.groupId, 256),
      roomId: limitedString(event.source.roomId, 256),
    } : null,
  };
}

type MinimalLineEvent = ReturnType<typeof minimalLineEvent>;

function isMinimalLineEvent(value: unknown): value is MinimalLineEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.webhookEventId !== 'string' || typeof record.type !== 'string') return false;
  if (record.source === null) return true;
  if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) return false;
  const source = record.source as Record<string, unknown>;
  return ['type', 'userId', 'groupId', 'roomId'].every((key) => (
    source[key] === null || typeof source[key] === 'string'
  ));
}

async function persistWebhookEvents(env: GatewayEnv, payload: LineWebhookPayload): Promise<void> {
  const receivedAt = Date.now();
  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const candidate of events) {
    if (!isLineWebhookEvent(candidate)) continue;
    const event = candidate;
    const eventId = limitedString(event.webhookEventId, 256);
    if (!eventId) continue;
    const minimal = minimalLineEvent(event);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO webhook_events (
         webhook_event_id, event_type, received_at, destination, payload_json,
         status, next_attempt_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?3, ?3)`,
    ).bind(
      eventId,
      limitedString(event.type, 40) || 'unknown',
      receivedAt,
      limitedString(payload.destination, 256),
      JSON.stringify(minimal),
    ).run();
  }
}

async function claimWebhookEvent(
  env: GatewayEnv,
  row: StoredWebhookEvent,
  now: number,
): Promise<boolean> {
  const claimed = await env.DB.prepare(
    `UPDATE webhook_events
        SET status = 'processing', next_attempt_at = ?1, updated_at = ?2
      WHERE webhook_event_id = ?3
        AND attempts < ?4
        AND next_attempt_at <= ?2
        AND status IN ('pending', 'retry', 'processing')`,
  ).bind(now + PROCESSING_LEASE_MS, now, row.webhook_event_id, MAX_WEBHOOK_ATTEMPTS).run();
  return claimed.meta.changes === 1;
}

async function markMalformedPayload(env: GatewayEnv, eventId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_events
        SET attempts = ?1, status = 'failed', next_attempt_at = NULL,
            last_error = 'stored_payload_invalid', updated_at = ?2
      WHERE webhook_event_id = ?3 AND status = 'processing'`,
  ).bind(MAX_WEBHOOK_ATTEMPTS, now, eventId).run();
}

async function forwardWebhookEvent(env: GatewayEnv, row: StoredWebhookEvent): Promise<void> {
  const now = Date.now();
  let event: MinimalLineEvent;
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (!isMinimalLineEvent(parsed)) {
      await markMalformedPayload(env, row.webhook_event_id, now);
      return;
    }
    event = parsed;
  } catch {
    await markMalformedPayload(env, row.webhook_event_id, now);
    return;
  }

  const result = await callAppsScript(env, 'webhookEvent', {
    context: {
      role: 'service',
      actorId: 'cloudflare-line-webhook',
      requestId: row.webhook_event_id,
    },
    destination: row.destination,
    event: {
      ...event,
      lineUserId: event.source?.userId || null,
    },
    receivedAt: row.received_at,
  });

  const attempt = row.attempts + 1;
  const delivered = result.ok;
  const exhausted = !delivered && attempt >= MAX_WEBHOOK_ATTEMPTS;
  const nextAttemptAt = delivered || exhausted ? null : now + RETRY_BASE_MS * attempt;
  const lastError = delivered ? null : `${result.error.code}: ${result.error.message}`.slice(0, 1000);
  await env.DB.prepare(
    `UPDATE webhook_events
        SET attempts = ?1, status = ?2, next_attempt_at = ?3,
            forwarded_at = ?4, last_error = ?5, updated_at = ?6
      WHERE webhook_event_id = ?7 AND status = 'processing' AND attempts = ?8`,
  ).bind(
    attempt,
    delivered ? 'delivered' : exhausted ? 'failed' : 'retry',
    nextAttemptAt,
    delivered ? now : null,
    lastError,
    now,
    row.webhook_event_id,
    row.attempts,
  ).run();

  if (!delivered) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'line_webhook_forward_failed',
      webhookEventId: row.webhook_event_id,
      attempt,
      exhausted,
      code: result.error.code,
    }));
  }
}

export async function drainWebhookEvents(env: GatewayEnv): Promise<void> {
  const now = Date.now();
  const candidates = await env.DB.prepare(
    `SELECT webhook_event_id, payload_json, destination, received_at, attempts
       FROM webhook_events
      WHERE payload_json IS NOT NULL
        AND attempts < ?1
        AND next_attempt_at <= ?2
        AND status IN ('pending', 'retry', 'processing')
      ORDER BY next_attempt_at ASC, received_at ASC
      LIMIT ?3`,
  ).bind(MAX_WEBHOOK_ATTEMPTS, now, WEBHOOK_BATCH_SIZE).all<StoredWebhookEvent>();

  let processed = 0;
  for (const row of candidates.results) {
    if (!await claimWebhookEvent(env, row, now)) continue;
    await forwardWebhookEvent(env, row);
    processed += 1;
  }
  if (processed > 0) {
    console.log(JSON.stringify({ level: 'info', event: 'line_webhook_drain', processed }));
  }
}

export async function enqueueWebhookEvents(env: GatewayEnv, payload: LineWebhookPayload): Promise<void> {
  await persistWebhookEvents(env, payload);
}
