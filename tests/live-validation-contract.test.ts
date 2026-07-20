import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RETAINED_PROVIDER_ORDER as SOURCE_PROVIDER_ORDER } from '../src/contracts.js';
import {
  LIVE_COVERAGE_MATRIX,
  PROJECT_SCOPE_ALIAS,
  RETAINED_PROVIDER_ORDER,
  SUBSTITUTE_REASON_CODES,
  assertAcceptableLiveEvidence,
  assertFixtureResolutionMatch,
  assertManualDerivedBlocked,
  assertProviderMatrixAligned,
  buildEvidence,
  buildFixtureCliArgs,
  classifyProbeError,
  classifySubstituteReason,
  compareExactBytes,
  compareSemanticOpenApi,
  computeDistBinding,
  confinePathWithinRoot,
  deriveFixtureSelectionStrategy,
  extractCliProbeStatuses,
  isHistoricalEvidence,
  isResourceNotFoundError,
  matrixSlotsMissingCoverage,
  normalizeFixtureResourceId,
  parseFlags,
  parseLiveFixtures,
  probeUrlForProvider,
  requiredEnv,
  resolveFixtureSelectionStrategy,
  sha256Hex,
  teardown,
  toEvidenceResult,
  verifyRemoteApigeeOwnership,
  verifyRemoteEndpointsOwnership,
  verifyRemoteGatewayOwnership
} from '../validation/scripts/validate-live-gcp-surfaces.mjs';

