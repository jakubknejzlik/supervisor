import { beforeAll, afterAll, expect, it } from 'vitest';
import { runtime } from './runtime.mjs';
import { fixture } from './fixture.mjs';
import { dashboardData } from '../src/dashboard.ts';
let mf, token;
beforeAll(async () => { const keys = await fixture(); token = await keys.token(); mf = await runtime(keys.jwks, { extraBindings: { DISPLAY_TIMEZONE: 'Europe/Prague' } }); });
afterAll(async () => { await mf?.dispose(); });
it.each([
  ['cs;q=0.9,en;q=0.1,private-canary;q=0.8', 'cs'],
  ['en-US;q=0.9,cs-CZ;q=0.2,private-canary', 'en'],
  ['de,private-canary', 'en'],
])('embeds only the negotiated locale and never the header: %s', async (header, locale) => {
  const headers = { 'Cf-Access-Jwt-Assertion': token, 'Accept-Language': header };
  const response = await mf.dispatchFetch('http://127.0.0.1/', { headers });
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const html = await response.text();
  expect(html).toContain(`<meta name="supervisor-locale" content="${locale}">`);
  expect(html).not.toContain(header); expect(html).not.toContain('private-canary');
  const data = await (await mf.dispatchFetch('http://127.0.0.1/api/data.json', { headers })).json();
  expect(data.locale).toBe(locale); expect(data.timezone).toBe('Europe/Prague');
  expect(JSON.stringify(data)).not.toContain('private-canary');
});
it('localizes generated labels and preserves record text, identity projection and stored timestamps', () => {
  const at = '2026-11-27T00:00:00Z';
  const records = [
    { id: 'sample:default', rev: 1, checkedAt: at, updatedAt: at, data: { name: 'Původní text', state: 'running' } },
    { id: 'sample:claim', rev: 1, checkedAt: at, updatedAt: at, data: { lastCheck: { actor: 'Sample actor', source: 'manual' } } },
    { id: 'sample:custom', rev: 1, checkedAt: at, updatedAt: at, data: { stateLabel: 'Custom state text', kind: 'Custom kind', status: 'Původní výsledek', waitingOn: 'Waiting on you' } },
  ];
  const before = JSON.stringify(records);
  const en = dashboardData({ version: 2, records }, undefined, 'en');
  const cs = dashboardData({ version: 2, records }, undefined, 'cs');
  expect(en.records[0].stateLabel).toBe('Running'); expect(cs.records[0].stateLabel).toBe('Rozpracováno');
  expect(cs.records[0].kind).toBe('Úkol'); expect(en.records[0].kind).toBe('Task');
  expect(cs.records[1].stateLabel).toBe('Zkontrolováno — tvrzení od Sample actor přes manual');
  expect(en.records[1].stateLabel).toBe('Checked — claimed by Sample actor via manual');
  for (const snapshot of [en, cs]) {
    expect(snapshot.records[0].name).toBe('Původní text');
    expect(snapshot.records[2].stateLabel).toBe('Custom state text');
    expect(snapshot.records[2].kind).toBe('Custom kind');
    expect(snapshot.records[2].status).toBe('Původní výsledek');
    expect(snapshot.records.every(record => record.waitingOnYou === false)).toBe(true);
    expect(snapshot.records[0].checkedAt).toBe(at);
  }
  expect(JSON.stringify(records)).toBe(before);
});
