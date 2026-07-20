import { describe, expect, it } from 'vitest';

import { chooseSource } from '../src/lib/resolve/source-selector.js';
import { rankServiceCandidates, resolveServiceCandidate, toAmbiguousViews } from '../src/lib/resolve/service-resolver.js';
import type { GCPCandidateInput } from '../src/lib/resolve/service-resolver.js';
import type { RepoSignals } from '../src/lib/repo/signals.js';
import type { SourceAuthority } from '../src/contracts.js';

function signals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], ...overrides };
}

function input(id: string, overrides: Partial<GCPCandidateInput> = {}): GCPCandidateInput {
  return {
    id,
    name: id.split('/').pop() ?? id,
    providerType: 'api-gateway',
    authority: 'stored-authoritative',
    tags: {},
    supported: true,
    ...overrides
  };
}

describe('source selector', () => {
  it('repo spec always wins with stored-authoritative authority', () => {
    const result = chooseSource({
      existingSpecPath: 'openapi.yaml',
      existingSpecFormat: 'openapi-yaml',
      fallbackServiceName: 'payments'
    });
    expect(result.status).toBe('resolved');
    expect(result.sourceType).toBe('repo-spec');
    expect(result.authority).toBe('stored-authoritative');
    expect(result.confidence).toBe(70);
  });

  it('supported unambiguous candidate above minimum confidence resolves with provider source type', () => {
    const ranked = resolveServiceCandidate(
      [input('/x/apis/payments', { apiId: '/x/apis/payments', tags: { 'postman-project-name': 'payments' } })],
      signals({ serviceHints: ['payments'] })
    );
    expect(ranked).toBeDefined();
    const result = chooseSource({ candidate: ranked });
    expect(result.status).toBe('resolved');
    expect(result.sourceType).toBe('api-gateway-config');
    expect(result.authority).toBe('stored-authoritative');
    expect(result.apiId).toBe('/x/apis/payments');
  });

  it('GCP-NARROW-005: equal-confidence tie is ambiguous -> manual review, both candidates in stable order, no selection', () => {
    const candidates = [
      input('/x/apis/a', { name: 'payments-a' }),
      input('/x/apis/b', { name: 'payments-b' })
    ];
    const sig = signals({ serviceHints: ['payments'] });
    const best = resolveServiceCandidate(candidates, sig);
    expect(best?.ambiguous).toBe(true);

    const result = chooseSource({ candidate: best, fallbackServiceName: 'unknown-service' });
    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');

    const views = toAmbiguousViews(rankServiceCandidates(candidates, sig));
    expect(views.map((v) => v.resourceId)).toEqual(['.../apis/a', '.../apis/b']);
    expect(views.every((v) => v.authority === 'stored-authoritative')).toBe(true);
    expect(views[0]?.rank).toBe(1);
  });

  it('unsupported candidate cannot resolve even above minimum confidence', () => {
    const ranked = resolveServiceCandidate(
      [input('/x/apis/soap', {
        supported: false,
        authority: 'unsupported-format',
        tags: { 'postman-project-name': 'soap-api' },
        name: 'payments'
      })],
      signals({ serviceHints: ['payments'] })
    );
    const result = chooseSource({ candidate: ranked });
    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');
  });

  it('below minimum confidence goes to manual review', () => {
    const ranked = resolveServiceCandidate([input('/x/apis/a', { name: 'unrelated' })], signals());
    const result = chooseSource({ candidate: ranked });
    expect(result.status).toBe('unresolved');
  });

  it('stored-authoritative ranks above google-generated when otherwise tied', () => {
    const stored = input('/x/apis/stored', {
      name: 'payments',
      sourceType: 'api-gateway-config',
      authority: 'stored-authoritative'
    });
    const generated = input('/x/integrations/generated', {
      name: 'payments',
      sourceType: 'app-integration-trigger',
      providerType: 'app-integration',
      authority: 'google-generated'
    });
    const ranked = rankServiceCandidates([generated, stored], signals({ serviceHints: ['payments'] }));
    expect(ranked.map((candidate) => candidate.resourceId)).toEqual([stored.id, generated.id]);
    expect(ranked[0]!.authority).toBe('stored-authoritative');
    expect(ranked[1]!.authority).toBe('google-generated');
    expect(ranked[0]!.confidence).toBe(ranked[1]!.confidence);
    const resolved = resolveServiceCandidate([generated, stored], signals({ serviceHints: ['payments'] }));
    expect(resolved?.ambiguous).not.toBe(true);
    expect(resolved?.resourceId).toBe(stored.id);
  });

  it('local-derived cannot resolve by explicit hints or labels', () => {
    const local = input('/x/engines/support', {
      name: 'payments',
      sourceType: 'agent-engine-generated-spec',
      providerType: 'agent-engines',
      authority: 'local-derived',
      supported: false,
      tags: { 'postman-project-name': 'payments', 'postman-repo': 'org--payments' },
      apiId: '/x/engines/support'
    });
    const ranked = resolveServiceCandidate(
      [local],
      signals({
        serviceHints: ['payments'],
        explicitApiIdHints: ['/x/engines/support']
      })
    );
    expect(ranked?.confidence).toBeGreaterThanOrEqual(40);
    expect(ranked?.supported).toBe(false);
    expect(ranked?.authority).toBe('local-derived');
    const result = chooseSource({ candidate: ranked });
    expect(result.status).toBe('unresolved');
    expect(result.sourceType).toBe('manual-review');
    expect(result.authority).toBe('local-derived');
  });

  it('metadata-only and unsupported-format remain visible but not exportable', () => {
    const cases: Array<{ authority: SourceAuthority; id: string }> = [
      { authority: 'metadata-only', id: '/x/apis/meta' },
      { authority: 'unsupported-format', id: '/x/apis/grpc' }
    ];
    for (const entry of cases) {
      const ranked = resolveServiceCandidate(
        [input(entry.id, {
          name: 'payments',
          authority: entry.authority,
          supported: false,
          tags: { 'postman-project-name': 'payments' }
        })],
        signals({ serviceHints: ['payments'] })
      );
      expect(ranked?.authority).toBe(entry.authority);
      expect(ranked?.supported).toBe(false);
      expect(chooseSource({ candidate: ranked }).status).toBe('unresolved');
      const views = toAmbiguousViews(rankServiceCandidates(
        [input(entry.id, { name: 'payments', authority: entry.authority, supported: false })],
        signals({ serviceHints: ['payments'] })
      ));
      expect(views[0]?.authority).toBe(entry.authority);
      expect(views[0]?.supported).toBe(false);
    }
  });

  it('penalizes local-derived Agent Engine behind stored-authoritative peers', () => {
    const stored = input('/x/stored', {
      name: 'payments',
      sourceType: 'vertex-extension-manifest',
      providerType: 'vertex-extensions',
      authority: 'stored-authoritative'
    });
    const generated = input('/x/generated', {
      name: 'payments',
      sourceType: 'agent-engine-generated-spec',
      providerType: 'agent-engines',
      authority: 'local-derived',
      supported: false
    });
    const ranked = rankServiceCandidates([generated, stored], signals({ serviceHints: ['payments'] }));
    expect(ranked.map((candidate) => candidate.resourceId)).toEqual([stored.id, generated.id]);
    expect(ranked[1]?.authority).toBe('local-derived');
    expect(ranked[1]?.supported).toBe(false);
  });
});

