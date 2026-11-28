import { watch } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildAssets } from './build';
import { fixture } from '../apps/worker/test/fixture.mjs';
import { runtime } from '../apps/worker/test/runtime.mjs';
import { schemas } from '@supervisor/core/schema';

const smoke = process.argv.includes('--smoke');
const keys = await fixture();
const audiences = { dashboard: ['local-dashboard'], mcp: ['local-mcp'] };
const assertions = Object.fromEntries(await Promise.all(Object.entries(audiences).map(async ([kind, aud]) => [
  kind, await keys.token({ aud, exp: Math.floor(Date.now() / 1000) + 86400 }),
])));
await mkdir('.local/dev', { recursive: true });
let mf!: Awaited<ReturnType<typeof runtime>>;
async function start() {
  await buildAssets();
  mf = await runtime(keys.jwks, { port: smoke ? 0 : 8787, persist: resolve('.local/dev'), audiences: { '127.0.0.1': audiences, localhost: audiences }, extraBindings: { TEST_LOCAL_ASSERTION: JSON.stringify(assertions) } });
  return await mf.ready;
}
const url = await start();
try {
  if (process.argv.includes('--sample')) {
    const records = JSON.parse(await readFile('examples/sample-records.json', 'utf8'));
    for (const record of records) {
      const args = schemas.upsert_record.parse(record);
      const response = await mf.dispatchFetch(new URL('/mcp', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upsert_record', arguments: args } }) });
      const result = await response.json() as { result?: { isError?: boolean }; error?: unknown };
      if (response.status !== 200 || result.error || !result.result || result.result.isError) throw new Error('Local sample seed failed (check the existing record revision)');
    }
  }
} catch (error) { await mf.dispose(); throw error; }
console.log(`Local dashboard: ${url} (synthetic identity, local SQLite only)`);
if (smoke) {
  try {
    for (const path of ['/', '/app.js', '/api/data.json']) {
      const response = await mf.dispatchFetch(new URL(path, url));
      if (response.status !== 200) throw new Error(`Local smoke failed: ${path} ${response.status}`);
    }
    const ws = await mf.dispatchFetch(new URL('/api/ws', url), { headers: { Upgrade: 'websocket' } });
    if (ws.status !== 101) throw new Error('Local WebSocket smoke failed');
    ws.webSocket!.accept(); ws.webSocket!.close();
    console.log('Local dev smoke OK: UI, authenticated data and WebSocket');
  } finally { await mf.dispose(); }
} else {
  let pending: ReturnType<typeof setTimeout>;
  let restarting = false;
  for (const dir of ['apps/dashboard', 'apps/dashboard/src', 'apps/dashboard/public', 'apps/worker/src', 'packages/core/src', 'packages/core/src/locales']) {
    watch(dir, (_event, name) => {
      if (name?.startsWith('generated') || (dir === 'apps/dashboard' && name !== 'index.html')) return;
      clearTimeout(pending);
      pending = setTimeout(async () => {
        if (restarting) return;
        restarting = true;
        try { await mf.dispose(); await start(); console.log('Reloaded local sources; refresh the browser'); }
        catch { console.error('Local rebuild failed'); }
        finally { restarting = false; }
      }, 150);
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await mf.dispose(); process.exit(0); });
}
