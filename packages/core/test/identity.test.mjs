import { expect, it } from 'vitest';
import { waitingOnYou } from '../src/identity.ts';
import { dashboardData } from '../../../apps/worker/src/dashboard.ts';
const issuer = 'https://team-example.cloudflareaccess.com';
const viewer = { issuer, sub: 'Subject-A', email: 'REVIEWER@example.invalid', clientId: null, capabilities: ['supervisor:read'] };
it('matches exact issuer/subject or validated case-normalized email only', () => {
  for (const principal of [{ issuer, sub: 'Subject-A' }, { email: 'reviewer@EXAMPLE.INVALID' }, { issuer, sub: 'Subject-A', email: 'other@example.invalid' }]) {
    expect(waitingOnYou({ requestedFrom: [principal] }, viewer)).toBe(true);
  }
  for (const requestedFrom of [undefined, null, [], {}, [{ email: '' }], [{ email: 'Reviewer' }], [{ sub: 'Subject-A' }], [{ issuer, sub: '' }], [{ issuer, sub: 'subject-a', email: viewer.email }], [{ issuer: 'https://other.cloudflareaccess.com', sub: viewer.sub, email: viewer.email }]]) {
    expect(waitingOnYou({ requestedFrom }, viewer)).toBe(false);
  }
});
it('suppresses inactive states and missing identity; legacy text has no effect', () => {
  const data = { requestedFrom: [{ issuer, sub: viewer.sub }] };
  for (const state of ['done', 'paused', 'deferred', 'backlog']) expect(waitingOnYou({ ...data, state }, viewer)).toBe(false);
  for (const identity of [undefined, { ...viewer, sub: '' }, { ...viewer, issuer: '' }]) expect(waitingOnYou(data, identity)).toBe(false);
  expect(waitingOnYou({ waitingOn: 'Reviewer', nextAction: { isViewer: true } }, viewer)).toBe(false);
});
it('overwrites stale stored projections without mutating the snapshot', () => {
  const record = { id: 'sample:legacy', data: { waitingOnYou: true, requestedFrom: null }, rev: 1, checkedAt: null, updatedAt: '2026-01-01T00:00:00Z' };
  const snapshot = { version: 1, records: [record] };
  expect(dashboardData(snapshot, viewer).records[0].waitingOnYou).toBe(false);
  expect(record.data.waitingOnYou).toBe(true);
});
