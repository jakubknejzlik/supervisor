import { build } from 'esbuild';
import { translate } from '@supervisor/core/i18n';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { checkBundle } from './check-bundle.mjs';

// Only UI source is read: no register, records, environment, Git or local config.
export async function buildAssets() {
  await rm('apps/dashboard/dist', { recursive: true, force: true });
  await mkdir('apps/dashboard/dist', { recursive: true });
  const js = await build({ entryPoints: ['apps/dashboard/src/app.js'], bundle: true, format: 'iife', write: false, target: 'es2022' });
  const files: Record<string, [string, string]> = {
    'index.html': ['apps/dashboard/index.html', 'text/html; charset=utf-8'],
    'style.css': ['apps/dashboard/src/style.css', 'text/css; charset=utf-8'],
    'favicon.svg': ['apps/dashboard/public/favicon.svg', 'image/svg+xml'],
    'favicon-review.svg': ['apps/dashboard/public/favicon-review.svg', 'image/svg+xml'],
  };
  const assets: Record<string, { type: string; body: string }> = {
    '/app.js': { type: 'text/javascript; charset=utf-8', body: js.outputFiles[0].text },
  };
  for (const [name, [source, type]] of Object.entries(files)) {
    let body = await readFile(source, 'utf8');
    if (name === 'index.html') {
      body = body.replace(/<([a-z][\w-]*)([^>]*\sdata-i18n="([\w]+)"[^>]*)><\/\1>/g,
        (_match, tag, attributes, key) => `<${tag}${attributes}>${translate('en', key)}</${tag}>`);
      body = body.replace(/<[^>]+>/g, tag => tag.replace(/(content|placeholder|aria-label|title)=""(?=[^>]*data-i18n-\1="(\w+)")/g,
        (_match, attribute, key) => `${attribute}="${translate('en', key)}"`));
    }
    assets['/' + name] = { type, body };
  }
  for (const [name, { body }] of Object.entries(assets)) await writeFile('apps/dashboard/dist' + name, body);
  await mkdir('apps/worker/src/generated', { recursive: true });
  await writeFile('apps/worker/src/generated/assets.ts', `export default ${JSON.stringify(assets)} as Record<string, {type: string; body: string}>;\n`);
  console.log(`Built ${Object.keys(assets).length} UI assets; runtime data only; no record input`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildAssets();
  if (!process.argv.includes('--assets-only')) await checkBundle();
}
