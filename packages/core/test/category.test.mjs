import { expect, it } from 'vitest';
import { effectiveCategory } from '@supervisor/core/category';
import { recordPatch, schemas } from '@supervisor/core/schema';

const invalid = ['', '   ', 'a'.repeat(65), 42, false, {}, []];
for (let code = 0; code <= 0x1f; code++) invalid.push(` ${String.fromCharCode(code)}Category `);
invalid.push('Category\u007f');

it('validates the same trimmed category bounds on writes and list filters', () => {
  for (const value of ['Category', ' a ', 'a'.repeat(64), ` ${'a'.repeat(64)} `, 'Vývoj']) {
    expect(recordPatch.parse({ category: value }).category).toBe(value.trim());
    expect(schemas.list_records.parse({ category: value }).category).toBe(value.trim());
  }
  for (const category of invalid) {
    expect(recordPatch.safeParse({ category }).success).toBe(false);
    expect(schemas.list_records.safeParse({ category }).success).toBe(false);
  }
  expect(recordPatch.parse({ category: null })).toEqual({ category: null });
  expect(schemas.list_records.safeParse({ category: null }).success).toBe(false);
  expect(recordPatch.parse({ agent: 'Agent A', owner: 'Operator', project: 'sample', custom: { keep: true } }))
    .toEqual({ agent: 'Agent A', owner: 'Operator', project: 'sample', custom: { keep: true } });
});

it('projects category then the original agent/project fallback without mutation', () => {
  const record = Object.freeze({ category: ' Category ', agent: 'Agent A', project: 'sample', owner: 'Operator' });
  expect(effectiveCategory(record)).toBe('Category');
  expect(record.category).toBe(' Category ');
  for (const category of [...invalid, null, undefined]) {
    expect(effectiveCategory({ ...record, category })).toBe('Agent A');
    expect(effectiveCategory({ project: 'sample', category })).toBe('sample');
    expect(effectiveCategory({ category })).toBeNull();
  }
  expect(effectiveCategory({ agent: '', project: 'sample' })).toBe('sample');
  expect(effectiveCategory({ owner: 'Operator', group: 'Ignored' })).toBeNull();
});
