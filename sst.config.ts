/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  async app(input) {
    // Only the local SDK installer may evaluate app metadata without config.
    // Normal SST commands fail before state bootstrap when config is missing.
    const config = process.env.SUPERVISOR_SDK_INSTALL === '1'
      ? undefined : (await import('./infra/config')).loadDeploymentConfig(input.stage);
    return {
      name: config?.appName ?? 'supervisor', home: 'cloudflare',
      removal: input.stage === 'production' ? 'retain' : 'remove',
      protect: input.stage === 'production',
      providers: { cloudflare: { version: '6.24.0', accountId: config?.accountId } },
    };
  },
  async run() {
    const config = (await import('./infra/config')).loadDeploymentConfig($app.stage);
    const graph = (await import('./infra/supervisor')).supervisor(config);
    return { dashboardUrl: graph.dashboardUrl, mcpUrl: graph.mcpUrl };
  },
});
