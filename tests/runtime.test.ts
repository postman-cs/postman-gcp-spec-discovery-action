import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';
import type { SpecCandidate, SpecProvider } from '../src/lib/providers/types.js';
import { execute, resolveInputs, type GCPDependencies, type ReporterLike, type ResolvedInputs } from '../src/runtime.js';

const VALID_OPENAPI = `${JSON.stringify({ openapi: '3.0.3', info: { title: 'Payments', version: '1' }, paths: { '/payments': { get: { responses: { 200: { description: 'ok' } } } } } })}\n`;
const reporter: ReporterLike = { group: async (_name, fn) => fn(), info: () => undefined, warning: () => undefined };

function configId(name: string): string {
  return `projects/sample-project-123/locations/global/apis/${name}/configs/v1`;
}

function candidate(name: string, overrides: Partial<SpecCandidate> = {}): SpecCandidate {
  const id = configId(name);
  return {
    id,
    name,
    providerType: 'api-gateway',
    sourceType: 'api-gateway-config',
    authority: 'stored-authoritative',
    apiId: id,
    projectId: 'sample-project-123',
    tags: {},
    supported: true,
    evidence: [],
    meta: {},
    ...overrides
  };
}

function provider(candidates: SpecCandidate[], content = VALID_OPENAPI): SpecProvider {
  return {
    type: 'api-gateway',
    probe: vi.fn(async () => 'available' as const),
    listCandidates: vi.fn(async () => candidates),
    exportSpec: vi.fn(async () => ({ content, format: 'openapi-json' as const, filename: 'index.json' as const, evidence: ['stub export'] }))
  };
}

