import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as pulumi from '@pulumi/pulumi';
const captured = vi.hoisted(() => ({ constructors: [], workerArgs: undefined }));
vi.mock('@pulumi/cloudflare', async importOriginal => {
  const original = await importOriginal();
  const result = { ...original };
  for (const key of ['ZeroTrustAccessPolicy', 'ZeroTrustAccessApplication', 'WorkersCustomDomain', 'WorkersScriptSubdomain']) {
    result[key] = class extends original[key] {
      constructor(name, args, opts) {
        super(name, args, opts); captured.constructors.push({ kind: key, name, args, opts, resource: this });
      }
    };
  }
  return result;
});
import * as cf from '@pulumi/cloudflare';
import { parseDeploymentConfig } from '../config.ts';
import { supervisor } from '../supervisor.ts';
const registered = [];
pulumi.runtime.setMocks({
  newResource(args) {
    registered.push(args);
    return { id: `${args.name}-new-id`, state: { ...args.inputs, ...(args.type.includes('AccessApplication') ? { aud: `${args.name}-new-aud` } : {}) } };
  },
  call() { throw new Error('Resource lookup is forbidden'); },
}, 'sample-app', 'test', false);
// Component double: records the exact public SST args, executes our transform,
// and registers a real provider Worker under Pulumi mocks. It deliberately does
// not run SST's build helpers or migration API reads. Strict typecheck separately
// checks the production args against the checksum-verified pinned SST sources.
class WorkerDouble extends pulumi.ComponentResource {
  constructor(name, args) {
    super('test:sst:Worker', name, {});
    captured.workerArgs = args;
    const script = {
      accountId: args.accountId, scriptName: 'sample-worker', mainModule: 'worker.mjs',
      bindings: pulumi.output(args.environment).apply(env => Object.entries(env).map(([name, text]) => ({ name, text, type: 'plain_text' }))),
    };
    args.transform.worker(script);
    this.nodes = { worker: new cf.WorkersScript(`${name}Script`, script, { parent: this }) };
  }
}
const value = input => pulumi.output(input).promise();
let graph, config, bindings;
beforeAll(async () => {
  vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden in resource mocks'); });
  vi.stubGlobal('sst', { cloudflare: { Worker: WorkerDouble } });
  const input = JSON.parse(readFileSync('examples/deploy.config.example.json', 'utf8'));
  delete input.hostname;
  Object.assign(input, { dashboardHostname: 'dashboard.example.invalid', mcpHostname: 'mcp.example.invalid' });
  input.allowLocalProbe = true;
  input.mcpClients.push({ client: 'chatgpt', callbackUris: ['https://chatgpt.com/connector/oauth/sample-callback', 'https://chatgpt.com/connector_platform_oauth_redirect'] }, { client: 'local-probe', callbackUris: ['http://127.0.0.1:8788/callback'] });
  input.policy = { requires: [{ ip: { ip: '192.0.2.0/24' } }], excludes: [{ email: { email: 'excluded@example.invalid' } }] };
  config = parseDeploymentConfig(input, '00000000000000000000000000000000', 'test');
  graph = supervisor(config);
  await value(graph.domains.map(domain => domain.urn));
  bindings = await value(graph.worker.nodes.worker.bindings);
});
afterAll(() => vi.unstubAllGlobals());
it('creates only new app resources, with no import, lookup, seed or old namespace', () => {
  expect(registered.filter(resource => resource.custom).map(resource => resource.type).sort()).toEqual([
    ...Array(2).fill('cloudflare:index/zeroTrustAccessPolicy:ZeroTrustAccessPolicy'),
    ...Array(2).fill('cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication'),
    ...Array(2).fill('cloudflare:index/workersCustomDomain:WorkersCustomDomain'),
    'cloudflare:index/workersScript:WorkersScript', 'cloudflare:index/workersScriptSubdomain:WorkersScriptSubdomain',
  ].sort());
  for (const resource of registered) expect(resource.importId).toBeUndefined();
  for (const entry of captured.constructors) expect(entry.opts?.import).toBeUndefined();
  expect(captured.workerArgs.migrations).toEqual([{ tag: 'v1', newSqliteClasses: ['SupervisorStore'] }]);
  expect(bindings.find(binding => binding.name === 'STORE')).toEqual({ name: 'STORE', type: 'durable_object_namespace', className: 'SupervisorStore' });
  expect(captured.workerArgs.handler).toBe('apps/worker/src/worker.ts');
  expect(captured.workerArgs.dev).toBe(false);
  expect(config.storeKey).toBe('supervisor-store-v1');
});
it('builds independent allow policies from configured principals and conditions', async () => {
  for (const { policy, app } of graph.access) {
    expect(await value(policy.decision)).toBe('allow');
    expect(await value(policy.includes)).toEqual(config.principals.map(({ email }) => ({ email: { email } })));
    expect(await value(policy.requires)).toEqual(config.policy.requires);
    expect(await value(policy.excludes)).toEqual(config.policy.excludes);
    expect(await value(app.policies)).toEqual([{ id: await value(policy.id), precedence: 1 }]);
    expect(await value(app.allowedIdps)).toEqual(config.allowedIdps);
    expect(await value(app.sessionDuration)).toBe(config.sessionDuration);
    expect(await value(app.type)).toBe('self_hosted');
  }
  expect(graph.access[0].policy).not.toBe(graph.access[1].policy);
});
it('maps only each new application AUD to its own exact hostname', async () => {
  expect(await value(graph.access[0].app.domain)).toBe(config.dashboardHostname);
  expect(await value(graph.access[1].app.domain)).toBe(config.mcpHostname);
  const audiences = JSON.parse(bindings.find(binding => binding.name === 'ACCESS_AUDS').text);
  expect(audiences).toEqual({ [config.dashboardHostname]: { dashboard: ['DashboardAccess-new-aud'], mcp: ['DashboardAccess-new-aud'] }, [config.mcpHostname]: { dashboard: ['McpAccess-new-aud'], mcp: ['McpAccess-new-aud'] } });
  expect(audiences[config.dashboardHostname]).not.toEqual(audiences[config.mcpHostname]);
});
it('enables Managed OAuth only on MCP with the exact configured callback union', async () => {
  expect(await value(graph.access[0].app.oauthConfiguration)).toEqual({ enabled: false });
  expect(await value(graph.access[1].app.oauthConfiguration)).toEqual({
    enabled: true,
    dynamicClientRegistration: { enabled: true, allowedUris: config.mcpClients.flatMap(client => client.callbackUris), allowAnyOnLocalhost: false, allowAnyOnLoopback: false },
    grant: { sessionDuration: '336h', accessTokenLifetime: '15m' },
  });
});
it('attaches domains after Access and alternate URL controls to the same new script', async () => {
  expect(captured.workerArgs.url).toBe(false);
  expect(captured.workerArgs.domain).toBeUndefined();
  expect(await value(graph.alternateUrls.enabled)).toBe(false);
  expect(await value(graph.alternateUrls.previewsEnabled)).toBe(false);
  expect(captured.constructors.find(entry => entry.kind === 'WorkersScriptSubdomain').opts.dependsOn).toEqual([graph.worker]);
  for (const entry of captured.constructors.filter(entry => entry.kind === 'WorkersCustomDomain')) {
    expect(entry.opts.dependsOn).toEqual([...graph.access.map(({ app }) => app), graph.alternateUrls]);
    expect(await value(entry.resource.service)).toBe('sample-worker');
    expect(await value(entry.resource.enabled)).toBe(true);
    expect(await value(entry.resource.previewsEnabled)).toBe(false);
    expect(await value(entry.resource.zoneId)).toBe(config.zoneId);
  }
  expect(await value(graph.domains.map(domain => domain.hostname))).toEqual([config.dashboardHostname, config.mcpHostname]);
  expect(captured.constructors.every(entry => entry.args.accountId === config.accountId)).toBe(true);
});
it('protects principal state and uses secret_text for the private capability map', async () => {
  expect(bindings.find(binding => binding.name === 'ALLOWED_EMAILS')).toEqual({ name: 'ALLOWED_EMAILS', type: 'secret_text', text: JSON.stringify(Object.fromEntries(config.principals.map(({ email, capabilities }) => [email, capabilities]))) });
  expect(await pulumi.isSecret(graph.worker.nodes.worker.bindings)).toBe(true);
  for (const { policy } of graph.access) {
    expect(await pulumi.isSecret(policy.includes)).toBe(true);
    expect(await pulumi.isSecret(policy.requires)).toBe(true);
  }
  const root = readFileSync('sst.config.ts', 'utf8');
  expect(root).toContain("home: 'cloudflare'");
  expect(root).toContain("input.stage === 'production' ? 'retain' : 'remove'");
  expect(root).toContain("protect: input.stage === 'production'");
});
