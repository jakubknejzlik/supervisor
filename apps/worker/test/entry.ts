// TEST-ONLY entrypoint. SST uses apps/worker/src/worker.ts, which cannot read TEST_JWKS.
import { createLocalJWKSet } from 'jose';
import { createWorker, type Env } from '../src/worker';
export { SupervisorStore } from '../src/store';
export default {
  fetch(request: Request<unknown, IncomingRequestCfProperties>, env: Env & { TEST_JWKS: string; TEST_LOCAL_ASSERTION?: string }, ctx: ExecutionContext) {
    if (env.TEST_LOCAL_ASSERTION && !request.headers.has('Cf-Access-Jwt-Assertion')) {
      const headers = new Headers(request.headers);
      headers.set('Cf-Access-Jwt-Assertion', env.TEST_LOCAL_ASSERTION);
      request = new Request(request, { headers }) as typeof request;
    }
    return createWorker(createLocalJWKSet(JSON.parse(env.TEST_JWKS))).fetch!(request, env, ctx);
  },
};
