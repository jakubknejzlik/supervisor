import { expect, it } from 'vitest';
import { machineRequest, runRemote } from '../../../scripts/e2e-remote.mjs';

it.each(['/mcp', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/register', '/token', '/api/data.json'])('remote machine guard rejects HTML and redirects on %s', async path => {
  for (const response of [
    new Response(null, { status: 302, headers: { Location: 'https://test.cloudflareaccess.com/login' } }),
    new Response('<html>Login</html>', { status: 401, headers: { 'Content-Type': 'text/html' } }),
    new Response('<!doctype html><html>Login</html>', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ]) {
    await expect(machineRequest(async () => response, `https://mcp.example.com${path}`)).rejects.toThrow();
  }
  const response = await machineRequest(async () => Response.json({ error: 'unauthorized' }, { status: 401 }), path);
  expect(response.status).toBe(401);
});

it('remote smoke probes machine discovery, registration, token and data; allows browser redirects without probing authorize/callback', async () => {
  const seen = [];
  const base = 'https://mcp.example.com';
  await runRemote(base, async (url, options) => {
    const path = new URL(url).pathname;
    seen.push(new URL(url).pathname + new URL(url).search);
    expect(options.redirect).toBe('manual');
    if (options.headers.Accept.includes('text/html')) return new Response(null, { status: 302, headers: { Location: 'https://test.cloudflareaccess.com/authorize' } });
    if (path === '/mcp') return Response.json({ error: 'unauthorized' }, { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } });
    if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, registration_endpoint: `${base}/register`, token_endpoint: `${base}/token` });
    if (path === '/.well-known/oauth-protected-resource') return Response.json({ resource: base });
    if (path === '/api/data.json') return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (path === '/register') return Response.json({ client_id: 'harmless-smoke-client' }, { status: 201 });
    if (path === '/token') return Response.json({ error: 'invalid_grant' }, { status: 400 });
    throw new Error(`Unexpected machine path ${path}`);
  }, () => {});
  expect(seen).toContain('/token'); expect(seen).toContain('/register');
  expect(seen).toContain('/?record=sample-a%3Aaccess-boundary');
  expect(seen).not.toContain('/authorize'); expect(seen).not.toContain('/callback');
});
