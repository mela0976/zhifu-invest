import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LineMessagingPreflightError,
  main,
  runLineMessagingPreflight,
} from '../scripts/line-messaging-preflight.js';

const TOKEN = 'test-token-that-must-never-be-reported';
const EXPECTED_BASIC_ID = '@zhifu-test';
const API_BASE_URL = 'https://line.test';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function captureOutput() {
  let value = '';
  return {
    stream: { write(chunk) { value += chunk; } },
    value: () => value,
  };
}

test('preflight reads bot identity and active webhook without mutating LINE state', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v2/bot/info')) {
      return jsonResponse({
        displayName: '致富投資測試帳號',
        basicId: EXPECTED_BASIC_ID,
        ignoredUnknownField: `must-not-leak-${TOKEN}`,
      });
    }
    return jsonResponse({
      endpoint: 'https://api.example.com/line/webhook?private=must-not-be-reported',
      active: true,
      ignoredUnknownField: TOKEN,
    });
  };

  const report = await runLineMessagingPreflight({
    accessToken: TOKEN,
    expectedBasicId: EXPECTED_BASIC_ID,
    apiBaseUrl: API_BASE_URL,
    fetchImpl,
  });

  assert.deepEqual(report, {
    ok: true,
    bot: { displayName: '致富投資測試帳號', basicId: EXPECTED_BASIC_ID },
    webhook: { endpoint: 'https://api.example.com/line/webhook', active: true },
    checks: {
      authenticated: true,
      identityMatches: true,
      webhookConfigured: true,
      webhookActive: true,
    },
  });
  assert.deepEqual(calls.map(({ url, options }) => ({
    url,
    method: options.method,
    authorization: options.headers.authorization,
  })), [
    { url: `${API_BASE_URL}/v2/bot/info`, method: 'GET', authorization: `Bearer ${TOKEN}` },
    { url: `${API_BASE_URL}/v2/bot/channel/webhook/endpoint`, method: 'GET', authorization: `Bearer ${TOKEN}` },
  ]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(TOKEN));
});

test('401 is classified as authentication failure without leaking token or response body', async () => {
  const output = captureOutput();
  const exitCode = await main({
    env: {
      LINE_MESSAGING_ACCESS_TOKEN: TOKEN,
      LINE_MESSAGING_EXPECTED_BASIC_ID: EXPECTED_BASIC_ID,
      LINE_MESSAGING_API_BASE_URL: API_BASE_URL,
    },
    output: output.stream,
    fetchImpl: async () => jsonResponse({ message: `invalid ${TOKEN}` }, 401),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(output.value()), {
    ok: false,
    error: {
      kind: 'auth',
      message: 'LINE rejected access token authentication.',
      status: 401,
    },
  });
  assert.doesNotMatch(output.value(), new RegExp(TOKEN));
});

test('a token for another Official Account fails before webhook details are queried', async () => {
  const calls = [];
  const output = captureOutput();
  const exitCode = await main({
    env: {
      LINE_MESSAGING_ACCESS_TOKEN: TOKEN,
      LINE_MESSAGING_EXPECTED_BASIC_ID: EXPECTED_BASIC_ID,
      LINE_MESSAGING_API_BASE_URL: API_BASE_URL,
    },
    output: output.stream,
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ displayName: '其他官方帳號', basicId: '@another-account' });
    },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, [`${API_BASE_URL}/v2/bot/info`]);
  assert.deepEqual(JSON.parse(output.value()), {
    ok: false,
    error: {
      kind: 'identity_mismatch',
      message: 'LINE access token belongs to a different Official Account.',
    },
  });
  assert.doesNotMatch(output.value(), /another-account/);
  assert.doesNotMatch(output.value(), new RegExp(TOKEN));
});

test('timeout and network failures have distinct safe classifications', async (t) => {
  await t.test('timeout', async () => {
    await assert.rejects(
      runLineMessagingPreflight({
        accessToken: TOKEN,
        expectedBasicId: EXPECTED_BASIC_ID,
        apiBaseUrl: API_BASE_URL,
        fetchImpl: async () => { throw new DOMException(`timed out ${TOKEN}`, 'AbortError'); },
      }),
      (error) => {
        assert.ok(error instanceof LineMessagingPreflightError);
        assert.equal(error.kind, 'timeout');
        assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(TOKEN));
        return true;
      },
    );
  });

  await t.test('network', async () => {
    await assert.rejects(
      runLineMessagingPreflight({
        accessToken: TOKEN,
        expectedBasicId: EXPECTED_BASIC_ID,
        apiBaseUrl: API_BASE_URL,
        fetchImpl: async () => { throw new Error(`socket failure ${TOKEN}`); },
      }),
      (error) => {
        assert.ok(error instanceof LineMessagingPreflightError);
        assert.equal(error.kind, 'network');
        assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(TOKEN));
        return true;
      },
    );
  });
});

test('malformed JSON is reported without exposing parser details', async () => {
  const response = {
    ok: true,
    status: 200,
    async json() { throw new SyntaxError(`unexpected token ${TOKEN}`); },
  };

  await assert.rejects(
    runLineMessagingPreflight({
      accessToken: TOKEN,
      expectedBasicId: EXPECTED_BASIC_ID,
      apiBaseUrl: API_BASE_URL,
      fetchImpl: async () => response,
    }),
    (error) => {
      assert.equal(error.kind, 'malformed_response');
      assert.equal(error.message, 'LINE API returned a malformed response.');
      assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(TOKEN));
      return true;
    },
  );
});

test('webhook not configured is a completed read-only check that fails preflight', async () => {
  let call = 0;
  const report = await runLineMessagingPreflight({
    accessToken: TOKEN,
    expectedBasicId: EXPECTED_BASIC_ID,
    apiBaseUrl: API_BASE_URL,
    fetchImpl: async () => {
      call += 1;
      return call === 1
        ? jsonResponse({ displayName: '致富投資', basicId: EXPECTED_BASIC_ID })
        : jsonResponse({ endpoint: '', active: false });
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.webhook, { endpoint: null, active: false });
  assert.deepEqual(report.checks, {
    authenticated: true,
    identityMatches: true,
    webhookConfigured: false,
    webhookActive: false,
  });
});
