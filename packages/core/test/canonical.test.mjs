import { expect, it } from 'vitest';
import { canonical } from '../src/canonical.ts';
it('preserves canonical comparison after extraction from the legacy importer', () => {
  expect(canonical({ z: [{ b: 2, a: 1 }], a: null })).toBe(canonical({ a: null, z: [{ a: 1, b: 2 }] }));
  expect(canonical(['a', 'b'])).not.toBe(canonical(['b', 'a']));
});
