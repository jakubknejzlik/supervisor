import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDeploymentConfig, loadDeploymentConfig } from '../config.ts';
const example = () => JSON.parse(readFileSync('examples/deploy.config.example.json', 'utf8'));
const account = '00000000000000000000000000000000';
const parse = value => parseDeploymentConfig(value, account, 'test');
afterEach(() => vi.unstubAllEnvs());
it('accepts the documented example, normalizes humans and applies secure defaults', () => {
  const input = example();
  input.principals[0].email = 'REVIEWER@example.invalid';
  for (const key of ['allowedIdps', 'policy', 'sessionDuration', 'oauthSessionDuration', 'oauthAccessTokenLifetime', 'allowLocalProbe', 'storeKey', 'displayTimezone']) delete input[key];
  const config = parse(input);
  expect(config.principals[0].email).toBe('reviewer@example.invalid');
  expect(config).toMatchObject({ accountId: account, allowLocalProbe: false, allowedIdps: ['onetimepin'], policy: { requires: [], excludes: [] }, sessionDuration: '24h', oauthSessionDuration: '336h', oauthAccessTokenLifetime: '15m', storeKey: 'supervisor-store-v1', displayTimezone: 'UTC' });
});
it('accepts exact ChatGPT callbacks and an explicitly enabled fixed local listener', () => {
  const input = example();
  input.allowLocalProbe = true;
  input.mcpClients.push({ client: 'chatgpt', callbackUris: ['https://chatgpt.com/connector/oauth/sample-callback', 'https://chatgpt.com/connector_platform_oauth_redirect'] }, { client: 'local-probe', callbackUris: ['http://127.0.0.1:8788/callback'] });
  expect(parse(input).mcpClients).toEqual(input.mcpClients);
});
it('accepts configured restrictive conditions and explicit new-team IdPs', () => {
  const input = example();
  input.allowedIdps = ['00000000-0000-4000-8000-000000000001'];
  input.policy = { requires: [{ ip: { ip: '192.0.2.0/24' } }, { geo: { countryCode: 'CZ' } }, { loginMethod: { id: input.allowedIdps[0] } }], excludes: [{ email: { email: 'excluded@example.invalid' } }] };
  expect(parse(input).policy).toEqual(input.policy);
});
const invalid = [
  ['missing host', c => delete c.dashboardHostname],
  ['duplicate host', c => c.mcpHostname = c.dashboardHostname],
  ['host outside zone', c => c.mcpHostname = 'mcp.other.invalid'],
  ['wildcard host', c => c.mcpHostname = '*.example.invalid'],
  ['URL in host', c => c.mcpHostname = 'https://mcp.example.invalid'],
  ['invalid zone', c => c.zoneId = 'invalid'],
  ['invalid team', c => c.accessTeamDomain = 'https://team-example.cloudflareaccess.com'],
  ['missing principals', c => c.principals = []],
  ['invalid email', c => c.principals[0].email = 'invalid'],
  ['duplicate normalized humans', c => c.principals.push({ ...c.principals[0], email: 'REVIEWER@example.invalid' })],
  ['unknown capability', c => c.principals[0].capabilities = ['admin']],
  ['empty capability', c => c.principals[0].capabilities = []],
  ['empty IdPs', c => c.allowedIdps = []],
  ['invalid IdP', c => c.allowedIdps = ['invalid']],
  ['invalid session', c => c.sessionDuration = 'forever'],
  ['excessive session', c => c.sessionDuration = '999999999999h'],
  ['token longer than grant', c => { c.oauthAccessTokenLifetime = '24h'; c.oauthSessionDuration = '1h'; }],
  ['invalid timezone', c => c.displayTimezone = 'invalid'],
  ['unknown client', c => c.mcpClients[0].client = 'unknown'],
  ['no client', c => c.mcpClients = []],
  ['no callback', c => c.mcpClients[0].callbackUris = []],
  ['duplicate client', c => c.mcpClients.push(c.mcpClients[0])],
  ['duplicate callback', c => c.mcpClients[0].callbackUris.push(c.mcpClients[0].callbackUris[0])],
  ['broad localhost', c => c.allowAnyOnLocalhost = true],
  ['broad loopback', c => c.allowAnyOnLoopback = true],
  ['policy Everyone', c => c.policy.requires = [{ everyone: {} }]],
  ['policy broad include', c => c.policy.includes = [{ everyone: {} }]],
  ['invalid CIDR', c => c.policy.requires = [{ ip: { ip: '192.0.2.0/99' } }]],
  ['resource adoption', c => c.import = 'existing'],
  ['different singleton', c => c.storeKey = 'other'],
  ['invalid app', c => c.appName = '../invalid'],
];
for (const [label, change] of invalid) it(`rejects ${label}`, () => {
  const input = example(); change(input);
  expect(() => parse(input)).toThrow('Values redacted');
});
for (const uri of [
  'https://claude.ai/api/mcp/*', 'https://claude.ai/api/mcp/%2a', 'https://claude.ai/api/mcp/auth_callback?x=1',
  'https://claude.ai/api/mcp/auth_callback#fragment', 'https://user:pass@example.invalid/callback',
  'http://claude.ai/api/mcp/auth_callback', 'https://other.example.invalid/callback',
  'http://127.0.0.1:8788/callback', 'http://localhost:8788/callback', 'http://[::1]:8788/callback',
]) it(`rejects unapproved redirect ${uri.replace(/user:pass@/, '')}`, () => {
  const input = example(); input.mcpClients[0].callbackUris = [uri]; expect(() => parse(input)).toThrow();
});
it('rejects local probe by default and rejects different local host/path even with opt-in', () => {
  for (const [enabled, uri] of [[false, 'http://127.0.0.1:8788/callback'], [true, 'http://localhost:8788/callback'], [true, 'http://127.0.0.1:8788/*'], [true, 'http://127.0.0.1:8788/other']]) {
    const input = example(); input.allowLocalProbe = enabled; input.mcpClients = [{ client: 'local-probe', callbackUris: [uri] }]; expect(() => parse(input)).toThrow();
  }
});
it('requires account and matching explicit stage without exposing values', () => {
  for (const accountId of [undefined, '', 'invalid']) expect(() => parseDeploymentConfig(example(), accountId, 'test')).toThrow('Values redacted');
  expect(() => parseDeploymentConfig(example(), account, 'other')).toThrow('Values redacted');
});
it('requires private config selection and redacts file errors', () => {
  vi.stubEnv('SUPERVISOR_CONFIG', ''); expect(() => loadDeploymentConfig()).toThrow('SUPERVISOR_CONFIG');
  vi.stubEnv('SUPERVISOR_CONFIG', 'missing-private-config'); expect(() => loadDeploymentConfig()).toThrow('Path and values redacted');
  vi.stubEnv('SUPERVISOR_CONFIG', 'examples/deploy.config.example.json'); vi.stubEnv('CLOUDFLARE_DEFAULT_ACCOUNT_ID', account);
  expect(loadDeploymentConfig('test').stage).toBe('test');
});
