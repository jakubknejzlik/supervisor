import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export async function checkBundle() {
  const { outputFiles, metafile } = await build({ entryPoints: ['apps/worker/src/worker.ts'], bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'], target: 'es2022', minify: true });
  const bundle = outputFiles[0].text;
  const assets = readdirSync('apps/dashboard/dist').map(name => readFileSync(`apps/dashboard/dist/${name}`, 'utf8')).join('\n');
  for (const marker of ['TEST_JWKS', 'TEST_LOCAL_ASSERTION', 'test-audience', 'test-team.cloudflareaccess.com', 'owner@example.invalid', 'workers-oauth-provider', 'BEGIN PRIVATE KEY', 'BEGIN RSA PRIVATE KEY', 'sample:welcome']) assert.ok(!(bundle + assets).includes(marker), `Forbidden bundle marker: ${marker}`);
  for (const name of Object.keys(metafile.inputs).filter(name => !name.startsWith('node_modules/'))) assert.ok(!/(?:^|\/)(?:test|tests|examples|projects|reports|live)(?:\/|$)|project-register|data\.json|data\.js/.test(name), `Private/test input in bundle: ${name}`);
  assert.deepEqual(readdirSync('apps/dashboard/dist').sort(), ['app.js', 'favicon-review.svg', 'favicon.svg', 'index.html', 'style.css']);
  mkdirSync('dist', { recursive: true }); writeFileSync('dist/worker.mjs', bundle);
  writeFileSync('dist/worker-meta.json', JSON.stringify(metafile, null, 2));
  console.log(`Production bundle OK (${Buffer.byteLength(bundle)} bytes); ${Object.keys(metafile.inputs).length} inputs; no test keys or record payload`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkBundle();
