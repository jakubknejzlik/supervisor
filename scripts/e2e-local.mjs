import { fixture } from '../apps/worker/test/fixture.mjs';
import { runtime } from '../apps/worker/test/runtime.mjs';
import { exercise } from './exercise.mjs';
const keys = await fixture();
const mf = await runtime(keys.jwks);
try {
  const url = await mf.ready;
  console.log('Started local Miniflare + SQLite DO with test-only JWKS entrypoint');
  await exercise(url, { 'Cf-Access-Jwt-Assertion': await keys.token() }, 'local');
} finally { await mf.dispose(); }