function client(): GcpDiscoveryClient {
  return new Proxy({}, { get: (_target, property) => property === 'preflightProject' ? vi.fn(async () => undefined) : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('GCP runtime execute', () => {
  let repoRoot: string;
  beforeEach(async () => { repoRoot = await mkdtemp(path.join(tmpdir(), 'gcp-runtime-')); });
  afterEach(async () => { await rm(repoRoot, { recursive: true, force: true }); });

  function inputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
    const env: NodeJS.ProcessEnv = { INPUT_PROJECT_ID: 'sample-project-123', INPUT_REPO_ROOT: repoRoot };
    if (overrides.mode) env.INPUT_MODE = overrides.mode;
    if (overrides.apiId) env.INPUT_API_ID = overrides.apiId;
    if (overrides.expectedServiceName) env.INPUT_EXPECTED_SERVICE_NAME = overrides.expectedServiceName;
    return { ...resolveInputs(env), ...overrides, repoRoot };
  }

  function dependencies(specProvider: SpecProvider): GCPDependencies {
    return {
      core: reporter,
      client: client(),
      writeSpecFile: async (outputPath, content) => {
        const fs = await import('node:fs/promises');
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, content, 'utf8');
      },
      providers: [specProvider]
    };
  }

  it('GCP-RESOLVE-001: a direct repo spec wins before preflight or providers', async () => {
    await writeFile(
      path.join(repoRoot, 'openapi.yaml'),
      'openapi: 3.0.3\ninfo:\n  title: x\n  version: "1"\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    );
    const specProvider = provider([candidate('payments')]);
    const deps = dependencies(specProvider);
    const result = await execute(inputs(), deps);
    expect(result.resolution?.sourceType).toBe('repo-spec');
    expect(result.resolution?.authority).toBe('stored-authoritative');
    expect(specProvider.listCandidates).not.toHaveBeenCalled();
    expect(deps.client.preflightProject).not.toHaveBeenCalled();
  });

  it('GCP-RESOLVE-001: an exact full api-id resolves at confidence 100 and writes the original spec', async () => {
    const id = configId('payments');
    const result = await execute(inputs({ apiId: id }), dependencies(provider([candidate('payments'), candidate('orders')])));
    expect(result.resolution).toMatchObject({ status: 'resolved', sourceType: 'api-gateway-config', confidence: 100, apiId: id });
    const output = path.join(repoRoot, 'discovered-specs', 'payments', 'index.json');
    await expect(stat(output)).resolves.toBeDefined();
    expect(await readFile(output, 'utf8')).toBe(VALID_OPENAPI);
  });

  it('GCP-RESOLVE-001: one exact canonical label selects; equal name matches remain ambiguous', async () => {
    const tagged = candidate('payments', { tags: { 'postman-repo': 'org--payments' } });
    const taggedInputs = inputs({ repoContext: { provider: 'github', repoSlug: 'org/payments' } });
    const selected = await execute(taggedInputs, dependencies(provider([tagged, candidate('orders')])));
    expect(selected.resolution).toMatchObject({ status: 'resolved', confidence: 100, narrowing: { tier: 'label-prefilter', mode: 'select' } });

    const ambiguous = await execute(inputs({ expectedServiceName: 'payments' }), dependencies(provider([candidate('payments-a'), candidate('payments-b')])));
    expect(ambiguous.resolution).toMatchObject({ status: 'unresolved', sourceType: 'manual-review' });
    expect(ambiguous.resolution?.rankedCandidates).toHaveLength(2);
    expect(JSON.parse(ambiguous.outputs['candidates-json']!)).toHaveLength(2);
  });

  it('GCP-RESOLVE-001: unsupported exact candidate remains manual review and writes nothing', async () => {
    const unsupported = candidate('grpc', {
      supported: false,
      authority: 'unsupported-format',
      evidence: ['gRPC config is not converted']
    });
    const specProvider = provider([unsupported]);
    const result = await execute(inputs({ apiId: unsupported.id }), dependencies(specProvider));
    expect(result.resolution).toMatchObject({
      status: 'unresolved',
      sourceType: 'manual-review',
      confidence: 100,
      authority: 'unsupported-format'
    });
    expect(specProvider.exportSpec).not.toHaveBeenCalled();
  });

  it('GCP-RESOLVE-001: local-derived cannot resolve via explicit api-id or discover-many', async () => {
    const local = candidate('agent', {
      providerType: 'agent-engines',
      sourceType: 'agent-engine-generated-spec',
      authority: 'local-derived',
      supported: false,
      evidence: ['local-derived assembly']
    });
    const resolveOne = await execute(inputs({ apiId: local.id }), dependencies(provider([local])));
    expect(resolveOne.resolution).toMatchObject({
      status: 'unresolved',
      sourceType: 'manual-review',
      authority: 'local-derived'
    });
    expect(resolveOne.resolution?.rankedCandidates?.[0]?.authority).toBe('local-derived');

    const many = await execute(inputs({ mode: 'discover-many' }), dependencies(provider([local])));
    expect(many.discovered).toHaveLength(0);
    expect(many.exportSummary).toMatchObject({ exported: 0, skipped: 1 });
  });

  it('GCP-RESOLVE-001: discover-many exports supported candidates and reports skipped unsupported candidates', async () => {
    const result = await execute(inputs({ mode: 'discover-many' }), dependencies(provider([
      candidate('payments', { tags: { 'postman-project-name': 'payments' } }),
      candidate('orders'),
      candidate('grpc', { supported: false, authority: 'unsupported-format' })
    ])));
    expect(result.discovered).toHaveLength(2);
    expect(result.discovered.every((service) => service.authority === 'stored-authoritative')).toBe(true);
    expect(result.exportSummary).toEqual({ attempted: 2, exported: 2, failed: 0, skipped: 1 });
    expect(result.outputs).toMatchObject({ 'source-type': 'discover-many', 'resolution-status': 'resolved', 'service-count': '2' });
    const services = JSON.parse(result.outputs['services-json']!);
    expect(services[0].authority).toBe('stored-authoritative');
  });

  it('GCP-NARROW-001: a canonical match at position 70 survives the 50-candidate cap', async () => {
    const candidates = Array.from({ length: 75 }, (_, index) => candidate(`api-${String(index).padStart(2, '0')}`));
    candidates[69] = candidate('target', { tags: { 'postman-repo': 'org--target' } });
    const result = await execute(
      inputs({ mode: 'discover-many', repoContext: { provider: 'github', repoSlug: 'org/target' } }),
      dependencies(provider(candidates))
    );
    expect(result.discovered).toHaveLength(50);
    expect(result.discovered.some((service) => service.apiId === configId('target'))).toBe(true);
    expect(result.exportSummary?.skipped).toBe(25);
  });

  it('GCP-RESOLVE-001: resolved export failure is fatal and discover-many path collisions count as failures', async () => {
    const tagged = candidate('payments', { tags: { 'postman-repo': 'org--payments' } });
    const failing = provider([tagged]);
    failing.exportSpec = vi.fn(async () => { throw new Error('source unavailable'); });
    await expect(execute(inputs({ repoContext: { provider: 'github', repoSlug: 'org/payments' } }), dependencies(failing))).rejects.toThrow('Export failed for resolved candidate');

    const colliding = provider([candidate('a', { tags: { 'postman-project-name': 'shared' } }), candidate('b', { tags: { 'postman-project-name': 'shared' } })]);
    const many = await execute(inputs({ mode: 'discover-many' }), dependencies(colliding));
    expect(many.exportSummary).toMatchObject({ exported: 1, failed: 1 });
    expect(many.outputs['resolution-status']).toBe('unresolved');
  });

  it('GCP-RESOLVE-001: explicit api-id overrides a committed repo spec (precedence: api-id wins)', async () => {
    // A repo that both carries a committed spec AND passes api-id must resolve
    // the caller-selected cloud resource, not the local file.
    await writeFile(
      path.join(repoRoot, 'openapi.yaml'),
      'openapi: 3.0.3\ninfo:\n  title: local\n  version: "1"\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    );
    const id = configId('payments');
    const result = await execute(inputs({ apiId: id }), dependencies(provider([candidate('payments'), candidate('orders')])));
    expect(result.resolution).toMatchObject({
      status: 'resolved',
      sourceType: 'api-gateway-config',
      confidence: 100,
      apiId: id,
      authority: 'stored-authoritative'
    });
    expect(result.resolution?.evidence?.[0]).toContain('Caller-selected API ID');
  });

  it('GCP-RESOLVE-001: two exact postman-repo labels stay unresolved and never break the tie', async () => {
    // Both candidates carry the SAME exact canonical label; heuristic names differ.
    // The action must refuse to guess despite one being name-rankable.
    const a = candidate('target', { tags: { 'postman-repo': 'org--target' } });
    const b = candidate('target-extra', { tags: { 'postman-repo': 'org--target' } });
    const result = await execute(inputs({ repoContext: { provider: 'github', repoSlug: 'org/target' } }), dependencies(provider([a, b])));
    expect(result.resolution).toMatchObject({ status: 'unresolved', sourceType: 'manual-review' });
    expect(result.resolution?.narrowing).toMatchObject({ tier: 'label-prefilter', mode: 'narrow' });
  });

  it('GCP-DISCOVER-001: discover-many narrowing-strategy reports the real tier, not a hardcoded none', async () => {
    const tagged = candidate('target', { tags: { 'postman-repo': 'org--target' } });
    const result = await execute(
      inputs({ mode: 'discover-many', repoContext: { provider: 'github', repoSlug: 'org/target' } }),
      dependencies(provider([tagged, candidate('orders')]))
    );
    expect(result.outputs['narrowing-strategy']).toBe('label-prefilter');
  });

  it('GCP-RESOLVE-001: a missed api-id still emits a ranked audit trail', async () => {
    const result = await execute(
      inputs({ apiId: configId('absent'), expectedServiceName: 'payments' }),
      dependencies(provider([candidate('payments'), candidate('orders')]))
    );
    expect(result.resolution).toMatchObject({ status: 'unresolved', sourceType: 'manual-review' });
    expect(result.resolution?.rankedCandidates?.length).toBe(2);
  });
});
