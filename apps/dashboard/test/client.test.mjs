import { expect, it } from 'vitest';
import { SupervisorLive as policy } from '../src/app.js';
it('client version gating ignores duplicates, stale and malformed changes', () => {
  for (const event of [{ type: 'changed', version: 4 }, { type: 'changed', version: 5 }, { type: 'other', version: 6 }, { type: 'changed', version: '6' }, { type: 'changed', version: NaN }, null]) expect(policy.needsRefresh(event, 5)).toBe(false);
  expect(policy.needsRefresh({ type: 'changed', version: 6, ids: [] }, 5)).toBe(true);
});
it('client reconnect backoff grows exponentially with jitter and caps at 30 seconds', () => {
  expect([0, 1, 2, 3, 4, 5, 1000].map(n => policy.reconnectDelay(n, 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  expect(policy.reconnectDelay(0, 0)).toBe(500);
  expect(policy.reconnectDelay(1000, 0)).toBe(15000);
  expect(policy.reconnectDelay(2, .5)).toBe(3000);
});
it('client normalizes partial MCP links so every slot is an array (partial-link regression)', () => {
  const records = policy.normalizeRecords([
    { id: 'a', links: { slack: [{ label: 'S', url: 'https://slack.example.invalid/a' }], changes: [] } },
    { id: 'b', links: { slack: [] } },
    { id: 'c', links: { slack: [], changes: [], preview: [], issues: [] } },
    { id: 'd' }, { id: 'e', links: [] }, { id: 'f', links: { issues: 'x', other: [null, 1, { label: 'o', url: 'https://o' }] } }, null,
  ]);
  expect(records).toHaveLength(6);
  for (const r of records) for (const key of ['slack', 'changes', 'preview', 'issues', 'other']) expect(Array.isArray(r.links[key])).toBe(true);
  expect(records[0].links.slack).toHaveLength(1);
  expect(records[5].links.issues).toEqual([]);
  expect(records[5].links.other).toHaveLength(1);
});
