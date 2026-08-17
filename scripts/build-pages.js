import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = new URL('../public/', import.meta.url);
const output = new URL('../dist-pages/', import.meta.url);
const outputPath = fileURLToPath(output);
const repository = (process.env.GITHUB_REPOSITORY || '/zhifu-invest').split('/').pop();
const base = `/${repository}/`;

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

for (const file of await files(outputPath)) {
  if (extname(file) !== '.html') continue;
  const html = await readFile(file, 'utf8');
  const rewritten = html
    .replaceAll('href="/', `href="${base}`)
    .replaceAll('src="/', `src="${base}`)
    .replaceAll('LOCAL DEMO', 'GITHUB STATIC PREVIEW');
  await writeFile(file, rewritten);
}

await cp(new URL('index.html', output), new URL('404.html', output));
await writeFile(new URL('.nojekyll', output), '');
console.log(`Built static GitHub Pages preview at ${output.pathname} with base ${base}`);
