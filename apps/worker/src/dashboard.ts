import { translate, stateKey, type Locale } from '@supervisor/core/i18n';
import { waitingOnYou } from '@supervisor/core/identity';
import type { Identity, RecordValue } from '@supervisor/core/schema';

const LINK_KEYS = ['slack', 'changes', 'preview', 'issues', 'other'] as const;
// Free-form MCP data may carry partial links (e.g. only slack/changes); always emit all slots.
export function normalizeLinks(links: unknown) {
  const source = links && typeof links === 'object' && !Array.isArray(links) ? links as Record<string, unknown> : {};
  return Object.fromEntries(LINK_KEYS.map(key => [key, Array.isArray(source[key])
    ? (source[key] as unknown[]).filter(item => item !== null && typeof item === 'object') : []])) as Record<typeof LINK_KEYS[number], unknown[]>;
}

export function dashboardData(snapshot: { version: number; records: RecordValue[] }, viewer?: Identity, locale: Locale = 'en', timezone = 'UTC') {
  const { records, version } = snapshot;
  return {
    schemaVersion: 1, version, title: translate(locale, 'appTitle'), locale, timezone,
    generatedAt: new Date().toISOString(), sourceRevision: `do:${version}`,
    repository: null, sourceCoverage: [],
    records: records.map(r => {
      const claim = r.data.lastCheck as Record<string, unknown> | undefined;
      const claimed = claim && typeof claim === 'object' && 'actor' in claim;
      const state = claimed ? (typeof claim.actor === 'string' && typeof claim.source === 'string' ? 'clientClaim' : 'claimMissing')
        : typeof r.data.stateLabel === 'string' && r.data.stateLabel ? null : stateKey(r.data.state ?? 'verification');
      const values = claimed ? { actor: claim.actor, source: claim.source } : {};
      const kind = typeof r.data.kind === 'string' && r.data.kind ? null : 'task';
      return {
        recordId: r.id, project: '', agent: '', kind: translate(locale, 'task'), name: r.id,
        goal: '', owner: '', state: 'verification', status: '', nextStep: '', waitingOn: '',
        sourceAt: null, evidenceType: 'recorded_evidence', independentFunctionalTest: false,
        ...r.data, links: normalizeLinks(r.data.links), id: r.id, checkedAt: r.checkedAt, rev: r.rev, updatedAt: r.updatedAt,
        stateLabel: state ? translate(locale, state, values) : r.data.stateLabel,
        ...(claimed ? { evidenceType: 'client_claim', independentFunctionalTest: false } : {}),
        // Keys identify generated UI labels, never user text or identity matches.
        generatedLabels: { state, values, kind },
        // Always overwrite any stored/client-supplied projection.
        waitingOnYou: waitingOnYou(r.data, viewer),
      };
    }),
  };
}
