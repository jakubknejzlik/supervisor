import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { issuer, audience, actor } from './fixture.mjs';
/** @param {object} jwks
 * @param {{ port?: number, permissions?: string[], persist?: string, audiences?: Record<string, string[]>, extraBindings?: Record<string, string> }} options
 */
export async function runtime(jwks, { port = 0, permissions = ['supervisor:read', 'supervisor:write'], persist, audiences, extraBindings = {} } = {}) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./entry.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'], target: 'es2022' });
  return new Miniflare(convertV4MiniflareOptions({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-11-23', compatibilityFlags: ['nodejs_compat'], port,
    durableObjects: { STORE: { className: 'SupervisorStore', useSQLite: true } },
    ...(persist ? { resourcePersistencePath: persist, isolatedResourcePersistencePath: persist } : {}),
    bindings: { ACCESS_TEAM_DOMAIN: new URL(issuer).host, ACCESS_AUDS: JSON.stringify(audiences ?? { '127.0.0.1': [audience], localhost: [audience] }), ...extraBindings, ALLOWED_EMAILS: JSON.stringify({ [actor]: permissions, 'reader@example.invalid': ['supervisor:read'] }), TEST_JWKS: JSON.stringify(jwks) },
  }));
}
