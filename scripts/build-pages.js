import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultSource = new URL('../public/', import.meta.url);
const defaultOutput = new URL('../dist-pages/', import.meta.url);

export function normalizePublicApiBaseUrl(value = '') {
  const candidate = String(value || '').trim();
  if (!candidate) return '';

  let url;
  try { url = new URL(candidate); }
  catch { throw new Error('PUBLIC_API_BASE_URL must be an absolute HTTP(S) URL'); }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PUBLIC_API_BASE_URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('PUBLIC_API_BASE_URL must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new Error('PUBLIC_API_BASE_URL must not contain a query string or fragment');
  }
  return url.href.replace(/\/$/, '');
}

export function runtimeConfigSource(publicApiBaseUrl = '') {
  const config = { API_BASE_URL: normalizePublicApiBaseUrl(publicApiBaseUrl) };
  return `window.__ZHIFU_CONFIG__ = Object.freeze(${JSON.stringify(config)});\n`;
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

function rewriteHtml(html, { base, publicApiBaseUrl }) {
  const apiRoot = publicApiBaseUrl ? `${publicApiBaseUrl}/api/` : `${base}api/`;
  const rewrittenPaths = html
    .replaceAll('href="/api/', 'href="__ZHIFU_API_HREF__')
    .replaceAll('src="/api/', 'src="__ZHIFU_API_SRC__')
    .replaceAll('href="/', `href="${base}`)
    .replaceAll('src="/', `src="${base}`)
    .replaceAll('__ZHIFU_API_HREF__', apiRoot)
    .replaceAll('__ZHIFU_API_SRC__', apiRoot)
    .replaceAll('LOCAL DEMO', publicApiBaseUrl ? 'CONNECTED SERVICE' : 'GITHUB STATIC PREVIEW');

  return rewrittenPaths.replace(
    /(^[ \t]*)(<script\b(?=[^>]*\btype=["']module["'])[^>]*>)/gm,
    (_match, indent, moduleTag) => `${indent}<script src="${base}runtime-config.js"></script>\n${indent}${moduleTag}`,
  );
}

export async function buildPages({
  source = defaultSource,
  output = defaultOutput,
  repository = (process.env.GITHUB_REPOSITORY || '/zhifu-invest').split('/').pop(),
  publicApiBaseUrl = process.env.PUBLIC_API_BASE_URL || '',
} = {}) {
  const normalizedApiBaseUrl = normalizePublicApiBaseUrl(publicApiBaseUrl);
  const base = `/${repository}/`;
  const outputPath = fileURLToPath(output);

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(source, output, { recursive: true });

  for (const file of await files(outputPath)) {
    if (extname(file) !== '.html') continue;
    const html = await readFile(file, 'utf8');
    await writeFile(file, rewriteHtml(html, { base, publicApiBaseUrl: normalizedApiBaseUrl }));
  }

  await writeFile(new URL('runtime-config.js', output), runtimeConfigSource(normalizedApiBaseUrl));
  await cp(new URL('index.html', output), new URL('404.html', output));
  await writeFile(new URL('.nojekyll', output), '');
  return { base, publicApiBaseUrl: normalizedApiBaseUrl, outputPath };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const result = await buildPages();
  const mode = result.publicApiBaseUrl ? `live API ${result.publicApiBaseUrl}` : 'static read-only preview';
  console.log(`Built GitHub Pages at ${result.outputPath} with base ${result.base} (${mode})`);
}
