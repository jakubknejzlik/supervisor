import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, actor } from './fixture.mjs';
import { runtime } from './runtime.mjs';

let keys, mf, base, token, client, otherKey;
beforeAll(async () => {
  keys = await fixture(); token = await keys.token();
  otherKey = (await generateKeyPair('RS256')).privateKey;
  mf = await runtime(keys.jwks); base = await mf.ready;
  client = await connect(token);
});
afterAll(async () => { await client?.close(); await mf?.dispose(); });
async function connect(assertion) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { 'Cf-Access-Jwt-Assertion': assertion } } }));
  return c;
}
async function tool(name, args, c = client) {
  const result = await c.callTool({ name, arguments: args });
  return { failed: !!result.isError, value: JSON.parse(result.content[0].text) };
}
async function create(id, patch = {}) {
  const result = await tool('upsert_record', { id, expectedRev: 0, patch });
  expect(result.failed).toBe(false); return result.value;
}
async function audit(id) { return (await tool('get_audit', { recordId: id })).value; }

describe('SQLite DO via real MCP SDK', () => {
  it('round-trips category, filters before limit, and clears to the legacy fallback without changing attribution', async () => {
    const prefix = 'synthetic:category:';
    const legacy = { agent: 'Agent A', project: 'sample', owner: 'Operator', extra: { keep: true } };
    const skipped = await create(prefix + '0', { ...legacy, category: 'Other' });
    const original = await create(prefix + '1', legacy);
    const fallback = await create(prefix + '2', { project: 'sample', owner: 'Operator' });
    expect(original.data).not.toHaveProperty('category');
    expect((await tool('list_records', { prefix, category: 'Agent A' })).value).toEqual([original]);
    const updated = (await tool('upsert_record', { id: original.id, expectedRev: original.rev, patch: { category: ' Operations ' } })).value;
    expect(updated.data).toEqual({ ...legacy, category: 'Operations' });
    expect((await tool('get_record', { id: original.id })).value).toEqual(updated);
    expect((await tool('list_records', { prefix })).value).toEqual([skipped, updated, fallback]);
    expect((await tool('list_records', { prefix, category: ' Operations ', limit: 1 })).value).toEqual([updated]);
    expect((await tool('list_records', { prefix, category: 'operations' })).value).toEqual([]);
    const cleared = (await tool('upsert_record', { id: original.id, expectedRev: updated.rev, patch: { category: null } })).value;
    expect(cleared.data).toEqual({ ...legacy, category: null });
    expect((await tool('get_record', { id: original.id })).value).toEqual(cleared);
    expect((await tool('list_records', { prefix, category: 'Operations' })).value).toEqual([]);
    expect((await tool('list_records', { prefix, category: 'Agent A' })).value).toEqual([cleared]);
    expect((await tool('list_records', { prefix, category: 'sample' })).value).toEqual([fallback]);
    const projectCategory = (await tool('upsert_record', { id: fallback.id, expectedRev: 1, patch: { category: 'Operations' } })).value;
    expect(projectCategory.data).toEqual({ ...fallback.data, category: 'Operations' });
    const projectCleared = (await tool('upsert_record', { id: fallback.id, expectedRev: 2, patch: { category: null } })).value;
    expect((await tool('list_records', { prefix, category: 'sample' })).value).toEqual([projectCleared]);
    const preserved = (await tool('upsert_record', { id: original.id, expectedRev: cleared.rev, patch: { status: 'Updated' } })).value;
    expect(preserved.data).toEqual({ ...legacy, category: null, status: 'Updated' });
    expect((await audit(original.id))[1].changedFields).toEqual(['data.category', 'rev', 'updatedAt']);
  });
  it('rejects invalid category writes and list filters at the MCP boundary without mutation', async () => {
    const id = 'synthetic:category-validation';
    const original = await create(id, { agent: 'Agent A', owner: 'Operator', category: 'a'.repeat(64) });
    for (const category of ['', '   ', 'a'.repeat(65), '\tCategory', 'Category\n', 'A\u0000B', 'A\u007fB', 42, false, {}, []]) {
      expect((await client.callTool({ name: 'upsert_record', arguments: { id, expectedRev: 1, patch: { category } } })).isError).toBe(true);
      expect((await client.callTool({ name: 'list_records', arguments: { category } })).isError).toBe(true);
    }
    expect((await client.callTool({ name: 'list_records', arguments: { category: null } })).isError).toBe(true);
    expect((await tool('get_record', { id })).value).toEqual(original);
    expect(await audit(id)).toHaveLength(1);
    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'list_records').inputSchema.properties).toHaveProperty('category');
    expect(tools.find(t => t.name === 'upsert_record').inputSchema.properties.patch.properties).toHaveProperty('category');
  });
  it('requires expectedRev 0 for a new record and reports current rev without writing', async () => {
    const id = 'synthetic:new';
    expect(await tool('upsert_record', { id, expectedRev: 4, patch: {} })).toEqual({ failed: true, value: { error: 'rev_conflict', currentRev: 0 } });
    expect(await audit(id)).toEqual([]);
    expect(await create(id, { name: 'New' })).toMatchObject({ id, data: { name: 'New' }, rev: 1, checkedAt: null });
  });
  it('rejects stale revisions, preserves data and appends no failure audit', async () => {
    const id = 'synthetic:conflict'; await create(id, { keep: true });
    expect(await tool('upsert_record', { id, expectedRev: 0, patch: { keep: false } })).toEqual({ failed: true, value: { error: 'rev_conflict', currentRev: 1 } });
    expect((await tool('get_record', { id })).value.data.keep).toBe(true);
    expect(await audit(id)).toHaveLength(1);
  });
  it('serializes concurrent updates: exactly one winner and one audit', async () => {
    const id = 'synthetic:race'; await create(id);
    const results = await Promise.all([1, 2].map(n => tool('upsert_record', { id, expectedRev: 1, patch: { n } })));
    expect(results.filter(r => !r.failed)).toHaveLength(1);
    expect(results.find(r => r.failed).value).toEqual({ error: 'rev_conflict', currentRev: 2 });
    expect(await audit(id)).toHaveLength(2);
  });
  it('explicit check sets checkedAt, lastCheck and rev; upsert preserves checkedAt and shallow merges', async () => {
    const id = 'synthetic:check'; await create(id, { preserved: 1, nested: { a: 1, b: 2 } });
    const checked = (await tool('check_record', { id, expectedRev: 1, result: 'passed', source: 'slack', sourceRef: 'https://example.invalid/thread', claimedAt: '2026-01-01T12:00:00+01:00', evidence: ['test evidence'] })).value;
    expect(checked.rev).toBe(2); expect(Date.parse(checked.checkedAt)).not.toBeNaN();
    expect(checked.data.lastCheck).toEqual({ result: 'passed', source: 'slack', sourceRef: 'https://example.invalid/thread', claimedAt: '2026-01-01T12:00:00+01:00', evidence: ['test evidence'], recordedAt: checked.checkedAt, actor, clientId: null });
    const updated = (await tool('upsert_record', { id, expectedRev: 2, patch: { nested: { a: 3 } } })).value;
    expect(updated.checkedAt).toBe(checked.checkedAt); expect(updated.rev).toBe(3);
    expect(updated.data.lastCheck).toEqual(checked.data.lastCheck);
    expect(updated.data).toMatchObject({ preserved: 1, nested: { a: 3 } });
    expect(updated.data.nested.b).toBeUndefined();
    expect(await tool('check_record', { id, expectedRev: 1, result: 'stale', source: 'manual' })).toEqual({ failed: true, value: { error: 'rev_conflict', currentRev: 3 } });
    const rows = await audit(id);
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.actor === actor)).toBe(true);
    expect(rows.map(r => [r.fromRev, r.toRev])).toEqual([[2, 3], [1, 2], [0, 1]]);
    expect(rows[1]).toMatchObject({ source: 'slack', actor, clientId: null, at: checked.checkedAt });
    expect(rows[1].changedFields).toContain('checkedAt');
    expect(rows[0].changedFields).not.toContain('checkedAt');
  });
  it('rejects checkedAt in any upsert, including null and new records', async () => {
    for (const checkedAt of [null, '2026-01-01T00:00:00Z']) {
      expect((await tool('upsert_record', { id: 'synthetic:forbidden-check', expectedRev: 0, patch: { checkedAt } })).value.error).toBe('checkedAt_requires_check_tool');
    }
    expect(await audit('synthetic:forbidden-check')).toEqual([]);
  });
  it.each(['checkedAt', 'lastCheck'])('rejects upsert patch %s and preserves checkedAt, lastCheck, revision and audit', async field => {
    const id = `synthetic:protected-${field}`; await create(id);
    const checked = (await tool('check_record', { id, expectedRev: 1, result: 'claimed', source: 'api' })).value;
    for (const value of [null, 'spoofed', { actor: 'spoofed', recordedAt: '2000-01-01T00:00:00Z' }]) {
      expect(await tool('upsert_record', { id, expectedRev: 2, patch: { [field]: value } })).toEqual({ failed: true, value: { error: 'checkedAt_requires_check_tool' } });
      expect((await tool('get_record', { id })).value).toEqual(checked);
      expect(await audit(id)).toHaveLength(2);
    }
    expect((await tool('upsert_record', { id: `${id}-new`, expectedRev: 0, patch: { [field]: null } })).value.error).toBe('checkedAt_requires_check_tool');
    expect(await audit(`${id}-new`)).toEqual([]);
  });
  it('rejects client-supplied clientId in tool args; verified identity audit records null', async () => {
    const id = 'synthetic:client-id'; await create(id);
    const args = { id, expectedRev: 1, result: 'claimed', source: 'github' };
    const rejected = await client.callTool({ name: 'check_record', arguments: { ...args, clientId: 'spoofed-client' } });
    expect(rejected.isError).toBe(true);
    expect(await audit(id)).toHaveLength(1);
    // Even unrecognized signed claim names and other headers cannot substitute
    // for a documented Managed OAuth client-id claim.
    const c = new Client({ name: 'spoofed-client', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: {
      'Cf-Access-Jwt-Assertion': await keys.token({ client_id: 'unproven-claim', azp: 'unproven-claim' }),
      'X-Client-Id': 'spoofed-header', 'CF-Access-Client-Id': 'spoofed-service-token',
    } } }));
    try {
      const checked = (await tool('check_record', args, c)).value;
      expect(checked.data.lastCheck).toMatchObject({ actor, source: 'github', clientId: null });
      expect(await audit(id)).toHaveLength(2);
      expect((await audit(id))[0]).toMatchObject({ actor, source: 'github', clientId: null });
    } finally { await c.close(); }
  });
  it('requires a source enum and ISO claimedAt; invalid claims do not write', async () => {
    const id = 'synthetic:invalid-claim'; await create(id);
    for (const extra of [{}, { source: 'browser' }, { source: 'api', claimedAt: 'yesterday' }]) {
      const result = await client.callTool({ name: 'check_record', arguments: { id, expectedRev: 1, result: 'claimed', ...extra } });
      expect(result.isError).toBe(true);
    }
    expect(await audit(id)).toHaveLength(1);
    expect((await tool('get_record', { id })).value.checkedAt).toBeNull();
  });
  it('check cannot create a record', async () => {
    expect((await tool('check_record', { id: 'synthetic:missing', expectedRev: 0, result: 'x', source: 'manual' })).value.error).toBe('record_not_found');
  });
  it('enforces read-only identity capabilities; JWT scope claims cannot escalate', async () => {
    const reader = await connect(await keys.token({ email: 'reader@example.invalid', scope: 'supervisor:read supervisor:write' }));
    try {
      expect((await tool('list_records', {}, reader)).failed).toBe(false);
      for (const [name, extra] of [['upsert_record', { patch: {} }], ['check_record', { result: 'x', source: 'manual' }]]) {
        expect((await tool(name, { id: 'synthetic:reader', expectedRev: 0, ...extra }, reader)).value.error).toBe('insufficient_scope');
      }
      expect(await audit('synthetic:reader')).toEqual([]);
    } finally { await reader.close(); }
  });
  it('discovers JSON Schemas and annotations for all five tools; no delete', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['check_record', 'get_audit', 'get_record', 'list_records', 'upsert_record']);
    for (const t of tools) {
      const write = ['upsert_record', 'check_record'].includes(t.name);
      expect(t.annotations).toMatchObject({ readOnlyHint: !write, destructiveHint: false, idempotentHint: !write, openWorldHint: false });
      expect(t.inputSchema.type).toBe('object');
      if (write) expect(t.inputSchema.required).toContain('expectedRev');
    }
  });
  it('literal prefix + limit filtering and dashboard data show synthetic rows live', async () => {
    await create('synthetic:percent%'); await create('synthetic:percent-other');
    const listed = (await tool('list_records', { prefix: 'synthetic:percent%', limit: 1 })).value;
    expect(listed.map(r => r.id)).toEqual(['synthetic:percent%']);
    await create('synthetic:💡-unicode');
    expect((await tool('list_records', { prefix: 'synthetic:💡' })).value.map(r => r.id)).toEqual(['synthetic:💡-unicode']);
    const data = await fetch(new URL('/api/data.json', base), { headers: { 'Cf-Access-Jwt-Assertion': token } }).then(r => r.json());
    expect(data.schemaVersion).toBe(1);
    expect(data.records.find(r => r.id === 'synthetic:check')).toMatchObject({ rev: 3, evidenceType: 'client_claim', independentFunctionalTest: false, stateLabel: `Checked — claimed by ${actor} via slack`, lastCheck: { actor, source: 'slack', clientId: null } });
    expect(data.records.every(r => r.id.startsWith('synthetic:'))).toBe(true);
    const html = await fetch(base, { headers: { 'Cf-Access-Jwt-Assertion': token } }).then(r => r.text());
    expect(html).toContain('name="supervisor-data-url" content="/api/data.json"');
    expect(html).not.toContain('src="./data.js"');
  });
});

