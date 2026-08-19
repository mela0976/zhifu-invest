import { pathToFileURL } from 'node:url';

export const LINE_MESSAGING_API_BASE_URL = 'https://api.line.me';

const SAFE_ERRORS = Object.freeze({
  auth: 'LINE rejected access token authentication.',
  configuration: 'LINE preflight configuration is incomplete.',
  identity_mismatch: 'LINE access token belongs to a different Official Account.',
  malformed_response: 'LINE API returned a malformed response.',
  network: 'LINE API could not be reached.',
  timeout: 'LINE API request timed out.',
  upstream: 'LINE API returned an unsuccessful response.',
  internal: 'LINE preflight failed unexpectedly.',
});

export class LineMessagingPreflightError extends Error {
  constructor(kind, { status } = {}) {
    super(SAFE_ERRORS[kind] || SAFE_ERRORS.internal);
    this.name = 'LineMessagingPreflightError';
    this.kind = SAFE_ERRORS[kind] ? kind : 'internal';
    if (Number.isInteger(status)) this.status = status;
  }
}

function normalizeApiBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new LineMessagingPreflightError('configuration');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new LineMessagingPreflightError('configuration');
  }
  return url.href.replace(/\/$/, '');
}

function requiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function redactSecret(value, secret) {
  const text = String(value);
  return secret && text.includes(secret) ? text.split(secret).join('[REDACTED]') : text;
}

function safeWebhookEndpoint(value, secret) {
  if (value === '') return null;
  if (typeof value !== 'string') throw new LineMessagingPreflightError('malformed_response');

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LineMessagingPreflightError('malformed_response');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new LineMessagingPreflightError('malformed_response');
  }

  // Query strings and fragments can contain deployment secrets. They are not
  // needed to prove which HTTPS endpoint LINE has registered.
  return redactSecret(`${url.origin}${url.pathname}`, secret);
}

async function getJson(path, { accessToken, apiBaseUrl, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  let response;
  try {
    response = await fetchImpl(`${apiBaseUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new LineMessagingPreflightError('timeout');
    }
    throw new LineMessagingPreflightError('network');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new LineMessagingPreflightError('auth', { status: response.status });
  }
  if (!response.ok) {
    throw new LineMessagingPreflightError('upstream', { status: response.status });
  }

  try {
    return await response.json();
  } catch {
    throw new LineMessagingPreflightError('malformed_response');
  }
}

function parseBotInfo(body, accessToken) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new LineMessagingPreflightError('malformed_response');
  }
  const displayName = requiredString(body.displayName);
  const basicId = requiredString(body.basicId);
  if (!displayName || !basicId) throw new LineMessagingPreflightError('malformed_response');
  return {
    displayName: redactSecret(displayName, accessToken),
    basicId: redactSecret(basicId, accessToken),
  };
}

function parseWebhook(body, accessToken) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.active !== 'boolean') {
    throw new LineMessagingPreflightError('malformed_response');
  }
  const endpoint = safeWebhookEndpoint(body.endpoint, accessToken);
  if (body.active && !endpoint) throw new LineMessagingPreflightError('malformed_response');
  return { endpoint, active: body.active };
}

/**
 * Performs exactly two read-only LINE Messaging API requests. The expected
 * Basic ID is required because a valid token alone does not prove that it
 * belongs to the intended Official Account.
 */
export async function runLineMessagingPreflight({
  accessToken,
  expectedBasicId,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = LINE_MESSAGING_API_BASE_URL,
  timeoutMs = 8_000,
} = {}) {
  const token = requiredString(accessToken);
  const expected = requiredString(expectedBasicId);
  if (!token || !expected || typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LineMessagingPreflightError('configuration');
  }

  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const bot = parseBotInfo(await getJson('/v2/bot/info', {
    accessToken: token,
    apiBaseUrl: baseUrl,
    fetchImpl,
    timeoutMs,
  }), token);
  if (bot.basicId !== expected) {
    throw new LineMessagingPreflightError('identity_mismatch');
  }
  const webhook = parseWebhook(await getJson('/v2/bot/channel/webhook/endpoint', {
    accessToken: token,
    apiBaseUrl: baseUrl,
    fetchImpl,
    timeoutMs,
  }), token);

  const checks = {
    authenticated: true,
    identityMatches: true,
    webhookConfigured: Boolean(webhook.endpoint),
    webhookActive: webhook.active,
  };

  return {
    ok: Object.values(checks).every(Boolean),
    bot,
    webhook,
    checks,
  };
}

async function readMaskedToken(input, promptOutput) {
  if (!input?.isTTY || !promptOutput?.isTTY || typeof input.setRawMode !== 'function') return '';

  promptOutput.write('LINE Messaging API access token (input hidden): ');
  const wasRaw = Boolean(input.isRaw);
  input.setEncoding('utf8');
  input.setRawMode(true);
  input.resume();

  try {
    return await new Promise((resolve, reject) => {
      let token = '';
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === '\r' || character === '\n') {
            input.off('data', onData);
            resolve(token);
            return;
          }
          if (character === '\u0003') {
            input.off('data', onData);
            reject(new LineMessagingPreflightError('configuration'));
            return;
          }
          if (character === '\u007f' || character === '\b') token = token.slice(0, -1);
          else if (character >= ' ') token += character;
        }
      };
      input.on('data', onData);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    promptOutput.write('\n');
  }
}

export function safeFailureReport(error) {
  const known = error instanceof LineMessagingPreflightError;
  const kind = known ? error.kind : 'internal';
  return {
    ok: false,
    error: {
      kind,
      message: SAFE_ERRORS[kind] || SAFE_ERRORS.internal,
      ...(known && Number.isInteger(error.status) ? { status: error.status } : {}),
    },
  };
}

export async function main({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  promptOutput = process.stderr,
  fetchImpl = globalThis.fetch,
} = {}) {
  let accessToken = requiredString(env.LINE_MESSAGING_ACCESS_TOKEN) || '';

  try {
    if (!accessToken) accessToken = await readMaskedToken(input, promptOutput);
    const report = await runLineMessagingPreflight({
      accessToken,
      expectedBasicId: env.LINE_MESSAGING_EXPECTED_BASIC_ID,
      fetchImpl,
      apiBaseUrl: env.LINE_MESSAGING_API_BASE_URL || LINE_MESSAGING_API_BASE_URL,
      timeoutMs: Number(env.LINE_MESSAGING_PREFLIGHT_TIMEOUT_MS || 8_000),
    });
    output.write(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    const report = safeFailureReport(error);
    const serialized = JSON.stringify(report);
    output.write(`${accessToken ? serialized.split(accessToken).join('[REDACTED]') : serialized}\n`);
    return 1;
  } finally {
    accessToken = '';
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) process.exitCode = await main();
