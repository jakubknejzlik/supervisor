import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, actor, issuer } from './fixture.mjs';
import { runtime } from './runtime.mjs';
let keys, mf, owner, service;
beforeAll(async () => {
  keys = await fixture(); owner = await keys.token();
  service = await keys.token({ aud: 'import-audience', email: undefined, sub: '', common_name: 'test-service.access' });
  mf = await runtime(keys.jwks, { audiences: Object.fromEntries(Object.entries({ '127.0.0.1': ['test-audience', 'import-audience'], 'dashboard.example.com': ['dashboard-aud', 'import-audience'], 'mcp.example.com': ['live-aud'] }).map(([host, auds]) => [host, { dashboard: auds, mcp: auds }])) });
});
afterAll(async () => { await mf?.dispose(); });
const headers = assertion => ({ 'Cf-Access-Jwt-Assertion': assertion });
const read = () => mf.dispatchFetch('http://127.0.0.1/api/data.json', { headers: headers(owner) }).then(r => r.json());
async function call(name, args) {
  const res = await mf.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST', headers: { ...headers(owner), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await res.json();
  if (body.result.isError && body.result.content[0].text.startsWith('MCP error')) return { error: 'invalid_arguments' };
  return JSON.parse(body.result.content[0].text);
}
async function ws() {
  const response = await mf.dispatchFetch('http://127.0.0.1/api/ws', { headers: { ...headers(owner), Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  const socket = response.webSocket, events = [];
  socket.addEventListener('message', event => events.push(event.data === 'pong' ? 'pong' : JSON.parse(event.data)));
  socket.accept();
  await tick(); return { socket, events };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
it('record query uses the same authenticated asset boundary as root', async () => {
  for (const path of ['/', '/?record=sample-a%3Abrowser-0', '/?record=%3Cscript%3E']) {
    const denied = await mf.dispatchFetch(`http://127.0.0.1${path}`);
    // Access owns the outer 302; the Worker itself fails closed with JSON 401.
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'forbidden' });
    const allowed = await mf.dispatchFetch(`http://127.0.0.1${path}`, { headers: headers(owner) });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Content-Type')).toContain('text/html');
    expect(await allowed.text()).toBe(await (await mf.dispatchFetch('http://127.0.0.1/', { headers: headers(owner) })).text());
  }
});
it('hibernation websocket broadcasts committed upsert/check only, version persists and ping auto-responds', async () => {
  const { socket, events } = await ws();
  const initial = (await read()).version;
  const id = 'sample:ws';
  await call('upsert_record', { id, expectedRev: 0, patch: { name: 'WS' } });
  await call('check_record', { id, expectedRev: 1, source: 'manual', result: 'claim' });
  await tick();
  expect(events.filter(e => e.version > initial)).toEqual([{ type: 'changed', version: initial + 1, ids: [id] }, { type: 'changed', version: initial + 2, ids: [id] }]);
  const count = events.length;
  expect((await call('upsert_record', { id, expectedRev: 0, patch: {} })).error).toBe('rev_conflict');
  expect((await call('upsert_record', { id, expectedRev: 2, patch: { checkedAt: null } })).error).toBe('checkedAt_requires_check_tool');
  await tick(); expect(events).toHaveLength(count);
  socket.send('ping'); await tick(); expect(events.at(-1)).toBe('pong');
  expect((await read()).version).toBe(initial + 2);
  socket.close();
});
it('websocket upgrade uses JSON 401/403 identity authorization and rejects invalid JWT', async () => {
  for (const [token, status] of [[undefined, 401], [await keys.token({ email: 'wrong@example.invalid' }), 403], [await keys.token({ aud: 'wrong' }), 403], [service, 403]]) {
    const response = await mf.dispatchFetch('http://127.0.0.1/api/ws', { headers: { Upgrade: 'websocket', ...(token ? headers(token) : {}) } });
    expect(response.status).toBe(status); expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.has('Location')).toBe(false); expect(await response.json()).toEqual({ error: 'forbidden' });
  }
});
it('audiences are bound to the exact request hostname, never trusted from forwarded headers', async () => {
  for (const [host, aud, status] of [['dashboard.example.com', 'dashboard-aud', 200], ['mcp.example.com', 'live-aud', 200], ['dashboard.example.com', 'live-aud', 403], ['mcp.example.com', 'dashboard-aud', 403], ['evil.invalid', 'dashboard-aud', 403]]) {
    const response = await mf.dispatchFetch(`https://${host}/api/data.json`, { headers: { ...headers(await keys.token({ aud })), 'X-Forwarded-Host': 'dashboard.example.com' } });
    expect(response.status).toBe(status);
  }
});
it('removed import route is unavailable and cannot change data', async () => {
  const before = await read();
  const response = await mf.dispatchFetch('http://127.0.0.1/api/import', { headers: headers(owner) });
  expect(response.status).toBe(404);
  expect((await read()).version).toBe(before.version);
});
it('records, revisions, checks, audit and version survive a SQLite restart', async () => {
  const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  mkdirSync('.local', { recursive: true });
  const persist = mkdtempSync(resolve('.local/persist-'));
  let instance;
  const rpc = async (name, args) => {
    const res = await instance.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST', headers: { ...headers(owner), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return JSON.parse((await res.json()).result.content[0].text);
  };
  try {
    instance = await runtime(keys.jwks, { persist });
    const id = 'sample:persistent';
    await rpc('upsert_record', { id, expectedRev: 0, patch: { name: 'Persistent', requestedFrom: [{ issuer, sub: 'test-subject' }] } });
    const checked = await rpc('check_record', { id, expectedRev: 1, source: 'manual', result: 'Persisted check' });
    await instance.dispose(); instance = await runtime(keys.jwks, { persist });
    expect(await rpc('get_record', { id })).toEqual(checked);
    expect(await rpc('get_audit', { recordId: id })).toHaveLength(2);
    const data = await instance.dispatchFetch('http://127.0.0.1/api/data.json', { headers: headers(owner) }).then(r => r.json());
    expect(data.version).toBe(2);
    expect(data.records[0]).toMatchObject({ id, rev: 2, checkedAt: checked.checkedAt, waitingOnYou: true });
    expect(await rpc('upsert_record', { id, expectedRev: 0, patch: {} })).toEqual({ error: 'rev_conflict', currentRev: 2 });
  } finally { await instance?.dispose(); rmSync(persist, { recursive: true, force: true }); }
});
it('two independent verified viewers receive private projections of the same store', async () => {
  const second = await keys.token({ sub: 'second-subject', email: 'READER@example.invalid' });
  const rows = [
    ['first', { requestedFrom: [{ issuer, sub: 'test-subject' }] }, true, false],
    ['second', { requestedFrom: [{ issuer, sub: 'second-subject' }] }, false, true],
    ['email', { requestedFrom: [{ email: 'OWNER@EXAMPLE.INVALID' }] }, true, false],
    ['conflict', { requestedFrom: [{ issuer, sub: 'second-subject', email: actor }] }, false, true],
    ['scoped', { requestedFrom: [{ issuer: 'https://other.cloudflareaccess.com', sub: 'test-subject', email: actor }] }, false, false],
    ['case', { requestedFrom: [{ issuer, sub: 'TEST-SUBJECT', email: actor }] }, false, false],
    ['missing', { waitingOn: 'Viewer', nextAction: { isViewer: true } }, false, false],
    ...['done', 'paused', 'deferred', 'backlog'].map(state => [state, { state, requestedFrom: [{ issuer, sub: 'test-subject' }, { email: 'reader@example.invalid' }] }, false, false]),
  ];
  for (const [id, patch] of rows) expect((await call('upsert_record', { id: `identity:${id}`, expectedRev: 0, patch })).rev).toBe(1);
  const snapshots = [];
  for (const token of [owner, second]) {
    const response = await mf.dispatchFetch('http://127.0.0.1/api/data.json?sub=test-subject&email=' + actor, { headers: { ...headers(token), 'Cf-Access-Authenticated-User-Email': actor, 'X-Subject': 'test-subject' } });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    snapshots.push(await response.json());
  }
  for (const [id, , first, second] of rows) {
    expect(snapshots[0].records.find(r => r.id === `identity:${id}`).waitingOnYou).toBe(first);
    expect(snapshots[1].records.find(r => r.id === `identity:${id}`).waitingOnYou).toBe(second);
    expect((await call('get_record', { id: `identity:${id}` })).data).not.toHaveProperty('waitingOnYou');
  }
  for (const requestedFrom of [null, {}, [{ email: 'invalid' }], [{ sub: 'unscoped' }], [{ issuer, sub: '', email: actor }]]) {
    expect(await call('upsert_record', { id: 'identity:invalid', expectedRev: 0, patch: { requestedFrom } })).toHaveProperty('error');
  }
  expect(await call('get_audit', { recordId: 'identity:invalid' })).toEqual([]);
  expect(await call('upsert_record', { id: 'identity:spoof', expectedRev: 0, patch: { waitingOnYou: true } })).toHaveProperty('error');
  // Presentation does not grant write capability to the second viewer.
  const denied = await mf.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST', headers: { ...headers(second), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upsert_record', arguments: { id: 'identity:second', expectedRev: 1, patch: {} } } }) }).then(r => r.json());
  expect(JSON.parse(denied.result.content[0].text).error).toBe('insufficient_scope');
});
it('absent and malformed host configuration fail closed without a fallback', async () => {
  for (const ACCESS_AUDS of ['', 'null', '{}', '{"127.0.0.1":[]}', '{"127.0.0.1":[null]}']) {
    const instance = await runtime(keys.jwks, { extraBindings: { ACCESS_AUDS } });
    try { expect((await instance.dispatchFetch('http://127.0.0.1/api/data.json', { headers: headers(owner) })).status).toBe(403); }
    finally { await instance.dispose(); }
  }
});
