import { generateKeyPair, exportJWK, SignJWT } from 'jose';
export const issuer = 'https://test-team.cloudflareaccess.com';
export const audience = 'test-audience';
export const actor = 'owner@example.invalid';
export async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  return {
    jwks: { keys: [jwk] },
    async token(overrides = {}, key = privateKey, kid = 'test-key') {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ iss: issuer, aud: audience, sub: 'test-subject', email: actor, iat: now, exp: now + 600, ...overrides })
        .setProtectedHeader({ alg: 'RS256', kid }).sign(key);
    },
  };
}
