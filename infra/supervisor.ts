import * as cf from '@pulumi/cloudflare';
import { all, output, secret } from '@pulumi/pulumi';
import { loadDeploymentConfig, type DeploymentConfig } from './config';

const chatgptConnectorCallbackPattern = 'https://chatgpt.com/connector/oauth/*';

// Only constructors for new resources. No resource lookup, adoption or data seed.
export function supervisor(config: DeploymentConfig = loadDeploymentConfig()) {
  const single = 'hostname' in config;
  const dashboardHost = single ? config.hostname : config.dashboardHostname;
  const mcpHost = single ? config.hostname : config.mcpHostname;
  const legacyHost = single ? config.legacyMcpHostname : undefined;
  const exactCallbackUris = config.mcpClients.flatMap(client => client.callbackUris);
  const connectorCallbackPattern = config.mcpClients.some(client => client.client === 'chatgpt' && client.connectorCallbackPattern);
  // Preserve all existing host-wide resource arguments and logical names during
  // migration. Only the new path app/policy are added to the existing graph.
  const specs = [
    { kind: 'Dashboard', host: dashboardHost, path: false, oauth: false },
    ...(legacyHost ? [{ kind: 'Mcp', host: legacyHost, path: false, oauth: true }] : []),
    { kind: legacyHost ? 'McpPath' : 'Mcp', host: mcpHost, path: single, oauth: true },
  ];
  const access = specs.map(({ kind, host, path, oauth }) => {
    const policy = new cf.ZeroTrustAccessPolicy(`${kind}Policy`, {
      accountId: config.accountId, name: `${config.appName}-${config.stage}-${kind.toLowerCase()}`,
      decision: 'allow',
      includes: secret(config.principals.map(principal => ({ email: { email: principal.email } }))),
      requires: secret(config.policy.requires), excludes: secret(config.policy.excludes),
      sessionDuration: config.sessionDuration,
    });
    const app = new cf.ZeroTrustAccessApplication(`${kind}Access`, {
      accountId: config.accountId, name: `${config.appName}-${config.stage}-${kind.toLowerCase()}`,
      type: 'self_hosted',
      ...(path ? { destinations: [
        { type: 'public', uri: `${host}/mcp` },
        { type: 'public', uri: `${host}/.well-known/*` },
      ] } : { domain: host }),
      appLauncherVisible: false, allowedIdps: config.allowedIdps, sessionDuration: config.sessionDuration,
      policies: [{ id: policy.id, precedence: 1 }],
      oauthConfiguration: oauth ? {
        enabled: true,
        dynamicClientRegistration: {
          enabled: true, allowedUris: connectorCallbackPattern && host === mcpHost
            ? [...exactCallbackUris, chatgptConnectorCallbackPattern] : exactCallbackUris,
          allowAnyOnLocalhost: false, allowAnyOnLoopback: false,
        },
        grant: { sessionDuration: config.oauthSessionDuration, accessTokenLifetime: config.oauthAccessTokenLifetime },
      } : { enabled: false },
    });
    return { policy, app };
  });
  const audiences = all(access.map(({ app }) => app.aud)).apply(auds => JSON.stringify(single ? {
    [dashboardHost]: { dashboard: [auds[0]], mcp: [auds.at(-1)] },
    ...(legacyHost ? { [legacyHost]: { mcp: [auds[1]] } } : {}),
  } : {
    // Split mode historically accepts its host's AUD on every path.
    [dashboardHost]: { dashboard: [auds[0]], mcp: [auds[0]] },
    [mcpHost]: { dashboard: [auds[1]], mcp: [auds[1]] },
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
  const domainHosts = [dashboardHost, ...(single ? (legacyHost ? [legacyHost] : []) : [mcpHost])];
  const domains = domainHosts.map((hostname, index) => new cf.WorkersCustomDomain(
    index === 0 ? 'DashboardDomain' : 'McpDomain', {
      accountId: config.accountId, zoneId: config.zoneId, hostname, service: worker.nodes.worker.scriptName,
      environment: 'production', enabled: true, previewsEnabled: false,
    }, { dependsOn: [...access.map(({ app }) => app), alternateUrls] },
  ));
  // Expose endpoints only; principals, AUDs and token are never stack outputs.
  return { dashboardUrl: `https://${dashboardHost}`, mcpUrl: `https://${mcpHost}/mcp`,
    worker, access, alternateUrls, domains };
}
