import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';
import { emailAddress } from '@supervisor/core/schema';

const name = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/);
const id = z.string().regex(/^[a-f0-9]{32}$/);
const hostname = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/);
const idp = z.union([z.literal('onetimepin'), z.string().uuid()]);
const unique = (values: string[]) => new Set(values).size === values.length;
const duration = (fallback: string, maxSeconds: number) => z.string().regex(/^[1-9][0-9]*(m|h)$/)
  .refine(value => seconds(value) <= maxSeconds, 'Duration exceeds limit').default(fallback);
const seconds = (value: string) => Number(value.slice(0, -1)) * (value.endsWith('h') ? 3600 : 60);
const cidr = z.string().refine(value => {
  const [address, prefix, ...extra] = value.split('/');
  const version = isIP(address);
  return !!version && !extra.length && (prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128)));
}, 'Expected IP or CIDR');
// Deliberately bounded condition vocabulary: no Everyone, bypass or service tokens.
const condition = z.union([
  z.object({ email: z.object({ email: emailAddress }).strict() }).strict(),
  z.object({ ip: z.object({ ip: cidr }).strict() }).strict(),
  z.object({ geo: z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/) }).strict() }).strict(),
  z.object({ loginMethod: z.object({ id: idp }).strict() }).strict(),
]);
const schema = z.object({
  appName: name,
  stage: name,
  zoneId: id,
  zoneName: hostname,
  dashboardHostname: hostname,
  mcpHostname: hostname,
  accessTeamDomain: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/),
  principals: z.array(z.object({
    email: emailAddress,
    capabilities: z.array(z.enum(['supervisor:read', 'supervisor:write'])).min(1).refine(unique),
  }).strict()).min(1).refine(values => unique(values.map(value => value.email)), 'Duplicate principal'),
  policy: z.object({ requires: z.array(condition).default([]), excludes: z.array(condition).default([]) }).strict().default({}),
  allowedIdps: z.array(idp).min(1).refine(unique).default(['onetimepin']),
  sessionDuration: duration('24h', 31 * 86400),
  oauthSessionDuration: duration('336h', 31 * 86400),
  oauthAccessTokenLifetime: duration('15m', 86400),
  allowLocalProbe: z.boolean().default(false),
  mcpClients: z.array(z.object({
    client: z.enum(['chatgpt', 'claude', 'local-probe']),
    callbackUris: z.array(z.string().min(1)).min(1),
  }).strict()).min(1).refine(values => unique(values.map(value => value.client)), 'Duplicate client'),
  // The runtime deliberately has one stable singleton per new namespace.
  storeKey: z.literal('supervisor-store-v1').default('supervisor-store-v1'),
  displayTimezone: z.string().refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }).default('UTC'),
}).strict().superRefine((config, ctx) => {
  const reject = (path: string) => ctx.addIssue({ code: 'custom', path: [path], message: 'Invalid deployment setting' });
  if (config.dashboardHostname === config.mcpHostname) reject('mcpHostname');
  for (const key of ['dashboardHostname', 'mcpHostname'] as const) {
    if (!config[key].endsWith('.' + config.zoneName)) reject(key);
  }
  if (seconds(config.oauthAccessTokenLifetime) > seconds(config.oauthSessionDuration)) reject('oauthAccessTokenLifetime');
  const seen = new Set<string>();
  for (const client of config.mcpClients) for (const uri of client.callbackUris) {
    let valid = false;
    try {
      const url = new URL(uri);
      const exact = url.href === uri && !url.username && !url.password && !url.search && !url.hash && !/[\\*]/.test(decodeURIComponent(uri));
      if (exact && client.client === 'chatgpt') valid = /^https:\/\/chatgpt\.com\/(connector\/oauth\/[A-Za-z0-9_-]+|connector_platform_oauth_redirect)$/.test(uri);
      if (exact && client.client === 'claude') valid = uri === 'https://claude.ai/api/mcp/auth_callback';
      if (exact && client.client === 'local-probe' && config.allowLocalProbe) {
        valid = url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.pathname === '/callback';
      }
    } catch { /* Validation errors never include the supplied value. */ }
    if (!valid || seen.has(uri)) reject('mcpClients');
    seen.add(uri);
  }
});
export type DeploymentConfig = z.infer<typeof schema> & { accountId: string };
export function parseDeploymentConfig(input: unknown, accountId: unknown, stage?: string): DeploymentConfig {
  const parsed = schema.safeParse(input);
  if (!parsed.success || !id.safeParse(accountId).success || (stage !== undefined && parsed.success && stage !== parsed.data.stage)) {
    throw new Error('Invalid deployment config, account selection or stage; see docs/setup.md. Values redacted.');
  }
  return { ...parsed.data, accountId: accountId as string };
}
export function loadDeploymentConfig(stage?: string): DeploymentConfig {
  const path = process.env.SUPERVISOR_CONFIG;
  if (!path) throw new Error('SUPERVISOR_CONFIG must select a private deployment config; see docs/setup.md.');
  let input: unknown;
  try { input = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Cannot read deployment config JSON. Path and values redacted.'); }
  return parseDeploymentConfig(input, process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID, stage);
}