describe.each(['/mcp', '/api/data.json'])('Access JWT validation on %s', path => {
  async function request(assertion, rpc) {
    return fetch(new URL(path, base), { method: path === '/mcp' ? 'POST' : 'GET', headers: {
      ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}),
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, ...(path === '/mcp' ? { body: JSON.stringify(rpc ?? { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jwt-test', version: '1' } } }) } : {}) });
  }
  it('accepts a valid assertion', async () => { expect((await request(token)).status).toBe(200); });
  it('rejects unauthenticated and non-allowlisted identity on read tools, write tools and data API', async () => {
    for (const assertion of [undefined, await keys.token({ email: 'stranger@example.invalid' })]) {
      for (const [name, args] of [
        ['list_records', {}], ['get_record', { id: 'synthetic:check' }], ['get_audit', {}],
        ['upsert_record', { id: 'synthetic:stranger', expectedRev: 0, patch: {} }],
        ['check_record', { id: 'synthetic:check', expectedRev: 3, result: 'spoofed', source: 'manual' }],
      ]) {
        const response = await request(assertion, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
        expect(response.status).toBe(assertion ? 403 : 401);
        expect(await response.json()).toEqual({ error: 'forbidden' });
      }
    }
    expect(await audit('synthetic:stranger')).toEqual([]);
    expect((await tool('get_record', { id: 'synthetic:check' })).value.rev).toBe(3);
  });

  for (const [name, overrides] of [
    ['wrong aud', { aud: 'wrong' }], ['wrong issuer', { iss: 'https://wrong.cloudflareaccess.com' }],
    ['expired', { exp: 1 }], ['not yet valid', { nbf: 9999999999 }],
    ['missing subject', { sub: undefined }], ['empty subject', { sub: '' }], ['blank subject', { sub: ' ' }],
    ['service assertion', { common_name: 'synthetic-service.access', sub: '', email: undefined }],
    ['invalid email', { email: 'invalid' }],
    ['allow-list miss', { email: 'stranger@example.invalid' }], ['missing exp', { exp: undefined }],
  ]) {
    it(`rejects ${name} without OAuth headers`, async () => {
      const response = await request(await keys.token(overrides));
      expect(response.status).toBe(403); expect(response.headers.has('WWW-Authenticate')).toBe(false);
      expect(await response.json()).toEqual({ error: 'forbidden' });
    });
  }
  it('rejects a bad signature', async () => { expect((await request(await keys.token({}, otherKey))).status).toBe(403); });
  it('rejects unknown kid', async () => { expect((await request(await keys.token({}, undefined, 'unknown'))).status).toBe(403); });
  it('rejects missing assertion', async () => { expect((await request()).status).toBe(401); });
});

it('authenticates every asset and does not implement discovery or static data bypasses', async () => {
  for (const path of ['/', '/app.js', '/style.css', '/data.js', '/data.json', '/.well-known/oauth-authorization-server']) {
    const response = await fetch(new URL(path, base)); expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  }
});
