import { afterEach, expect, it, vi } from 'vitest';
vi.stubGlobal('$config', config => config);
const { default: root } = await import('../../sst.config.ts');
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const selectExample = () => {
  vi.stubEnv('SUPERVISOR_SDK_INSTALL', '');
  vi.stubEnv('SUPERVISOR_CONFIG', 'examples/deploy.config.example.json');
  vi.stubEnv('CLOUDFLARE_DEFAULT_ACCOUNT_ID', '00000000000000000000000000000000');
};
it('fails missing config in app metadata before any state bootstrap', async () => {
  vi.stubEnv('SUPERVISOR_SDK_INSTALL', ''); vi.stubEnv('SUPERVISOR_CONFIG', '');
  await expect(root.app({ stage: 'test' })).rejects.toThrow('SUPERVISOR_CONFIG');
});
it('selects the explicit app/account with stage-scoped state and rejects mismatched stage', async () => {
  selectExample();
  const app = await root.app({ stage: 'test' });
  expect(app).toMatchObject({ name: 'supervisor', home: 'cloudflare', removal: 'remove', protect: false });
  // Provider 6.x rejects `cloudflare:accountId`; the account is passed per resource.
  expect(app.providers).toEqual({ cloudflare: { version: '6.24.0' } });
  await expect(root.app({ stage: 'production' })).rejects.toThrow('Values redacted');
});
it('allows only SDK metadata without config; run still fails closed', async () => {
  vi.stubEnv('SUPERVISOR_SDK_INSTALL', '1'); vi.stubEnv('SUPERVISOR_CONFIG', '');
  expect(await root.app({ stage: 'production' })).toMatchObject({ home: 'cloudflare', removal: 'retain', protect: true });
  vi.stubGlobal('$app', { stage: 'production' });
  await expect(root.run()).rejects.toThrow('SUPERVISOR_CONFIG');
});
