import { afterAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { output } from '@pulumi/pulumi';
const captured = vi.hoisted(() => []);
vi.mock('@pulumi/cloudflare', () => Object.fromEntries([
  'ZeroTrustAccessPolicy', 'ZeroTrustAccessApplication', 'WorkersCustomDomain', 'WorkersScriptSubdomain',
].map(kind => [kind, class {
  constructor(name, args, opts) {
    captured.push({ kind, name, args, opts });
    this.id = output(`${name}-id`);
    this.aud = output(`${name}-aud`);
  }
}])));
import { parseDeploymentConfig } from '../config.ts';
import { supervisor } from '../supervisor.ts';
vi.stubGlobal('sst', { cloudflare: { Worker: class {
  constructor(name, args) {
    captured.push({ kind: 'Worker', name, args });
    this.nodes = { worker: { scriptName: output('sample-worker') } };
  }
} } });
afterAll(() => vi.unstubAllGlobals());
const value = input => output(input).promise();
async function graph(mode) {
  captured.length = 0;
  const input = JSON.parse(readFileSync('examples/deploy.config.example.json', 'utf8'));
  delete input.hostname;
  if (mode === 'split') Object.assign(input, { dashboardHostname: 'dashboard.example.invalid', mcpHostname: 'mcp.example.invalid' });
  else Object.assign(input, { hostname: 'dashboard.example.invalid', ...(mode === 'legacy' ? { legacyMcpHostname: 'mcp.example.invalid' } : {}) });
  const result = supervisor(parseDeploymentConfig(input, '00000000000000000000000000000000'));
  const entries = await Promise.all(captured.map(async ({ kind, name, args }) => ({ kind, name, args: await value(args) })));
  return { result, entries, audiences: JSON.parse(entries.find(e => e.kind === 'Worker').args.environment.ACCESS_AUDS) };
}
it('keeps every split app, policy and domain name/argument unchanged when adding legacy migration paths', async () => {
  const split = await graph('split');
  const legacy = await graph('legacy');
  const resources = entries => entries.filter(e => /Access|Policy|Domain/.test(e.name));
  expect(resources(split.entries).map(e => e.name)).toEqual(['DashboardPolicy', 'DashboardAccess', 'McpPolicy', 'McpAccess', 'DashboardDomain', 'McpDomain']);
  for (const before of resources(split.entries)) expect(legacy.entries.find(e => e.name === before.name)).toEqual(before);
  expect(resources(legacy.entries).map(e => e.name)).toEqual(['DashboardPolicy', 'DashboardAccess', 'McpPolicy', 'McpAccess', 'McpPathPolicy', 'McpPathAccess', 'DashboardDomain', 'McpDomain']);
  expect(legacy.entries.find(e => e.name === 'McpPathAccess').args).toEqual({
    ...split.entries.find(e => e.name === 'McpAccess').args,
    name: 'supervisor-test-mcppath', domain: undefined,
    destinations: [{ type: 'public', uri: 'dashboard.example.invalid/mcp' }, { type: 'public', uri: 'dashboard.example.invalid/.well-known/*' }],
    policies: [{ id: 'McpPathPolicy-id', precedence: 1 }],
  });
  expect(legacy.audiences).toEqual({
    'dashboard.example.invalid': { dashboard: ['DashboardAccess-aud'], mcp: ['McpPathAccess-aud'] },
    'mcp.example.invalid': { mcp: ['McpAccess-aud'] },
  });
  for (const entry of [split, legacy]) {
    expect(entry.result.dashboardUrl).toBe('https://dashboard.example.invalid');
    expect(entry.entries.find(e => e.kind === 'Worker').args.migrations).toEqual([{ tag: 'v1', newSqliteClasses: ['SupervisorStore'] }]);
  }
  expect(legacy.result.mcpUrl).toBe('https://dashboard.example.invalid/mcp');
  expect(split.result.mcpUrl).toBe('https://mcp.example.invalid/mcp');
});
it('uses the natural names and one domain for a fresh single-host graph', async () => {
  const single = await graph('single');
  expect(single.entries.map(e => e.name)).toEqual(['DashboardPolicy', 'DashboardAccess', 'McpPolicy', 'McpAccess', 'Supervisor', 'AlternateUrls', 'DashboardDomain']);
  const app = name => single.entries.find(e => e.name === name).args;
  expect(app('DashboardAccess').domain).toBe('dashboard.example.invalid');
  expect(app('DashboardAccess').destinations).toBeUndefined();
  expect(app('DashboardAccess').oauthConfiguration).toEqual({ enabled: false });
  expect(app('McpAccess').domain).toBeUndefined();
  expect(app('McpAccess').destinations).toEqual([{ type: 'public', uri: 'dashboard.example.invalid/mcp' }, { type: 'public', uri: 'dashboard.example.invalid/.well-known/*' }]);
  expect(single.audiences).toEqual({ 'dashboard.example.invalid': { dashboard: ['DashboardAccess-aud'], mcp: ['McpAccess-aud'] } });
});
it('generates explicit route classes in split mode while preserving host-wide AUD acceptance', async () => {
  expect((await graph('split')).audiences).toEqual({
    'dashboard.example.invalid': { dashboard: ['DashboardAccess-aud'], mcp: ['DashboardAccess-aud'] },
    'mcp.example.invalid': { dashboard: ['McpAccess-aud'], mcp: ['McpAccess-aud'] },
  });
});
