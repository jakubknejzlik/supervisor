import { expect, it } from 'vitest';
import { fixture } from '../../apps/worker/test/fixture.mjs';
import { runtime } from '../../apps/worker/test/runtime.mjs';
it('starts a new SQLite namespace with no records, checks or audit entries', async () => {
  const keys = await fixture();
  const mf = await runtime(keys.jwks);
  try {
    const headers = { 'Cf-Access-Jwt-Assertion': await keys.token() };
    const response = await mf.dispatchFetch('http://127.0.0.1/api/data.json', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 0, records: [] });
    const audit = await mf.dispatchFetch('http://127.0.0.1/mcp', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_audit', arguments: {} } }),
    }).then(response => response.json());
    expect(audit.result.isError).not.toBe(true);
    expect(JSON.parse(audit.result.content[0].text)).toEqual([]);
  } finally { await mf.dispose(); }
});
