import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { emailAddress, type Identity, type Capability } from '@supervisor/core/schema';
export type AuthEnv = {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDS: string; // JSON: exact hostname -> route class -> nonempty audience list.
  ALLOWED_EMAILS: string;
};
export class AuthError extends Error {
  constructor(public status: 401 | 403) { super('forbidden'); }
}
export function routeClass(path: string): 'mcp' | 'dashboard' {
  return path === '/mcp' ? 'mcp' : 'dashboard';
}
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
async function assertion(request: Request, env: AuthEnv, testKey?: JWTVerifyGetKey) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new AuthError(401);
  const url = new URL(request.url);
  const configured = JSON.parse(env.ACCESS_AUDS);
  const host = configured && Object.hasOwn(configured, url.hostname) ? configured[url.hostname] : undefined;
  const kind = routeClass(url.pathname);
  const audiences = host && !Array.isArray(host) && Object.hasOwn(host, kind) ? host[kind] : undefined;
  if (!Array.isArray(audiences) || !audiences.length || !audiences.every(a => typeof a === 'string' && a.length > 0) || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)) throw new AuthError(403);
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let remoteKey = keySets.get(issuer);
  if (!testKey && !remoteKey) {
    remoteKey = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, remoteKey);
  }
  return (await jwtVerify(token, testKey ?? remoteKey!, {
    algorithms: ['RS256'], issuer, audience: audiences, requiredClaims: ['exp', 'iat'],
  })).payload;
}
export async function authenticate(request: Request, env: AuthEnv, testKey?: JWTVerifyGetKey): Promise<Identity> {
  const payload = await assertion(request, env, testKey);
  if (payload.common_name !== undefined || !emailAddress.safeParse(payload.email).success || typeof payload.sub !== 'string' || !payload.sub.trim()) throw new AuthError(403);
  const allowList = JSON.parse(env.ALLOWED_EMAILS) as Record<string, Capability[]>;
  const email = emailAddress.parse(payload.email);
  if (!Object.hasOwn(allowList, email) || !Array.isArray(allowList[email])) throw new AuthError(403);
  const capabilities = allowList[email].filter(value => value === 'supervisor:read' || value === 'supervisor:write');
  // No documented Managed OAuth client-id claim. Do not guess one.
  return { issuer: payload.iss!, sub: payload.sub, email, clientId: null, capabilities };
}
