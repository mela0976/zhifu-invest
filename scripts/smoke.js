const baseURL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:4173';
const healthPath = process.env.SMOKE_HEALTH_PATH || '/healthz';
const publicPaths = (process.env.SMOKE_PUBLIC_PATHS || '/,/projects,/advisors,/legal/privacy')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);

const attempts = Number(process.env.SMOKE_ATTEMPTS || 10);
const retryDelayMs = Number(process.env.SMOKE_RETRY_DELAY_MS || 500);
const publicMarker = process.env.SMOKE_PUBLIC_MARKER || '致富投資';

function target(path) {
  return new URL(path, baseURL).href;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function request(path, expectedContentType) {
  const url = target(path);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: expectedContentType === 'html' ? 'text/html' : 'application/json, text/plain;q=0.9',
          'user-agent': 'zhifu-invest-smoke/1.0',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(4_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const body = await response.text();

      if (expectedContentType === 'html') {
        if (!contentType.includes('text/html')) {
          throw new Error(`expected text/html, received ${contentType || 'no content-type'}`);
        }
        if (!/<(?:!doctype\s+html|html)[\s>]/i.test(body)) {
          throw new Error('response did not contain an HTML document');
        }
        if (!body.includes(publicMarker)) {
          throw new Error(`response did not contain the public marker ${JSON.stringify(publicMarker)}`);
        }
      } else {
        if (!contentType.includes('application/json')) {
          throw new Error(`expected application/json, received ${contentType || 'no content-type'}`);
        }
        let health;
        try {
          health = JSON.parse(body);
        } catch {
          throw new Error('health response was not valid JSON');
        }
        if (health?.ok !== true) {
          throw new Error('health response did not report ok=true');
        }
      }

      return {
        url: response.url,
        status: response.status,
        bytes: Buffer.byteLength(body),
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(retryDelayMs);
    }
  }

  throw new Error(`${url} failed after ${attempts} attempts: ${lastError?.message || lastError}`);
}

async function main() {
  const results = [];
  results.push({ name: 'health', ...(await request(healthPath, 'health')) });

  for (const path of publicPaths) {
    results.push({ name: `public ${path}`, ...(await request(path, 'html')) });
  }

  for (const result of results) {
    console.log(`PASS ${result.name} ${result.status} ${result.bytes}B ${result.url}`);
  }
  console.log(`Smoke passed: ${results.length} endpoint(s) checked at ${baseURL}`);
}

main().catch((error) => {
  console.error(`Smoke failed: ${error.message}`);
  process.exitCode = 1;
});
