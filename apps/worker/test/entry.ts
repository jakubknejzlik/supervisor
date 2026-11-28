// TEST-ONLY entrypoint. SST uses apps/worker/src/worker.ts, which cannot read TEST_JWKS.
import { createLocalJWKSet } from 'jose';
import { routeClass } from '../src/auth';
import { createWorker, type Env } from '../src/worker';
export { SupervisorStore } from '../src/store';
export default {
  fetch(request: Request<unknown, IncomingRequestCfProperties>, env: Env & { TEST_JWKS: string; TEST_LOCAL_ASSERTION?: string }, ctx: ExecutionContext) {
    if (env.TEST_LOCAL_ASSERTION && !request.headers.has('Cf-Access-Jwt-Assertion')) {
      const headers = new Headers(request.headers);
      headers.set('Cf-Access-Jwt-Assertion', JSON.parse(env.TEST_LOCAL_ASSERTION)[routeClass(new URL(request.url).pathname)]);
      request = new Request(request, { headers }) as typeof request;
    }
    return createWorker(createLocalJWKSet(JSON.parse(env.TEST_JWKS))).fetch!(request, env, ctx);
  },
};
