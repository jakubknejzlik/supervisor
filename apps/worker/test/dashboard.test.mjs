import { expect, it } from 'vitest';
import { dashboardData } from '../src/dashboard.ts';
it('production projection always emits all five link slots for partial MCP links', () => {
  const rec = (id, data) => ({ id, data, rev: 1, checkedAt: null, updatedAt: '2026-11-24T00:00:00Z' });
  const out = dashboardData({ version: 3, records: [
    rec('sample-c:partial-two-slots', { agent: 'Agent C', links: { slack: [{ label: 'S', url: 'https://s' }], changes: [] } }),
    rec('sample-c:partial-one-slot', { agent: 'Agent C', links: { slack: [] } }),
    rec('sample-c:partial-four-slots', { agent: 'Agent C', links: { slack: [], changes: [], preview: [], issues: [] } }),
    rec('sample:no-links', { agent: 'Agent A' }),
    rec('sample:bad-links', { agent: 'Agent A', links: 'oops' }),
  ] });
  expect(out.repository).toBeNull();
  for (const r of out.records) expect(Object.keys(r.links).sort()).toEqual(['changes', 'issues', 'other', 'preview', 'slack']);
  for (const r of out.records) for (const v of Object.values(r.links)) expect(Array.isArray(v)).toBe(true);
  expect(out.records[0].links.slack).toEqual([{ label: 'S', url: 'https://s' }]);
});
