import { expect, it } from 'vitest';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { schemas } from '@supervisor/core/schema';
import { checkBundle } from '../check-bundle.mjs';
it('ships a UI-only shell and schema-valid optional sample writes', async () => {
  const files = readdirSync('apps/dashboard/dist').sort();
  expect(files).toEqual(['app.js', 'favicon-review.svg', 'favicon.svg', 'index.html', 'style.css']);
  const html = readFileSync('apps/dashboard/dist/index.html', 'utf8');
  expect(html).toContain('content="/api/data.json"');
  expect(html).toContain('content="/api/ws"');
  expect(html).not.toContain('./data.js');
  expect(html).not.toContain('href="https://github.com/');
  const sample = JSON.parse(readFileSync('examples/sample-records.json', 'utf8'));
  for (const item of sample) expect(schemas.upsert_record.parse(item)).toEqual(item);
  await checkBundle();
});
it('fails the deployed-bundle gate when test authentication enters an embedded asset', async () => {
  const file = 'apps/worker/src/generated/assets.ts';
  const original = readFileSync(file, 'utf8');
  try {
    writeFileSync(file, original.replace('Supervisor', 'TEST_JWKS'));
    await expect(checkBundle()).rejects.toThrow('Forbidden bundle marker: TEST_JWKS');
  } finally { writeFileSync(file, original); }
});
