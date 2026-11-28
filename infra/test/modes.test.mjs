import { afterAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
async function graph(mode, connectorCallbackPattern, mcpClients) {
  captured.length = 0;
  const input = JSON.parse(readFileSync('examples/deploy.config.example.json', 'utf8'));
  delete input.hostname;
  if (mode === 'split') Object.assign(input, { dashboardHostname: 'dashboard.example.invalid', mcpHostname: 'mcp.example.invalid' });
  else Object.assign(input, { hostname: 'dashboard.example.invalid', ...(mode === 'legacy' ? { legacyMcpHostname: 'mcp.example.invalid' } : {}) });
  input.allowLocalProbe = true;
  input.mcpClients.push(
    { client: 'chatgpt', callbackUris: ['https://chatgpt.com/connector/oauth/sample-callback', 'https://chatgpt.com/connector_platform_oauth_redirect'], ...(connectorCallbackPattern === undefined ? {} : { connectorCallbackPattern }) },
    { client: 'local-probe', callbackUris: ['http://127.0.0.1:8788/callback'] },
  );
  if (mcpClients) input.mcpClients = mcpClients;
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

const connectorPattern = 'https://chatgpt.com/connector/oauth/*';
// SHA-256 of serialized resource arguments generated by c16b2826 before this change.
const baselineHashes = {
  legacy: 'e035ce4917ee8aa3511492b3c4a11c4764edf479f96a882d83c09b7d943b9b01',
  single: 'd54821123e59bcd4ee776c8ba50d09d2cc6cd56265c822e6a34ca9b7ef916997',
  split: '1e142cbf2534078db20760bdde711cc536c9f7e83cff4a2db31ab8a483c22151',
};
it.each(['legacy', 'single', 'split'])('keeps serialized %s graph bytes identical to baseline without the flag or with false', async mode => {
  for (const flag of [undefined, false]) {
    const { entries } = await graph(mode, flag);
    expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(baselineHashes[mode]);
  }
});
it.each(['legacy', 'single', 'split'])('adds the pattern exactly once to the primary MCP app only in %s mode', async mode => {
  const before = await graph(mode);
  const enabled = await graph(mode, true);
  const primaryName = mode === 'legacy' ? 'McpPathAccess' : 'McpAccess';
  const primary = entries => entries.find(entry => entry.name === primaryName);
  const exactUris = primary(before.entries).args.oauthConfiguration.dynamicClientRegistration.allowedUris;
  expect(primary(enabled.entries).args.oauthConfiguration.dynamicClientRegistration).toEqual({
    enabled: true, allowedUris: [...exactUris, connectorPattern], allowAnyOnLocalhost: false, allowAnyOnLoopback: false,
  });
  expect(enabled.entries.find(entry => entry.name === 'DashboardAccess').args.oauthConfiguration).toEqual({ enabled: false });
  if (mode === 'legacy') {
    expect(enabled.entries.find(entry => entry.name === 'McpAccess').args.oauthConfiguration.dynamicClientRegistration.allowedUris).toEqual(exactUris);
  }
  const allUris = enabled.entries.flatMap(entry => entry.args.oauthConfiguration?.dynamicClientRegistration?.allowedUris ?? []);
  expect(allUris.filter(uri => uri === connectorPattern)).toHaveLength(1);
  // Removing the one approved addition must reproduce all resource arguments,
  // including policies, audiences, Worker settings and custom domains, byte for byte.
  primary(enabled.entries).args.oauthConfiguration.dynamicClientRegistration.allowedUris.pop();
  expect(JSON.stringify(enabled.entries)).toBe(JSON.stringify(before.entries));
  expect(enabled.result.mcpUrl).toBe(before.result.mcpUrl);
  expect(enabled.result.dashboardUrl).toBe(before.result.dashboardUrl);
});

it.each(['single', 'split'])('clean ChatGPT config gives primary DCR exactly the pattern in %s mode', async mode => {
  const clean = await graph(mode, undefined, [{ client: 'chatgpt', connectorCallbackPattern: true }]);
  expect(clean.entries.find(entry => entry.name === 'McpAccess').args.oauthConfiguration.dynamicClientRegistration).toEqual({
    enabled: true, allowedUris: [connectorPattern], allowAnyOnLocalhost: false, allowAnyOnLoopback: false,
  });
  expect(clean.entries.find(entry => entry.name === 'DashboardAccess').args.oauthConfiguration).toEqual({ enabled: false });
});
it('legacy with exact callbacks and ChatGPT opt-in keeps legacy exact only and primary exact plus pattern', async () => {
  const exactUris = ['https://claude.ai/api/mcp/auth_callback'];
  const migration = await graph('legacy', undefined, [
    { client: 'claude', callbackUris: exactUris },
    { client: 'chatgpt', connectorCallbackPattern: true },
  ]);
  const allowed = name => migration.entries.find(entry => entry.name === name).args.oauthConfiguration.dynamicClientRegistration.allowedUris;
  expect(allowed('McpAccess')).toEqual(exactUris);
  expect(allowed('McpPathAccess')).toEqual([...exactUris, connectorPattern]);
});
