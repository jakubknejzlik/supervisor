import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyCompatibilityPatch } from '../../scripts/prepare-sst.ts';
const hash = text => createHash('sha256').update(text).digest('hex');
it('pins the root dependency and SST provider configuration together', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(manifest.devDependencies.sst).toBe('4.17.1');
  expect(manifest.devDependencies['@pulumi/cloudflare']).toBe('6.24.0');
  expect(readFileSync('sst.config.ts', 'utf8')).toContain("version: '6.24.0'");
});
it('applies an exact SDK correction once and fails closed on changed upstream source', () => {
  const patch = { file: 'fixture.ts', old: 'before', replacement: 'after', before: hash('before'), after: hash('after') };
  expect(applyCompatibilityPatch('before', patch)).toBe('after');
  expect(applyCompatibilityPatch('after', patch)).toBe('after');
  expect(() => applyCompatibilityPatch('before with upstream changes', patch)).toThrow('Unreviewed');
  expect(() => applyCompatibilityPatch('before', { ...patch, after: hash('wrong') })).toThrow('checksum');
});
