import { hmacSha256Base64, randomToken } from './crypto';
import type { AppsScriptResponse, GatewayEnv } from './types';

export async function createSignedEnvelope(
  secret: string,
  operation: string,
  payload: unknown,
  now = Date.now(),
): Promise<{
  timestamp: number;
  nonce: string;
  operation: string;
  payloadJson: string;
  signature: string;
}> {
  const timestamp = now;
  const nonce = randomToken(18);
  const payloadJson = JSON.stringify(payload ?? null);
  const canonical = `${timestamp}\n${nonce}\n${operation}\n${payloadJson}`;
  const signature = await hmacSha256Base64(secret, canonical);
  return { timestamp, nonce, operation, payloadJson, signature };
}

export async function callAppsScript<T>(
  env: GatewayEnv,
  operation: string,
  payload: unknown,
): Promise<AppsScriptResponse<T>> {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_SHARED_SECRET) {
    return {
      ok: false,
      error: { code: 'apps_script_not_configured', message: 'Operations backend is not configured' },
    };
  }
  const envelope = await createSignedEnvelope(env.APPS_SCRIPT_SHARED_SECRET, operation, payload);
  let response: Response;
  try {
    response = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
  } catch {
    return {
      ok: false,
      error: { code: 'apps_script_unavailable', message: 'Operations backend is unavailable' },
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: { code: 'apps_script_http_error', message: `Operations backend returned ${response.status}` },
    };
  }
  try {
    const result = await response.json<AppsScriptResponse<T>>();
    if (result?.ok === true && 'data' in result) return result;
    if (result?.ok === false && result.error?.code && result.error?.message) return result;
  } catch {
    // The caller receives one stable gateway error instead of a provider body.
  }
  return {
    ok: false,
    error: { code: 'apps_script_invalid_response', message: 'Operations backend returned an invalid response' },
  };
}