describe('exact tag equality precedence (GCP-RESOLVE-EXACT)', () => {
  it('exact tag match outranks substring containment so near-name siblings cannot tie', () => {
    const hints = signals({ serviceHints: ['payments-live'] });
    const apimCandidate = input(
      'projects/sample-project-123/locations/global/apis/payments-live/configs/live-config',
      { name: 'Payments Live API', tags: { 'postman-project-name': 'payments-live' } }
    );
    const siteCandidate = input(
      'services/pmspecsite.endpoints.sample-project-123.cloud.goog/configs/2026-01-01r0',
      { name: 'pmspecsite', providerType: 'cloud-endpoints', tags: { 'postman-project-name': 'payments-live-site' } }
    );
    const ranked = rankServiceCandidates([apimCandidate, siteCandidate], hints);
    expect(ranked[0]?.resourceId).toBe(apimCandidate.id);
    expect(ranked[0] && ranked[1] && ranked[0].confidence > ranked[1].confidence).toBe(true);
    const resolved = resolveServiceCandidate([apimCandidate, siteCandidate], hints);
    expect(resolved?.ambiguous).not.toBe(true);
  });

  it('an incidental non-canonical tag does not out-rank the intended near-name match', () => {
    const hints = signals({ serviceHints: ['payments-live'] });
    const intended = input(
      'projects/sample-project-123/locations/global/apis/payments-live/configs/live-config',
      { name: 'Payments Live API', tags: { 'postman-project-name': 'payments-live-v2' } }
    );
    const incidental = input(
      'projects/sample-project-123/locations/global/apis/billing/configs/billing-config',
      { name: 'Billing API', tags: { environment: 'payments-live' } }
    );
    const ranked = rankServiceCandidates([intended, incidental], hints);
    const incidentalRank = ranked.find((c) => c.resourceId === incidental.id);
    expect(incidentalRank?.confidence).toBeLessThanOrEqual(40);
    expect(incidentalRank?.evidence.some((e) => e.includes('Canonical ownership tag'))).not.toBe(true);
  });
});
