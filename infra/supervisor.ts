import * as cf from '@pulumi/cloudflare';
import { all, output, secret } from '@pulumi/pulumi';
import { loadDeploymentConfig, type DeploymentConfig } from './config';

// Only constructors for new resources. No resource lookup, adoption or data seed.
export function supervisor(config: DeploymentConfig = loadDeploymentConfig()) {
  const access = ['Dashboard', 'Mcp'].map(kind => {
    const policy = new cf.ZeroTrustAccessPolicy(`${kind}Policy`, {
      accountId: config.accountId, name: `${config.appName}-${config.stage}-${kind.toLowerCase()}`,
      decision: 'allow',
      includes: secret(config.principals.map(principal => ({ email: { email: principal.email } }))),
      requires: secret(config.policy.requires), excludes: secret(config.policy.excludes),
      sessionDuration: config.sessionDuration,
    });
    const app = new cf.ZeroTrustAccessApplication(`${kind}Access`, {
      accountId: config.accountId, name: `${config.appName}-${config.stage}-${kind.toLowerCase()}`,
      type: 'self_hosted', domain: kind === 'Dashboard' ? config.dashboardHostname : config.mcpHostname,
      appLauncherVisible: false, allowedIdps: config.allowedIdps, sessionDuration: config.sessionDuration,
      policies: [{ id: policy.id, precedence: 1 }],
      oauthConfiguration: kind === 'Mcp' ? {
        enabled: true,
        dynamicClientRegistration: {
          enabled: true, allowedUris: config.mcpClients.flatMap(client => client.callbackUris),
          allowAnyOnLocalhost: false, allowAnyOnLoopback: false,
        },
        grant: { sessionDuration: config.oauthSessionDuration, accessTokenLifetime: config.oauthAccessTokenLifetime },
      } : { enabled: false },
    });
    return { policy, app };
  });
  const audiences = all(access.map(({ app }) => app.aud)).apply(([dashboard, mcp]) => JSON.stringify({
    [config.dashboardHostname]: [dashboard], [config.mcpHostname]: [mcp],
  }));
  const worker = new sst.cloudflare.Worker('Supervisor', {
    accountId: config.accountId, handler: 'apps/worker/src/worker.ts', url: false,
    dev: false,
    compatibility: { date: '2026-11-23', flags: ['nodejs_compat'] },
    migrations: [{ tag: 'v1', newSqliteClasses: ['SupervisorStore'] }],
    environment: { ACCESS_TEAM_DOMAIN: config.accessTeamDomain, ACCESS_AUDS: audiences, DISPLAY_TIMEZONE: config.displayTimezone },
    transform: { worker(args) {
      args.bindings = all([output(args.bindings), secret(JSON.stringify(Object.fromEntries(
        config.principals.map(principal => [principal.email, principal.capabilities]),
      )))]).apply(([bindings, principals]) => [
        ...(bindings ?? []),
        { name: 'ALLOWED_EMAILS', type: 'secret_text', text: principals },
        { name: 'STORE', type: 'durable_object_namespace', className: 'SupervisorStore' },
      ]);
    } },
  });
  const alternateUrls = new cf.WorkersScriptSubdomain('AlternateUrls', {
    accountId: config.accountId, scriptName: worker.nodes.worker.scriptName,
    enabled: false, previewsEnabled: false,
  }, { dependsOn: [worker] });
  const domains = [config.dashboardHostname, config.mcpHostname].map((hostname, index) => new cf.WorkersCustomDomain(
    index === 0 ? 'DashboardDomain' : 'McpDomain', {
      accountId: config.accountId, zoneId: config.zoneId, hostname, service: worker.nodes.worker.scriptName,
      environment: 'production', enabled: true, previewsEnabled: false,
    }, { dependsOn: [...access.map(({ app }) => app), alternateUrls] },
  ));
  // Expose endpoints only; principals, AUDs and token are never stack outputs.
  return { dashboardUrl: `https://${config.dashboardHostname}`, mcpUrl: `https://${config.mcpHostname}/mcp`,
    worker, access, alternateUrls, domains };
}
