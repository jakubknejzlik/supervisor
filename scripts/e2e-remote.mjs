import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Apply only to machine endpoints. /authorize and /callback are interactive
// OAuth routes and MAY redirect to the IdP/consent screen; do not probe them
// with this assertion or treat their 302 as a machine-endpoint failure.
export async function machineRequest(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, redirect: 'manual' });
  assert.ok(response.status < 300 || response.status >= 400, `${url}: machine endpoint must not redirect (${response.status})`);
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.clone().text();
  assert.ok(!/html/i.test(contentType) && !/<(?:!doctype\s+html|html)\b/i.test(body), `${url}: machine endpoint must not return HTML`);
  assert.ok(contentType.includes('application/json') || /application\/[^;]+\+json/.test(contentType), `${url}: expected JSON`);
  await response.clone().json();
  return response;
}

export async function runRemote(baseUrl, fetchImpl = fetch, log = console.log) {
  const base = new URL(baseUrl);
  assert.equal(base.protocol, 'https:', 'An explicit HTTPS sample-account endpoint is required');
  assert.ok(!base.username && !base.password);
  const response = await machineRequest(fetchImpl, new URL('/mcp', base), {
    method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unauthenticated-test', version: '1' } } }),
  });
  assert.equal(response.status, 401);
  const challenge = response.headers.get('www-authenticate'); assert.ok(challenge);
  log(`POST /mcp → 401 JSON; WWW-Authenticate: ${challenge}`);
  const machineHeaders = { Accept: 'application/json', 'User-Agent': 'Supervisor-MCP-Machine-Test/1' };
  function trustedEndpoint(value) {
    const url = new URL(value);
    assert.equal(url.protocol, 'https:');
    assert.ok(url.origin === base.origin || url.hostname.endsWith('.cloudflareaccess.com'));
    return url;
  }
  const metadataResponse = await machineRequest(fetchImpl, new URL('/.well-known/oauth-authorization-server', base), { headers: machineHeaders });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    assert.ok(metadata[field], `Missing ${field}`);
    log(`${field}: ${trustedEndpoint(metadata[field]).href}`);
  }
  // Also test protected-resource discovery when advertised, without guessing
  // a path that the actual Managed OAuth challenge does not publish.
  const resourceMetadata = challenge.match(/\bresource_metadata="([^"]+)"/i)?.[1];
  if (resourceMetadata) {
    const resource = await machineRequest(fetchImpl, trustedEndpoint(resourceMetadata), { headers: machineHeaders });
    assert.equal(resource.status, 200);
    log('Advertised protected-resource metadata → 200 JSON');
  }
  const data = await machineRequest(fetchImpl, new URL('/api/data.json', base), { headers: machineHeaders });
  assert.equal(data.status, 401);
  log('Machine GET /api/data.json → 401 JSON');
  const registration = await machineRequest(fetchImpl, metadata.registration_endpoint, {
    method: 'POST', headers: { ...machineHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Supervisor prototype unauthenticated DCR test', redirect_uris: ['http://127.0.0.1:8788/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  assert.ok(registration.status === 200 || registration.status === 201, `DCR failed: ${registration.status}`);
  const registered = await registration.json(); assert.ok(registered.client_id);
  log(`DCR OK; client_id: ${registered.client_id}; no authorization or valid tokens requested`);
  const token = await machineRequest(fetchImpl, metadata.token_endpoint, {
    method: 'POST', headers: { ...machineHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: 'invalid-smoke-test-code', client_id: registered.client_id, redirect_uri: 'http://127.0.0.1:8788/callback', code_verifier: 'invalid-smoke-test-verifier' }).toString(),
  });
  assert.ok(token.status === 400 || token.status === 401, `Invalid token request must fail: ${token.status}`);
  assert.ok((await token.json()).error);
  log(`Invalid token request → ${token.status} JSON (no token obtained)`);
  for (const path of ['/', '/?record=sample-a%3Aaccess-boundary', '/api/data.json', '/app.js']) {
    const browser = await fetchImpl(new URL(path, base), { headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 Supervisor-Access-Boundary-Test' }, redirect: 'manual' });
    assert.equal(browser.status, 302, `${path} must redirect to Access`);
    const location = new URL(browser.headers.get('location'));
    assert.ok(location.hostname.endsWith('.cloudflareaccess.com'));
    const body = await browser.text();
    assert.ok(!body.includes('"schemaVersion"') && !body.includes('"records"') && !body.includes('supervisor-data-url'));
    log(`Browser GET ${path} → 302 to Access, no dashboard data`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRemote(process.argv[2] ?? process.env.SAMPLE_ACCOUNT_URL ?? (() => { throw new Error('Set SAMPLE_ACCOUNT_URL explicitly'); })());
}
