import { expect, it } from 'vitest';
import { SupervisorLive as policy, SupervisorTheme as theme } from '../src/app.js';
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

it('resolves only supported saved themes and defaults to System', () => {
  for (const value of ['light', 'dark', 'system']) expect(theme.resolve(() => ({ getItem: key => key === 'supervisor.theme' ? value : null }))).toBe(value);
  for (const value of [null, '', 'broken', '"dark"', 'DARK']) expect(theme.resolve(() => ({ getItem: () => value }))).toBe('system');
  expect(theme.resolve(() => { throw new Error('Blocked'); })).toBe('system');
  expect(theme.resolve(() => ({ getItem() { throw new Error('Blocked'); } }))).toBe('system');
});
it('persists valid choices and tolerates unavailable storage and quota errors', () => {
  const values = new Map();
  const storage = () => ({ setItem: (key, value) => values.set(key, value) });
  for (const value of ['light', 'dark', 'system']) {
    theme.persist(storage, value);
    expect(values.get('supervisor.theme')).toBe(value);
  }
  theme.persist(storage, 'broken');
  expect(values.get('supervisor.theme')).toBe('system');
  expect(() => theme.persist(() => { throw new Error('Blocked'); }, 'dark')).not.toThrow();
  expect(() => theme.persist(() => ({ setItem() { throw new Error('Quota'); } }), 'light')).not.toThrow();
});
it('follows system appearance only for System', () => {
  for (const dark of [false, true]) {
    expect(theme.effective('system', dark)).toBe(dark ? 'dark' : 'light');
    expect(theme.effective('light', dark)).toBe('light');
    expect(theme.effective('dark', dark)).toBe('dark');
  }
});
