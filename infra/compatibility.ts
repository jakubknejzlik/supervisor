// Compile the API surface needed by the later infrastructure slice against
// both SST's installed platform and the exact registry provider declarations.
import type { WorkerArgs } from '../.sst/platform/src/components/cloudflare/worker';
import type { ZeroTrustAccessApplicationArgs, WorkersScriptSubdomainArgs } from '@pulumi/cloudflare';
export const worker: WorkerArgs = {
  handler: 'apps/worker/src/worker.ts', url: false,
  compatibility: { date: '2026-11-23', flags: ['nodejs_compat'] },
  migrations: [{ tag: 'v1', newSqliteClasses: ['SupervisorStore'] }],
};
export const oauth: NonNullable<ZeroTrustAccessApplicationArgs['oauthConfiguration']> = {
  enabled: true,
  dynamicClientRegistration: { enabled: true, allowedUris: ['http://127.0.0.1:8788/callback'], allowAnyOnLocalhost: false, allowAnyOnLoopback: false },
};
export const subdomain: WorkersScriptSubdomainArgs = {
  accountId: 'sample-account', scriptName: 'sample-worker', enabled: false, previewsEnabled: false,
};
