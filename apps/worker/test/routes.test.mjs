import { afterAll, beforeAll, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { fixture, issuer, actor } from './fixture.mjs';
import { runtime } from './runtime.mjs';
let keys, mf;
beforeAll(async () => {
  keys = await fixture();
  mf = await runtime(keys.jwks, { audiences: {
    'supervisor.example.com': { dashboard: ['dashboard-aud'], mcp: ['mcp-aud'] },
    'legacy.example.com': { mcp: ['legacy-aud'] },
    'dashboard.example.com': { dashboard: ['split-dashboard-aud'], mcp: ['split-dashboard-aud'] },
    'mcp.example.com': { dashboard: ['split-mcp-aud'], mcp: ['split-mcp-aud'] },
  } });
});
afterAll(async () => { await mf?.dispose(); });
async function request(path, aud, host = 'supervisor.example.com', overrides = {}, raw) {
  const token = raw ?? (aud ? await keys.token({ aud, ...overrides }) : undefined);
  return mf.dispatchFetch(`https://${host}${path}`, {
    method: path === '/mcp' ? 'POST' : 'GET',
    headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
      ...(path === '/api/ws' ? { Upgrade: 'websocket' } : {}),
      'X-Forwarded-Host': 'supervisor.example.com',
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    ...(path === '/mcp' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'route-test', version: '1' } } }) } : {}),
  });
}
it('rejects a dashboard assertion on MCP', async () => {
  expect((await request('/mcp', 'dashboard-aud')).status).toBe(403);
});
for (const path of ['/', '/api/data.json', '/api/ws', '/app.js', '/style.css', '/mcp/', '/mcp/other']) {
  it(`rejects an MCP assertion on dashboard route ${path}`, async () => {
    const response = await request(path, 'mcp-aud');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });
}
for (const [path, aud, expected] of [['/mcp', 'mcp-aud', 200], ['/', 'dashboard-aud', 200], ['/api/data.json', 'dashboard-aud', 200], ['/api/ws', 'dashboard-aud', 101], ['/app.js', 'dashboard-aud', 200]]) {
  it(`accepts the correct route AUD on ${path}`, async () => {
    const response = await request(path, aud);
    expect(response.status).toBe(expected);
    if (response.webSocket) { response.webSocket.accept(); response.webSocket.close(); }
  });
}
it('accepts legacy MCP only at the exact MCP path', async () => {
  expect((await request('/mcp', 'legacy-aud', 'legacy.example.com')).status).toBe(200);
  for (const path of ['/', '/api/data.json', '/api/ws', '/app.js', '/mcp/', '/.well-known/oauth-authorization-server']) {
    expect((await request(path, 'legacy-aud', 'legacy.example.com')).status).toBe(403);
  }
  expect((await request('/mcp', 'mcp-aud', 'legacy.example.com')).status).toBe(403);
  expect((await request('/mcp', 'legacy-aud')).status).toBe(403);
});
for (const path of ['/', '/mcp', '/api/data.json', '/api/ws']) {
  it(`preserves split host-wide audience behavior on ${path}`, async () => {
    for (const [host, aud] of [['dashboard.example.com', 'split-dashboard-aud'], ['mcp.example.com', 'split-mcp-aud']]) {
      const response = await request(path, aud, host);
      expect(response.status).toBe(path === '/api/ws' ? 101 : 200);
      if (response.webSocket) { response.webSocket.accept(); response.webSocket.close(); }
      expect((await request(path, aud === 'split-dashboard-aud' ? 'split-mcp-aud' : 'split-dashboard-aud', host)).status).toBe(403);
    }
  });
}
for (const [path, aud] of [['/mcp', 'mcp-aud'], ['/', 'dashboard-aud'], ['/api/data.json', 'dashboard-aud'], ['/api/ws', 'dashboard-aud']]) {
  it(`fails closed for missing/foreign/invalid assertions on ${path}`, async () => {
    expect((await request(path)).status).toBe(401);
    expect((await request(path, aud, 'unknown.example.com')).status).toBe(403);
    for (const overrides of [{ aud: 'foreign-aud' }, { iss: 'https://other.cloudflareaccess.com' }, { exp: 1 }, { exp: undefined }, { iat: undefined }, { email: 'stranger@example.invalid' }]) {
      expect((await request(path, aud, undefined, overrides)).status).toBe(403);
    }
    const wrongAlgorithm = await new SignJWT({ aud, iss: issuer, sub: 'test-subject', email: actor, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
    expect((await request(path, aud, undefined, {}, wrongAlgorithm)).status).toBe(403);
  });
}
for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/cloudflare-access-protected-resource', '/.well-known/cloudflare-access-protected-resource/mcp', '/.well-known/other']) {
  it(`never emits OAuth metadata at ${path}`, async () => {
    for (const [aud, status] of [['dashboard-aud', 404], ['mcp-aud', 403]]) {
      const response = await request(path, aud);
      expect(response.status).toBe(status);
      expect(response.headers.has('WWW-Authenticate')).toBe(false);
      const body = await response.text();
      for (const key of ['issuer', 'resource', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint']) expect(body).not.toContain(`"${key}"`);
    }
  });
}
