import { negotiateLocale, translate, displayTimezone } from '@supervisor/core/i18n';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { JWTVerifyGetKey } from 'jose';
import { authenticate, AuthError, type AuthEnv } from './auth';
import { schemas, isWrite, type Tool } from '@supervisor/core/schema';
import { SupervisorStore, type StoreEnv } from './store';
import { dashboardData } from './dashboard';
import assets from './generated/assets';
export { SupervisorStore };
export type Env = AuthEnv & StoreEnv & { STORE: DurableObjectNamespace<SupervisorStore>; DISPLAY_TIMEZONE?: string };
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };

export function createWorker(testKey?: JWTVerifyGetKey): ExportedHandler<Env> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const store = env.STORE.get(env.STORE.idFromName('supervisor-store-v1'));
      let identity;
      try { identity = await authenticate(request, env, testKey); }
      catch (e) { return Response.json({ error: 'forbidden' }, { status: e instanceof AuthError ? e.status : 403, headers }); }
      const locale = negotiateLocale(request.headers.get('Accept-Language'));
      // No OAuth routes or WWW-Authenticate here: Cloudflare Access owns both.
      if (url.pathname === '/api/ws') {
        if (!identity.capabilities.includes('supervisor:read')) return Response.json({ error: 'insufficient_scope' }, { status: 403, headers });
        return store.fetch(request);
      }
      if (url.pathname === '/api/data.json') {
        if (!identity.capabilities.includes('supervisor:read')) return Response.json({ error: 'insufficient_scope' }, { status: 403, headers });
        if (request.method !== 'GET') return new Response(null, { status: 405, headers });
        return Response.json(dashboardData(await store.dashboard(), identity, locale, displayTimezone(env.DISPLAY_TIMEZONE)), { headers });
      }
      if (url.pathname === '/mcp') {
        const server = new McpServer({ name: 'supervisor-live', version: '0.1.0' });
        for (const name of Object.keys(schemas) as Tool[]) {
          server.registerTool(name, {
            description: `${name}: requires ${isWrite(name) ? 'supervisor:write' : 'supervisor:read'} application capability.`,
            inputSchema: schemas[name],
            annotations: { readOnlyHint: !isWrite(name), destructiveHint: false, idempotentHint: !isWrite(name), openWorldHint: false },
          }, async (args: Record<string, unknown>) => {
            try {
              // RPC errors do not preserve custom properties: serialize inside DO boundary below.
              const result = JSON.parse(await store.call(name, args, identity)) as { value?: unknown; error?: { error: string; currentRev?: number } };
              return { content: [{ type: 'text' as const, text: JSON.stringify(result.value ?? result.error) }], ...(result.error ? { isError: true } : {}) };
            } catch { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'internal_error' }) }] }; }
          });
        }
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        try {
          const response = await transport.handleRequest(request);
          const wrapped = new Response(response.body, response);
          for (const [key, value] of Object.entries(headers)) wrapped.headers.set(key, value);
          return wrapped;
        } finally { await server.close(); }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers });
      const asset = assets[url.pathname === '/' ? '/index.html' : url.pathname];
      if (!asset) return new Response(translate(locale, 'notFoundPage'), { status: 404, headers });
      const body = asset.type.startsWith('text/html') ? asset.body.replace('<head>', `<head><meta name="supervisor-locale" content="${locale}">`) : asset.body;
      return new Response(request.method === 'HEAD' ? null : body, { headers: { ...headers, 'Content-Type': asset.type } });
    },
  };
}
export default createWorker();
