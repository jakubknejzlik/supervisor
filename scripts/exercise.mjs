import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
export async function exercise(baseUrl, headers, label) {
  const id = `synthetic:e2e-${Date.now()}`;
  const client = new Client({ name: 'supervisor-e2e', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), { requestInit: { headers } });
  async function call(name, args) {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  }
  try {
    await client.connect(transport); console.log(`${label}: initialize OK`);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);
    assert.ok(tools.every(t => typeof t.annotations.readOnlyHint === 'boolean' && t.annotations.destructiveHint === false));
    console.log(`${label}: tools/list OK (5 tools, annotations, JSON Schemas)`);
    let record = await call('upsert_record', { id, expectedRev: 0, patch: { name: `Synthetic E2E ${id}`, status: 'Written live via MCP' } });
    assert.equal(record.rev, 1); assert.equal(record.checkedAt, null);
    console.log(`${label}: upsert_record OK rev=1 checkedAt=null`);
    record = await call('get_record', { id }); assert.equal(record.rev, 1);
    console.log(`${label}: get_record OK`);
    record = await call('check_record', { id, expectedRev: 1, result: 'passed', source: 'manual', evidence: ['Synthetic MCP SDK E2E'] });
    assert.equal(record.rev, 2); assert.ok(record.checkedAt);
    assert.equal(record.data.lastCheck.recordedAt, record.checkedAt);
    assert.equal(record.data.lastCheck.clientId, null);
    console.log(`${label}: check_record OK rev=2 client claim recorded (source=manual, clientId=null)`);
    const audit = await call('get_audit', { recordId: id });
    assert.equal(audit.length, 2); assert.ok(audit.every(row => row.actor && row.clientId === null));
    assert.equal(audit[0].source, 'manual');
    console.log(`${label}: get_audit OK (2 writes, verified actor, source + null clientId)`);
    const response = await fetch(new URL('/api/data.json', baseUrl), { headers, redirect: 'error' });
    assert.equal(response.status, 200);
    const data = await response.json();
    const row = data.records.find(row => row.id === id);
    assert.equal(row.rev, 2); assert.equal(row.checkedAt, record.checkedAt); assert.equal(data.schemaVersion, 1);
    assert.equal(row.stateLabel, `Checked — claimed by ${record.data.lastCheck.actor} via manual`);
    console.log(`${label}: GET /api/data.json OK (synthetic row rev=2 visible, no Git/publish)`);
    const html = await fetch(new URL('/', baseUrl), { headers, redirect: 'error' }).then(r => r.text());
    assert.ok(html.includes('name="supervisor-data-url" content="/api/data.json"'));
    assert.ok(!html.includes('src="./data.js"'));
    console.log(`${label}: shared dashboard HTML points to live API`);
    return id;
  } finally { await client.close(); }
}