const root = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('GCP live validation contract', () => {
  it('requires project and both destructive lifecycle flags', () => {
    expect(() => requiredEnv({})).toThrow(/GCP_PROJECT_ID is required/);
    expect(requiredEnv({ GCP_PROJECT_ID: 'sample-project' })).toEqual({
      projectId: 'sample-project',
      location: 'global',
      apigeeOrg: 'sample-project',
      apigeeEnv: 'test-env'
    });
    expect(parseFlags([])).toEqual({ provision: false, teardown: false });
    expect(parseFlags(['--provision', '--teardown'])).toEqual({ provision: true, teardown: true });
  });

  it('keeps live matrix aligned with runtime retained provider order', () => {
    expect([...RETAINED_PROVIDER_ORDER]).toEqual([...SOURCE_PROVIDER_ORDER]);
    expect(() => assertProviderMatrixAligned()).not.toThrow();
    const covered = new Set(LIVE_COVERAGE_MATRIX.map((slot) => slot.providerType));
    for (const provider of SOURCE_PROVIDER_ORDER) {
      expect(covered.has(provider)).toBe(true);
    }
    expect(LIVE_COVERAGE_MATRIX.some((slot) => slot.name === 'apigee-proxy')).toBe(true);
    expect(LIVE_COVERAGE_MATRIX.some((slot) => slot.name === 'apigee-archive')).toBe(true);
    expect(LIVE_COVERAGE_MATRIX.some((slot) => slot.name === 'api-hub-original')).toBe(true);
    expect(LIVE_COVERAGE_MATRIX.some((slot) => slot.name === 'api-hub-additional')).toBe(true);
    expect(LIVE_COVERAGE_MATRIX.find((slot) => slot.name === 'agent-engines')?.validationMode).toBe('manual-derived-blocked');
    expect(() => assertProviderMatrixAligned(
      LIVE_COVERAGE_MATRIX.filter((slot) => slot.providerType !== 'api-hub'),
      SOURCE_PROVIDER_ORDER as unknown as string[]
    )).toThrow(/drifted/);
  });

  it('rejects invalid fixture schema entries', () => {
    const projectId = 'sample-project';
    const okHash = 'a'.repeat(64);
    expect(parseLiveFixtures('', { projectId })).toEqual([]);
    expect(() => parseLiveFixtures('{', { projectId })).toThrow(/fixture-schema-invalid/);
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'nope', resourceId: 'x', expectedSourceType: 'y', validationMode: 'exact-bytes' }]), { projectId })).toThrow(/unknown provider/);
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'api-hub', resourceId: 'projects/other/locations/global/apis/a/versions/v/specs/s', expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes' }]), { projectId })).toThrow(/foreign project/);
    const scopedResource = `projects/${projectId}/locations/global/apis/a/versions/v/specs/s`;
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', expectedSha256: 'deadbeef' }]), { projectId })).toThrow(/malformed expectedSha256/);
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', extra: 1 }]), { projectId })).toThrow(/unexpected fields/);
    expect(() => parseLiveFixtures(JSON.stringify([
      { provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', expectedSha256: okHash, matrixName: 'api-hub-original' },
      { provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', expectedSha256: okHash, matrixName: 'api-hub-original' }
    ]), { projectId })).toThrow(/duplicate/);
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', matrixName: 'api-hub-original' }]), { projectId })).toThrow(/requires expectedSha256/);
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', expectedSha256: okHash }]), { projectId })).toThrow(/matrixName is required/);
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', expectedSha256: okHash, matrixName: 'apigee-proxy' }]), { projectId })).toThrow(/does not match/);
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', expectedFixturePath: '../outside.yaml' }]), { projectId, repoRoot: root })).toThrow(/must stay within repo root/);
    const fixtureRoot = tempDir('gcp-live-fixture-');
    writeFileSync(join(fixtureRoot, 'inside.yaml'), 'openapi: 3.0.0');
    symlinkSync(join(fixtureRoot, 'inside.yaml'), join(fixtureRoot, 'linked.yaml'));
    expect(() => parseLiveFixtures(JSON.stringify([{ provider: 'api-hub', resourceId: scopedResource, expectedSourceType: 'api-hub-spec', validationMode: 'exact-bytes', expectedFixturePath: 'linked.yaml', matrixName: 'api-hub-original' }]), { projectId, repoRoot: fixtureRoot })).toThrow(/must not be a symlink/);
    const fixtures = parseLiveFixtures(JSON.stringify({
      fixtures: [{
        provider: 'api-hub',
        resourceId: `projects/${projectId}/locations/global/apis/a/versions/v/specs/s`,
        expectedSourceType: 'api-hub-spec',
        validationMode: 'exact-bytes',
        expectedSha256: okHash,
        matrixName: 'api-hub-original'
      }]
    }), { projectId, repoRoot: root });
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.expectedSha256).toBe(okHash);
    expect(fixtures[0]?.selectionStrategy).toBe('strict-api-id');
  });

  it('derives provider/source-specific fixture CLI args and rejects unsafe strategies', () => {
    const env = { projectId: 'sample-project', location: 'global', apigeeOrg: 'sample-project', apigeeEnv: 'test-env' };
    expect(deriveFixtureSelectionStrategy({ provider: 'api-hub', expectedSourceType: 'api-hub-spec' })).toBe('strict-api-id');
    expect(deriveFixtureSelectionStrategy({ provider: 'app-integration', expectedSourceType: 'app-integration-trigger' })).toBe('expected-api-ids');
    expect(deriveFixtureSelectionStrategy({ provider: 'api-hub', expectedSourceType: 'api-hub-boosted-spec' })).toBe('api-hub-additional');

    expect(() => resolveFixtureSelectionStrategy({
      provider: 'app-integration',
      expectedSourceType: 'app-integration-trigger',
      selectionStrategy: 'strict-api-id',
      matrixName: 'app-integration'
    })).toThrow(/cannot force strict-api-id|without an explicit parser/);

    expect(() => resolveFixtureSelectionStrategy({
      provider: 'api-hub',
      expectedSourceType: 'api-hub-boosted-spec',
      selectionStrategy: 'expected-api-ids',
      matrixName: 'api-hub-additional'
    })).toThrow(/additional|api-hub-additional/);

    const hubSpec = `projects/${env.projectId}/locations/global/apis/a/versions/v/specs/s`;
    const additional = parseLiveFixtures(JSON.stringify([{
      provider: 'api-hub',
      resourceId: hubSpec,
      expectedSourceType: 'api-hub-boosted-spec',
      validationMode: 'exact-bytes',
      expectedSha256: 'a'.repeat(64),
      matrixName: 'api-hub-additional'
    }]), { projectId: env.projectId });
    expect(additional[0]?.selectionStrategy).toBe('api-hub-additional');
    expect(additional[0]?.resourceId).toBe(`${hubSpec}#BOOSTED_SPEC_CONTENT`);
    expect(normalizeFixtureResourceId({
      resourceId: hubSpec,
      expectedSourceType: 'api-hub-gateway-openapi-spec',
      selectionStrategy: 'api-hub-additional'
    })).toBe(`${hubSpec}#GATEWAY_OPEN_API_SPEC`);

    const strictArgs = buildFixtureCliArgs({
      provider: 'api-hub',
      resourceId: hubSpec,
      expectedSourceType: 'api-hub-spec',
      validationMode: 'exact-bytes',
      matrixName: 'api-hub-original',
      selectionStrategy: 'strict-api-id'
    }, env);
    expect(strictArgs.args).toEqual(['--api-id', hubSpec]);

    const expectedArgs = buildFixtureCliArgs({
      provider: 'app-integration',
      resourceId: `projects/${env.projectId}/locations/us-central1/integrations/pay`,
      expectedSourceType: 'app-integration-trigger',
      validationMode: 'semantic-openapi',
      matrixName: 'app-integration',
      selectionStrategy: 'expected-api-ids',
      serviceHint: 'pay'
    }, env);
    expect(expectedArgs.args).toEqual([
      '--expected-api-ids-json', JSON.stringify([`projects/${env.projectId}/locations/us-central1/integrations/pay`]),
      '--expected-service-name', 'pay'
    ]);
    expect(expectedArgs.args).not.toContain('--api-id');

    const variantArgs = buildFixtureCliArgs(additional[0]!, env);
    expect(variantArgs.args).toEqual(['--api-id', `${hubSpec}#BOOSTED_SPEC_CONTENT`]);
    expect(() => assertFixtureResolutionMatch(
      { sourceType: 'api-hub-spec', authority: 'stored-authoritative' },
      additional[0]!,
      LIVE_COVERAGE_MATRIX.find((slot) => slot.name === 'api-hub-additional')
    )).toThrow(/unexpected-source-type/);
    expect(assertFixtureResolutionMatch(
      { sourceType: 'api-hub-boosted-spec', authority: 'google-generated' },
      additional[0]!,
      LIVE_COVERAGE_MATRIX.find((slot) => slot.name === 'api-hub-additional')
    )).toBe(true);
  });

  it('confines fixture paths beneath the repo root', () => {
    expect(() => confinePathWithinRoot(root, 'validation/fixtures/gcp/openapi.yaml')).not.toThrow();
    expect(() => confinePathWithinRoot(root, '../../etc/passwd')).toThrow(/must stay within repo root/);
    const absEscape = join(root, '..', 'escape.yaml');
    expect(() => confinePathWithinRoot(root, absEscape)).toThrow(/must stay within repo root/);
  });

  it('applies substitute rules and fails available-without-fixture as missing-fixture', () => {
    expect(classifySubstituteReason({ providerType: 'api-hub', probeStatus: 'available' })).toBeNull();
    expect(classifySubstituteReason({ providerType: 'api-hub', probeStatus: 'skipped:iam' })).toBe('iam-denied');
    expect(classifySubstituteReason({
      providerType: 'app-integration',
      probeStatus: 'skipped:error',
      probeMessage: 'SERVICE_DISABLED: integrations.googleapis.com'
    })).toBe('api-unavailable');
    expect(classifySubstituteReason({
      providerType: 'vertex-extensions',
      probeStatus: 'skipped:error',
      probeMessage: 'Extensions are deprecated and shutdown for new resources'
    })).toBe('product-deprecated');
    expect(classifySubstituteReason({
      providerType: 'apigee-registry',
      probeStatus: 'skipped:error',
      probeMessage: 'Apigee Registry is no longer supported'
    })).toBe('registry-unsupported');
    expect(classifySubstituteReason({
      providerType: 'api-hub',
      probeStatus: 'skipped:error',
      probeMessage: 'temporary 503'
    })).toBeNull();
    for (const code of SUBSTITUTE_REASON_CODES) {
      expect(['iam-denied', 'api-unavailable', 'product-deprecated', 'registry-unsupported']).toContain(code);
    }
    const missing = matrixSlotsMissingCoverage([
      toEvidenceResult('gateway-explicit-api-id', 'pass', { providerType: 'api-gateway', validationMode: 'exact-bytes' }),
      toEvidenceResult('api-hub-original', 'fail', { providerType: 'api-hub', validationMode: 'exact-bytes', reasonCode: 'missing-fixture' })
    ]);
    expect(missing).toContain('api-hub-original');
    expect(missing).toContain('apigee-archive');
  });

  it('sanitizes evidence and requires schema-v2 digest fields', () => {
    const result = toEvidenceResult('gateway-explicit-api-id', 'pass', {
      sourceType: 'api-gateway-config',
      providerType: 'api-gateway',
      specFormat: 'openapi-yaml',
      validationMode: 'exact-bytes',
      apiId: 'secret',
      url: 'https://example.invalid',
      reasonCode: undefined
    } as never);
    expect(result).toEqual({
      name: 'gateway-explicit-api-id',
      providerType: 'api-gateway',
      sourceType: 'api-gateway-config',
      specFormat: 'openapi-yaml',
      status: 'pass',
      validationMode: 'exact-bytes'
    });
    expect(result).not.toHaveProperty('apiId');
    expect(result).not.toHaveProperty('url');

    const evidence = buildEvidence({
      results: [result, toEvidenceResult('api-hub-original', 'substitute', {
        providerType: 'api-hub',
        validationMode: 'exact-bytes',
        reasonCode: 'iam-denied'
      })],
      binding: {
        actionVersion: '1.0.0',
        gitCommit: 'abc123',
        distCliSha256: 'c'.repeat(64),
        distIndexSha256: 'd'.repeat(64)
      },
      teardown: { status: 'pass' },
      capturedAt: '2026-07-19T12:00:00.000Z'
    });
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.capturedAt).toBe('2026-07-19T12:00:00.000Z');
    expect(evidence.projectScope).toBe(PROJECT_SCOPE_ALIAS);
    expect(evidence.distCliSha256).toHaveLength(64);
    expect(evidence.distIndexSha256).toHaveLength(64);
    expect(evidence.totals).toEqual({ cases: 2, passed: 1, failed: 0, substituted: 1 });
    expect(evidence.teardown).toEqual({ status: 'pass' });
    expect(JSON.stringify(evidence)).not.toMatch(/https?:\/\/|Bearer |secret|projects\//i);
  });

  it('binds digests from compiled dist bytes and refuses missing dist', () => {
    const binding = computeDistBinding({
      root,
      runner: (command, args) => {
        if (command === 'git' && args[0] === 'rev-parse') return 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n';
        if (command === 'git' && args[0] === 'status') return '';
        throw new Error(`unexpected ${command}`);
      }
    });
    expect(binding.distCliSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.distIndexSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.distCliSha256).toBe(sha256Hex(readFileSync(join(root, 'dist/cli.cjs'))));
    expect(binding.gitCommit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(binding.actionVersion).toMatch(/^\d+\.\d+\.\d+/);

    const empty = tempDir('gcp-live-nodist-');
    expect(() => computeDistBinding({ root: empty, runner: () => '' })).toThrow(/dist-missing/);

    const dirtyRoot = tempDir('gcp-live-dirty-');
    mkdirSync(join(dirtyRoot, 'dist'), { recursive: true });
    writeFileSync(join(dirtyRoot, 'dist/cli.cjs'), 'cli');
    writeFileSync(join(dirtyRoot, 'dist/index.cjs'), 'index');
    writeFileSync(join(dirtyRoot, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    expect(() => computeDistBinding({
      root: dirtyRoot,
      runner: (command, args) => {
        if (command === 'git' && args[0] === 'rev-parse') return 'abc\n';
        if (command === 'git' && args[0] === 'status') return ' M dist/cli.cjs\n';
        return '';
      }
    })).toThrow(/clean committed candidate/);
    try {
      computeDistBinding({
        root: dirtyRoot,
        runner: (command, args) => {
          if (command === 'git' && args[0] === 'rev-parse') return 'abc\n';
          if (command === 'git' && args[0] === 'status') return ' M dist/cli.cjs\n';
          return '';
        }
      });
      expect.unreachable('expected dist-dirty');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/dist-dirty/);
      expect(message).toMatch(/clean committed candidate/);
      expect(message).not.toMatch(/dist\/cli|sample-project|projects\//);
    }
  });

  it('compares exact-byte and semantic OpenAPI outputs without weakening validation', () => {
    const body = 'openapi: 3.0.0\ninfo:\n  title: t\n  version: "1.0.0"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
    const hash = createHash('sha256').update(body).digest('hex');
    expect(compareExactBytes(body, hash)).toBe(true);
    expect(() => compareExactBytes(body, '0'.repeat(64))).toThrow(/exact-bytes-mismatch/);

    const reordered = 'openapi: 3.0.0\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\ninfo:\n  version: "1.0.0"\n  title: t\n';
    expect(compareSemanticOpenApi(body, reordered)).toBe(true);
    const different = body.replace('/health', '/ready');
    expect(() => compareSemanticOpenApi(body, different)).toThrow(/semantic-mismatch/);
    expect(() => compareSemanticOpenApi(body, 'not-openapi')).toThrow();
  });

  it('proves manual-derived-blocked authority and rejects auto-resolve', () => {
    expect(assertManualDerivedBlocked({
      resolution: { status: 'unresolved', sourceType: 'agent-engine-generated-spec', authority: 'local-derived', providerType: 'agent-engines' }
    })).toBe(true);
    expect(assertManualDerivedBlocked({
      resolution: {
        status: 'unresolved',
        sourceType: 'manual-review',
        authority: 'local-derived',
        rankedCandidates: [{ providerType: 'agent-engines', authority: 'local-derived', supported: false }]
      }
    })).toBe(true);
    expect(() => assertManualDerivedBlocked({
      resolution: { status: 'unresolved', authority: 'local-derived', sourceType: 'manual-review' }
    })).toThrow(/manual-derived-not-blocked/);
    expect(() => assertManualDerivedBlocked({
      resolution: { status: 'resolved', authority: 'stored-authoritative', sourceType: 'api-gateway-config' }
    })).toThrow(/manual-derived-not-blocked/);
  });

  it('probes Apigee archive substitutes on archiveDeployments, not the proxy API', () => {
    const env = { projectId: 'sample-project', location: 'global', apigeeOrg: 'sample-org', apigeeEnv: 'eval' };
    expect(probeUrlForProvider('apigee', env)).toContain('/apis?count=1');
    expect(probeUrlForProvider('apigee', env)).not.toContain('archiveDeployments');
    const archive = probeUrlForProvider('apigee', env, { probeSurface: 'apigee-archive' });
    expect(archive).toContain('/environments/');
    expect(archive).toContain('/archiveDeployments');
    expect(archive).not.toMatch(/\/apis(\?|$)/);
  });

  it('extracts valid CLI provider probes from both resolve and discover result shapes without inventing absent providers', () => {
    const resolve = extractCliProbeStatuses({
      resolution: { providerProbes: [{ provider: 'api-hub', status: 'skipped:iam' }] }
    });
    expect(resolve.get('api-hub')).toBe('skipped:iam');
    expect(resolve.has('apigee')).toBe(false);
    const discover = extractCliProbeStatuses({
      outputs: { 'resolution-json': JSON.stringify({ providerProbes: [{ provider: 'apigee', status: 'available' }] }) }
    });
    expect(discover.get('apigee')).toBe('available');
    expect(extractCliProbeStatuses({ providerProbes: [{ provider: 'not-a-provider', status: 'available' }] }).size).toBe(0);
  });

  it('continues Endpoints and Apigee teardown when Gateway is absent and records sanitized teardown', async () => {
    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'gcloud' && args[0] === 'auth') return 'token';
      if (args.includes('describe') && args.includes('api-gateway')) throw new Error('404 NOT_FOUND');
      if (args.includes('describe') && args.includes('endpoints')) throw new Error('404 NOT_FOUND');
      if (args.includes('services') && args.includes('delete')) return '';
      if (command === 'curl' && args.includes('GET')) throw new Error('404 not found');
      if (command === 'curl' && args.includes('DELETE')) return '';
      return '';
    };
    const manifest = {
      runId: '1234',
      runMarker: 'postman-1234',
      gatewayName: 'postman-live-1234',
      gatewayConfigName: 'postman-live-config-1234',
      endpointsService: 'postman-live-1234.endpoints.p.cloud.goog',
      proxyName: 'postman-live-1234'
    };
    const result = await teardown({
      runner,
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest,
      log: () => {}
    });
    expect(result).toEqual({ status: 'pass' });
    expect(calls.some((call) => call.includes('endpoints services delete'))).toBe(true);
    expect(verifyRemoteGatewayOwnership(manifest, { labels: { 'postman-run-marker': manifest.runMarker } })).toBe(true);
    expect(() => verifyRemoteGatewayOwnership(manifest, { labels: { 'postman-run-marker': 'foreign' } })).toThrow('REFUSING');
    expect(verifyRemoteEndpointsOwnership(manifest, manifest.endpointsService)).toBe(true);
    expect(() => verifyRemoteEndpointsOwnership(manifest, 'foreign')).toThrow('REFUSING');
    expect(verifyRemoteApigeeOwnership(manifest, { name: manifest.proxyName })).toBe(true);
    expect(() => verifyRemoteApigeeOwnership(manifest, { name: 'foreign' })).toThrow('REFUSING');
  });

  it('classifies GCP probe and absence errors', () => {
    expect(classifyProbeError('403 permission denied')).toBe('fatal');
    expect(classifyProbeError('400 invalid argument')).toBe('fatal');
    expect(classifyProbeError('404 not found')).toBe('retryable');
    expect(classifyProbeError('503 unavailable')).toBe('retryable');
    expect(isResourceNotFoundError(new Error('404 not found'))).toBe(true);
    expect(isResourceNotFoundError('resource does not exist')).toBe(true);
    expect(isResourceNotFoundError('permission denied')).toBe(false);
  });

  it('accepts historical migration or current complete schema-v2 receipts and rejects hybrids', () => {
    const raw = readFileSync(join(root, 'validation/evidence/live-gcp-surfaces.json'), 'utf8');
    const evidence = JSON.parse(raw);
    expect(evidence.schemaVersion).toBe(2);
    expect(isHistoricalEvidence(evidence)).toBe(true);
    expect(evidence.evidenceKind).toBe('historical');
    expect(evidence.actionVersion).toBe('legacy-unbound');
    expect(evidence.distCliSha256).toBe('legacy-unbound');
    expect(evidence.distIndexSha256).toBe('legacy-unbound');
    expect(evidence.gitCommit).toBe('legacy-unbound');
    expect(evidence.projectScope).toBe(PROJECT_SCOPE_ALIAS);
    expect(assertAcceptableLiveEvidence(evidence)).toEqual({ kind: 'historical' });
    expect(evidence.results).toHaveLength(10);
    expect(evidence.totals.passed + evidence.totals.failed + evidence.totals.substituted).toBe(evidence.totals.cases);
    expect(evidence.results.map((result: { name: string }) => result.name)).toEqual([
      'gateway-explicit-api-id',
      'gateway-discovery',
      'gateway-repo-label',
      'gateway-label-conflict',
      'endpoints-explicit-api-id',
      'endpoints-discovery',
      'apigee-discovery',
      'discover-many',
      'iac-single',
      'ambiguity'
    ]);
    expect(matrixSlotsMissingCoverage(evidence.results).length).toBeGreaterThan(0);
    expect(raw).not.toMatch(/https?:\/\/|Bearer |projectNumber|specBody|ya29\./i);

    const completeResults = LIVE_COVERAGE_MATRIX.map((slot) => toEvidenceResult(slot.name, 'pass', {
      providerType: slot.providerType,
      sourceType: slot.expectedSourceTypes[0],
      validationMode: slot.validationMode
    }));
    const current = buildEvidence({
      results: completeResults,
      binding: {
        actionVersion: '1.2.3',
        gitCommit: 'a'.repeat(40),
        distCliSha256: 'b'.repeat(64),
        distIndexSha256: 'c'.repeat(64)
      },
      teardown: { status: 'pass' },
      evidenceKind: 'current'
    });
    expect(assertAcceptableLiveEvidence(current)).toEqual({ kind: 'current' });

    expect(() => assertAcceptableLiveEvidence({
      ...current,
      evidenceKind: 'historical'
    })).toThrow(/hybrid|historical/);
    expect(() => assertAcceptableLiveEvidence({
      ...evidence,
      results: completeResults,
      totals: { cases: completeResults.length, passed: completeResults.length, failed: 0, substituted: 0 }
    })).toThrow(/unbound complete/);
    const withMissingFixture = completeResults.map((result) => (
      result.name === 'agent-engines'
        ? toEvidenceResult('agent-engines', 'fail', {
          providerType: 'agent-engines',
          validationMode: 'manual-derived-blocked',
          reasonCode: 'missing-fixture'
        })
        : result
    ));
    expect(() => assertAcceptableLiveEvidence({
      ...current,
      results: withMissingFixture,
      totals: { cases: withMissingFixture.length, passed: withMissingFixture.length - 1, failed: 1, substituted: 0 }
    })).toThrow(/failed or pending|failures|missing-fixture/);
    expect(() => assertAcceptableLiveEvidence({
      ...current,
      teardown: { status: 'pending' }
    })).toThrow(/teardown/);
    expect(() => assertAcceptableLiveEvidence({
      ...current,
      results: [...completeResults, toEvidenceResult('extra', 'pending', {})],
      totals: { cases: completeResults.length + 1, passed: completeResults.length, failed: 0, substituted: 0 }
    })).toThrow(/pending result state/);
    expect(() => assertAcceptableLiveEvidence({
      ...current,
      totals: { cases: completeResults.length, passed: completeResults.length - 1, failed: 0, substituted: 0 }
    })).toThrow(/totals/);
    expect(() => assertAcceptableLiveEvidence({
      ...evidence,
      results: [...evidence.results, toEvidenceResult('extra', 'fail', {})],
      totals: { cases: evidence.results.length + 1, passed: evidence.results.length, failed: 1, substituted: 0 }
    })).toThrow(/historical receipt must contain only completed passing cases/);
    const withBadSubstitute = completeResults.map((result) => (
      result.name === 'agent-engines'
        ? toEvidenceResult('agent-engines', 'substitute', {
          providerType: 'agent-engines',
          validationMode: 'manual-derived-blocked',
          reasonCode: 'temporary-blip'
        })
        : result
    ));
    expect(() => assertAcceptableLiveEvidence({
      ...current,
      results: withBadSubstitute,
      totals: { cases: withBadSubstitute.length, passed: withBadSubstitute.length - 1, failed: 0, substituted: 1 }
    })).toThrow(/unjustified substitute/);

    const readme = readFileSync(join(root, 'validation/evidence/README.md'), 'utf8');
    expect(readme).toContain('schema-v2');
    expect(readme).toContain('legacy-unbound');
    expect(readme).toContain('missing-fixture');
    expect(readme).toContain('GCP_LIVE_FIXTURES_JSON');
    expect(readme).toContain('selectionStrategy');
    const runbook = readFileSync(join(root, 'docs/LIVE_TESTING_RUNBOOK.md'), 'utf8');
    expect(runbook).toContain('schema-v2');
    expect(runbook).toContain('missing-fixture');
    expect(runbook).toContain('distCliSha256');
    expect(runbook).toContain('clean committed candidate');
    expect(runbook).toContain('selectionStrategy');
    expect(runbook).toContain('archiveDeployments');
    expect(runbook).toContain('manual-derived-blocked');
  });

  it('records failure receipts with reason codes without leaking fixture env contents', () => {
    const failed = toEvidenceResult('api-hub-original', 'fail', {
      providerType: 'api-hub',
      validationMode: 'exact-bytes',
      reasonCode: 'missing-fixture'
    });
    const evidence = buildEvidence({
      results: [failed],
      binding: {
        actionVersion: '1.0.0',
        gitCommit: 'g'.repeat(40),
        distCliSha256: 'a'.repeat(64),
        distIndexSha256: 'b'.repeat(64)
      },
      teardown: { status: 'pass' }
    });
    expect(evidence.totals.failed).toBe(1);
    expect(evidence.results[0]?.reasonCode).toBe('missing-fixture');
    expect(JSON.stringify(evidence)).not.toContain('GCP_LIVE_FIXTURES_JSON');
    expect(JSON.stringify(evidence)).not.toContain('resourceId');
  });
});
