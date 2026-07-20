import { describe, expect, it } from 'vitest';

import type { SpecCandidate } from '../src/lib/providers/types.js';
import type { RepoSignals } from '../src/lib/repo/signals.js';
import {
  canonicalRepoLabelValue,
  runNarrowingPipeline,
  type NarrowingCandidate
} from '../src/lib/resolve/narrowing-pipeline.js';
import { partitionCandidates } from '../src/runtime.js';

function signals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return { serviceHints: [], explicitApiIdHints: [], inferredApiIdHints: [], evidence: [], ...overrides };
}

function candidate(id: string, overrides: Partial<NarrowingCandidate> = {}): NarrowingCandidate {
  return { id, name: id.split('/').pop() ?? id, projectId: 'sample-project-123', ...overrides };
}

function specCandidate(id: string, overrides: Partial<SpecCandidate> = {}): SpecCandidate {
  return {
    id,
    name: id.split('/').pop() ?? id,
    providerType: 'api-gateway',
    authority: 'stored-authoritative',
    projectId: 'sample-project-123',
    tags: {},
    supported: true,
    evidence: [],
    meta: {},
    ...overrides
  };
}

const context = (overrides: Record<string, unknown> = {}) => ({
  repoSlug: 'org/payments', projectId: 'sample-project-123', serviceHints: [], signals: signals(), ...overrides
});

describe('GCP narrowing pipeline', () => {
  it('GCP-NARROW-001: first non-empty tier wins in locked order', async () => {
    expect((await runNarrowingPipeline(context({ signals: signals({ inferredApiIdHints: ['/x/pay'] }) }), [candidate('/x/pay'), candidate('/x/other')]))?.tier).toBe('iac-fingerprint');
    expect((await runNarrowingPipeline(context({ repoSlug: 'org/payments-service', projectId: 'payments-platform-123' }), [candidate('/x/a', { projectId: 'payments-platform-123' })]))?.tier).toBe('project-correlation');
    expect((await runNarrowingPipeline(context(), [candidate('/x/a', { tags: { 'postman-repo': 'org--payments' } }), candidate('/x/b')]))?.tier).toBe('label-prefilter');
    expect((await runNarrowingPipeline(context(), [candidate('/x/payments-api'), candidate('/x/orders')]))?.tier).toBe('naming-heuristic');
  });

  it('GCP-NARROW-001: partition never deletes, stale IDs fall through, and duplicates collapse', async () => {
    const enumerated = ['/x/a', '/x/b', '/x/payments', '/x/d'].map((id) => specCandidate(id));
    const narrowing = await runNarrowingPipeline(context(), enumerated.map((value) => candidate(value.id)));
    expect(narrowing).toMatchObject({ apiIds: ['/x/payments'], droppedCount: 3 });
    expect(narrowing?.evidence.join(' ')).toContain('demoted 3 (not deleted)');
    expect(partitionCandidates(enumerated, narrowing).map((value) => value.id)).toEqual(['/x/payments', '/x/a', '/x/b', '/x/d']);
    expect(await runNarrowingPipeline(context({ repoSlug: undefined, signals: signals({ inferredApiIdHints: ['/gone', '/gone'] }) }), [candidate('/real')])).toBeUndefined();
    expect((await runNarrowingPipeline(context({ repoSlug: undefined, signals: signals({ inferredApiIdHints: ['/real', '/real'] }) }), [candidate('/real')]))?.apiIds).toEqual(['/real']);
  });

  it('GCP-NARROW-001: canonical label encoding is exact and only one canonical match selects', async () => {
    expect(canonicalRepoLabelValue('Postman/Payments API')).toBe('postman--payments-api');
    expect(canonicalRepoLabelValue(`org/${'x'.repeat(70)}`)).toBeUndefined();
    const single = await runNarrowingPipeline(context(), [candidate('/a', { tags: { 'postman-repo': 'org--payments' } }), candidate('/b')]);
    expect(single?.mode).toBe('select');
    const double = await runNarrowingPipeline(context(), [candidate('/a', { tags: { 'postman-repo': 'org--payments' } }), candidate('/b', { tags: { 'postman-repo': 'org--payments' } })]);
    expect(double?.mode).toBe('narrow');
    for (const key of ['repo', 'repository', 'service']) {
      expect((await runNarrowingPipeline(context(), [candidate('/a', { tags: { [key]: 'org--payments' } })]))?.mode).toBe('narrow');
    }
  });

  it('GCP-NARROW-001: candidate cap is applied only after partition', async () => {
    const enumerated = Array.from({ length: 75 }, (_, index) => specCandidate(`/x/api-${String(index).padStart(2, '0')}`));
    enumerated[69] = specCandidate('/x/target', { tags: { 'postman-repo': 'org--target' } });
    const narrowing = await runNarrowingPipeline(context({ repoSlug: 'org/target' }), enumerated.map((value) => candidate(value.id, { tags: value.tags })));
    const partitioned = partitionCandidates(enumerated, narrowing);
    expect(partitioned).toHaveLength(75);
    expect(partitioned[0]?.id).toBe('/x/target');
    expect(partitioned.slice(0, 50)).toHaveLength(50);
  });
});

describe('GCP-REPO-001: canonical repo label edge cases', () => {
  it('lowercases, folds slash to double dash, and strips invalid characters', () => {
    expect(canonicalRepoLabelValue('Acme/Payments.API')).toBe('acme--payments-api');
    expect(canonicalRepoLabelValue('org/repo_name')).toBe('org--repo_name');
  });
  it('rejects values longer than 63 characters instead of truncating', () => {
    const slug = 'org/' + 'a'.repeat(70);
    expect(canonicalRepoLabelValue(slug)).toBeUndefined();
  });
  it('rejects empty-after-trim slugs', () => {
    expect(canonicalRepoLabelValue('//')).toBeUndefined();
    expect(canonicalRepoLabelValue(undefined)).toBeUndefined();
  });
  it('case-fold collisions map distinct slugs to one canonical value (documented escape hatch: api-id)', () => {
    expect(canonicalRepoLabelValue('Org/Payments')).toBe(canonicalRepoLabelValue('org/payments'));
    expect(canonicalRepoLabelValue('org/pay.ments')).toBe(canonicalRepoLabelValue('org/pay-ments'));
  });
  it('multiple exact postman-repo matches narrow but never select', async () => {
    const result = await runNarrowingPipeline(context(), [
      candidate('projects/p/locations/global/apis/a/configs/c1', { tags: { 'postman-repo': 'org--payments' } }),
      candidate('projects/p/locations/global/apis/b/configs/c2', { tags: { 'postman-repo': 'org--payments' } })
    ]);
    expect(result?.mode).toBe('narrow');
    expect(result?.apiIds).toHaveLength(2);
  });
});
