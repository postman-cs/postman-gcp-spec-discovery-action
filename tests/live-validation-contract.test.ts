import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RETAINED_PROVIDER_ORDER as SOURCE_PROVIDER_ORDER } from '../src/contracts.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_PHASE_TIMEOUT_MS,
  LIVE_COVERAGE_MATRIX,
  LIVE_PHASES,
  LIVE_REQUIRED_SERVICES,
  LIVE_STATE_SCHEMA_VERSION,
  MAX_COMMAND_TIMEOUT_MS,
  MIN_COMMAND_TIMEOUT_MS,
  PHASE_DURATION_GUIDANCE_MS,
  PROJECT_SCOPE_ALIAS,
  RETAINED_PROVIDER_ORDER,
  SUBSTITUTE_REASON_CODES,
  assembleFromPhaseReceipts,
  assertAcceptableLiveEvidence,
  assertFixtureResolutionMatch,
  assertLiveStateSchema,
  assertManualDerivedBlocked,
  assertProviderMatrixAligned,
  assertValidateSlotsAllowed,
  buildEvidence,
  buildFixtureCliArgs,
  classifyPhaseFailure,
  classifyProbeError,
  classifySubstituteReason,
  compareExactBytes,
  compareSemanticOpenApi,
  computeDistBinding,
  confinePathWithinRoot,
  createEmptyLiveState,
  createEmptyResourceStates,
  createPhaseDeadline,
  createTimedRunner,
  deriveFixtureSelectionStrategy,
  extractCliProbeStatuses,
  isHistoricalEvidence,
  isResourceNotFoundError,
  loadLiveState,
  markResourceAttempted,
  markResourceCreated,
  matrixSlotsMissingCoverage,
  mergeCompletedSlots,
  normalizeFixtureResourceId,
  parseFlags,
  parseLiveFixtures,
  parseSlots,
  probeUrlForProvider,
  proveExactNameAbsent,
  provision,
  requiredEnv,
  resolveCommandTimeoutMs,
  resolveFixtureSelectionStrategy,
  resolveReceiptPath,
  resolveStatePath,
  runLiveValidation,
  runMatrixCoverage,
  runPhaseAssemble,
  runPhasePreflight,
  runPhaseProvision,
  runPhaseTeardown,
  runPhaseValidate,
  saveLiveState,
  sha256Hex,
  teardown,
  toEvidenceResult,
  verifyRemoteApigeeOwnership,
  verifyRemoteEndpointsOwnership,
  verifyRemoteGatewayOwnership,
  writeAtomicJson,
  writePhaseReceipt
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
  it('enables every API required by the compiled CLI preflight and core fixtures', () => {
    expect(LIVE_REQUIRED_SERVICES).toEqual([
      'cloudresourcemanager.googleapis.com',
      'apigateway.googleapis.com',
      'servicemanagement.googleapis.com',
      'servicecontrol.googleapis.com'
    ]);
  });

  it('records provision-satisfied matrix slots without probing unrelated providers', async () => {
    const slot = LIVE_COVERAGE_MATRIX.find((item) => item.name === 'api-gateway')!;
    const results = await runMatrixCoverage({
      runner: () => {
        throw new Error('satisfied matrix slot must not run a command');
      },
      token: 'token',
      cliPath: 'dist/cli.cjs',
      env: { projectId: 'sample-project', location: 'global', apigeeOrg: 'sample-project', apigeeEnv: 'test-env' },
      fixtures: [],
      provisionedResults: [toEvidenceResult('gateway-explicit-api-id', 'pass', {
        providerType: 'api-gateway',
        sourceType: 'api-gateway-config',
        specFormat: 'openapi-yaml',
        validationMode: 'exact-bytes'
      })],
      slots: [slot],
      log: () => undefined
    });
    expect(results).toEqual([
      expect.objectContaining({
        name: 'api-gateway',
        status: 'pass',
        providerType: 'api-gateway',
        sourceType: 'api-gateway-config',
        specFormat: 'openapi-yaml'
      })
    ]);
  });
  it('requires project and both destructive lifecycle flags', () => {
    expect(() => requiredEnv({})).toThrow(/GCP_PROJECT_ID is required/);
    expect(requiredEnv({ GCP_PROJECT_ID: 'sample-project' })).toEqual({
      projectId: 'sample-project',
      location: 'global',
      apigeeOrg: 'sample-project',
      apigeeEnv: 'test-env'
    });
    expect(parseFlags([])).toMatchObject({
      phase: 'all',
      provision: false,
      teardown: false,
      slots: null,
      commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      phaseTimeoutMs: DEFAULT_PHASE_TIMEOUT_MS
    });
    expect(parseFlags(['--provision', '--teardown'])).toMatchObject({
      phase: 'all',
      provision: true,
      teardown: true
    });
  });

  it('parses phase-addressable CLI flags and rejects invalid phases/slots/timeouts', () => {
    expect(LIVE_PHASES).toEqual(['preflight', 'provision', 'validate', 'teardown', 'assemble', 'all']);
    expect(parseFlags(['--phase', 'validate', '--slots', 'api-gateway,iac-local'])).toMatchObject({
      phase: 'validate',
      slots: ['api-gateway', 'iac-local']
    });
    expect(parseSlots('gateway-explicit-api-id,api-hub-original')).toEqual([
      'gateway-explicit-api-id',
      'api-hub-original'
    ]);
    expect(() => parseFlags(['--phase', 'nope'])).toThrow(/--phase must be one of/);
    expect(() => parseFlags(['--slots', 'not-a-slot'])).toThrow(/slot-not-allowed/);
    expect(() => parseFlags(['--command-timeout-ms', '1'])).toThrow(/--command-timeout-ms/);
    expect(() => parseFlags(['--command-timeout-ms', String(MAX_COMMAND_TIMEOUT_MS + 1)])).toThrow(/--command-timeout-ms/);
    expect(() => parseFlags(['--phase-timeout-ms', String(MIN_COMMAND_TIMEOUT_MS)])).toThrow(/--phase-timeout-ms/);
    expect(() => parseFlags([
      '--command-timeout-ms', String(DEFAULT_COMMAND_TIMEOUT_MS),
      '--phase-timeout-ms', String(DEFAULT_COMMAND_TIMEOUT_MS - 1)
    ])).toThrow(/phase-timeout-ms must be >=/);
    expect(parseFlags([
      '--phase', 'assemble',
      '--phase-receipt', 'a.json',
      '--phase-receipt', 'b.json',
      '--state-path', 'validation/.live-runs/state.json',
      '--receipt-path', 'validation/.live-runs/out.json'
    ])).toMatchObject({
      phase: 'assemble',
      phaseReceipts: ['a.json', 'b.json'],
      statePath: 'validation/.live-runs/state.json',
      receiptPath: 'validation/.live-runs/out.json'
    });
    expect(PHASE_DURATION_GUIDANCE_MS.preflight).toBeLessThan(PHASE_DURATION_GUIDANCE_MS.provision);
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

  function baseManifest(overrides: Record<string, unknown> = {}) {
    return {
      runId: '1234',
      runMarker: 'postman-live-1234',
      gatewayName: 'postman-live-1234',
      gatewayConfigName: 'postman-live-config-1234',
      endpointsService: 'postman-live-1234.endpoints.p.cloud.goog',
      proxyName: 'postman-live-1234',
      repoLabel: 'postman-live--1234',
      conflictLabel: 'postman-conflict--1234',
      resources: createEmptyResourceStates(),
      ...overrides
    };
  }

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
    const manifest = baseManifest({
      resources: {
        gateway: { attempted: true, created: true },
        endpoints: { attempted: true, created: true },
        apigee: { attempted: true, created: true }
      }
    });
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

  it('tracks attempted/created state through each provisioning stage and fails without marking later surfaces', async () => {
    const stages: string[] = [];
    const manifest = baseManifest();
    const runner = (command: string, args: string[]) => {
      const joined = `${command} ${args.join(' ')}`;
      stages.push(joined);
      if (command === 'gcloud' && args[0] === 'services' && args[1] === 'enable') return '';
      if (args.includes('apis') && args.includes('create') && args.includes(manifest.gatewayName) && !args.includes('api-configs')) {
        return '';
      }
      if (args.includes('api-configs') && args.includes('create')) return '';
      if (args.includes('services') && args.includes('deploy')) {
        throw new Error('403 permission denied on endpoints deploy');
      }
      if (command === 'zip') return '';
      return '';
    };
    await expect(provision({
      runner,
      token: 'token',
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest
    })).rejects.toThrow(/permission denied/);
    expect(manifest.resources?.gateway).toEqual({ attempted: true, created: true });
    expect(manifest.resources?.endpoints).toEqual({ attempted: true, created: false });
    expect(manifest.resources?.apigee).toEqual({ attempted: false, created: false });
    expect(stages.some((call) => call.includes('endpoints services deploy'))).toBe(true);
    expect(stages.some((call) => call.includes('apigee.googleapis.com'))).toBe(false);
  });

  it('marks gateway attempted but not created when Gateway create fails before any resource exists', async () => {
    const manifest = baseManifest();
    const runner = (command: string, args: string[]) => {
      if (command === 'gcloud' && args[0] === 'services' && args[1] === 'enable') return '';
      if (args.includes('apis') && args.includes('create') && !args.includes('api-configs')) {
        throw new Error('403 permission denied creating gateway api');
      }
      return '';
    };
    await expect(provision({
      runner,
      token: 'token',
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest
    })).rejects.toThrow(/permission denied/);
    expect(manifest.resources?.gateway).toEqual({ attempted: true, created: false });
    expect(manifest.resources?.endpoints).toEqual({ attempted: false, created: false });
    expect(manifest.resources?.apigee).toEqual({ attempted: false, created: false });
  });

  it('marks Apigee attempted but not created when proxy import fails after Gateway and Endpoints succeed', async () => {
    const manifest = baseManifest();
    const runner = (command: string, args: string[]) => {
      if (command === 'gcloud' && args[0] === 'services' && args[1] === 'enable') return '';
      if (args.includes('apis') && args.includes('create')) return '';
      if (args.includes('api-configs') && args.includes('create')) return '';
      if (args.includes('services') && args.includes('deploy')) return '';
      if (args.includes('configs') && args.includes('list')) return '20260720';
      if (command === 'zip') return '';
      if (command === 'curl' && args.some((arg) => String(arg).includes('apigee.googleapis.com'))) {
        throw new Error('403 permission denied importing apigee proxy');
      }
      return '';
    };
    await expect(provision({
      runner,
      token: 'token',
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest
    })).rejects.toThrow(/permission denied/);
    expect(manifest.resources?.gateway).toEqual({ attempted: true, created: true });
    expect(manifest.resources?.endpoints).toEqual({ attempted: true, created: true });
    expect(manifest.resources?.apigee).toEqual({ attempted: true, created: false });
  });

  it('tears down cleanly after Gateway permission failure when exact Gateway absence is proven and unattempted Apigee is unavailable', async () => {
    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'gcloud' && args[0] === 'auth') return 'token';
      if (args.includes('describe') && args.includes('api-gateway')) throw new Error('404 NOT_FOUND');
      if (command === 'curl') throw new Error('503 Apigee unavailable');
      return '';
    };
    const manifest = baseManifest({
      resources: {
        gateway: { attempted: true, created: false },
        endpoints: { attempted: false, created: false },
        apigee: { attempted: false, created: false }
      }
    });
    const result = await teardown({
      runner,
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest,
      log: () => {}
    });
    expect(result).toEqual({ status: 'pass' });
    expect(calls.some((call) => call.includes('api-gateway apis describe'))).toBe(true);
    expect(calls.some((call) => call.includes('endpoints'))).toBe(false);
    expect(calls.some((call) => call.includes('apigee.googleapis.com'))).toBe(false);
    expect(calls.some((call) => call.includes('delete'))).toBe(false);
  });

  it('fails teardown for attempted-but-unprovable resources instead of claiming clean', async () => {
    const runner = (command: string, args: string[]) => {
      if (command === 'gcloud' && args[0] === 'auth') return 'token';
      if (args.includes('describe') && args.includes('api-gateway')) throw new Error('403 permission denied');
      return '';
    };
    const manifest = baseManifest({
      resources: {
        gateway: { attempted: true, created: false },
        endpoints: { attempted: false, created: false },
        apigee: { attempted: false, created: false }
      }
    });
    await expect(teardown({
      runner,
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest,
      log: () => {}
    })).rejects.toThrow(/absence-unprovable|iam-denied/);
    expect(() => proveExactNameAbsent(() => { throw new Error('403 permission denied'); })).toThrow(/absence-unprovable|iam-denied/);
    expect(proveExactNameAbsent(() => { throw new Error('404 not found'); })).toBe(true);
  });

  it('refuses attempted-unconfirmed residue and never deletes it', async () => {
    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'gcloud' && args[0] === 'auth') return 'token';
      if (args.includes('api-gateway') && args.includes('describe')) {
        return JSON.stringify({ labels: { 'postman-run-marker': 'postman-live-1234' } });
      }
      return '';
    };
    const manifest = baseManifest({
      resources: {
        gateway: { attempted: true, created: false },
        endpoints: { attempted: false, created: false },
        apigee: { attempted: false, created: false }
      }
    });
    await expect(teardown({
      runner,
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest,
      log: () => {}
    })).rejects.toThrow(/residue-detected/);
    expect(calls.some((call) => call.includes(' delete '))).toBe(false);
  });

  it('refuses foreign markers before deleting confirmed resources', async () => {
    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'gcloud' && args[0] === 'auth') return 'token';
      if (args.includes('api-gateway') && args.includes('describe')) {
        return JSON.stringify({ labels: { 'postman-run-marker': 'foreign' } });
      }
      return '';
    };
    const manifest = baseManifest({
      resources: {
        gateway: { attempted: true, created: true },
        endpoints: { attempted: false, created: false },
        apigee: { attempted: false, created: false }
      }
    });
    await expect(teardown({
      runner,
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest,
      log: () => {}
    })).rejects.toThrow(/REFUSING/);
    expect(calls.some((call) => call.includes(' delete '))).toBe(false);
  });

  it('deletes only confirmed-created resources after ownership verification and proves post-delete absence', async () => {
    const calls: string[] = [];
    let gatewayPresent = true;
    const runner = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'gcloud' && args[0] === 'auth') return 'token';
      if (args.includes('api-gateway') && args.includes('apis') && args.includes('describe')) {
        if (!gatewayPresent) throw new Error('404 NOT_FOUND');
        return JSON.stringify({ labels: { 'postman-run-marker': 'postman-live-1234' } });
      }
      if (args.includes('api-gateway') && args.includes('delete')) {
        gatewayPresent = false;
        return '';
      }
      if (command === 'curl') throw new Error('503 Apigee unavailable');
      return '';
    };
    const manifest = baseManifest({
      resources: {
        gateway: { attempted: true, created: true },
        endpoints: { attempted: false, created: false },
        apigee: { attempted: false, created: false }
      }
    });
    const result = await teardown({
      runner,
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest,
      log: () => {}
    });
    expect(result).toEqual({ status: 'pass' });
    expect(calls.some((call) => call.includes('api-gateway apis delete'))).toBe(true);
    expect(calls.some((call) => call.includes('endpoints'))).toBe(false);
    expect(calls.some((call) => call.includes('apigee.googleapis.com'))).toBe(false);
    const deletesAfterFirstTeardown = calls.filter((call) => call.includes(' delete ')).length;
    await expect(teardown({
      runner,
      env: { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' },
      manifest,
      log: () => {}
    })).resolves.toEqual({ status: 'pass' });
    expect(calls.filter((call) => call.includes(' delete '))).toHaveLength(deletesAfterFirstTeardown);
    expect(markResourceAttempted(manifest, 'endpoints').attempted).toBe(true);
    expect(markResourceCreated(manifest, 'endpoints')).toEqual({ attempted: true, created: true });
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
    expect(evidence.projectScope).toBe(PROJECT_SCOPE_ALIAS);
    expect(evidence.totals.passed + evidence.totals.failed + evidence.totals.substituted).toBe(evidence.totals.cases);
    expect(raw).not.toMatch(/https?:\/\/|Bearer |projectNumber|specBody|ya29\./i);

    const historicalLegacy = {
      schemaVersion: 2,
      evidenceKind: 'historical',
      capturedAt: '2026-07-18T00:00:00.000Z',
      actionVersion: 'legacy-unbound',
      gitCommit: 'legacy-unbound',
      distCliSha256: 'legacy-unbound',
      distIndexSha256: 'legacy-unbound',
      projectScope: PROJECT_SCOPE_ALIAS,
      totals: { cases: 10, passed: 10, failed: 0, substituted: 0 },
      teardown: { status: 'pass' },
      results: [
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
      ].map((name) => toEvidenceResult(name, 'pass', { validationMode: 'legacy-unbound' }))
    };

    if (isHistoricalEvidence(evidence)) {
      expect(evidence.evidenceKind).toBe('historical');
      expect(evidence.actionVersion).toBe('legacy-unbound');
      expect(evidence.distCliSha256).toBe('legacy-unbound');
      expect(evidence.distIndexSha256).toBe('legacy-unbound');
      expect(evidence.gitCommit).toBe('legacy-unbound');
      expect(assertAcceptableLiveEvidence(evidence)).toEqual({ kind: 'historical' });
      expect(evidence.results).toHaveLength(10);
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
    } else {
      expect(evidence.evidenceKind).toBe('current');
      expect(evidence.actionVersion).not.toBe('legacy-unbound');
      expect(evidence.gitCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(evidence.distCliSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.distIndexSha256).toMatch(/^[a-f0-9]{64}$/);
      // Checked-in current failure receipt is schema-valid but not acceptable success evidence.
      // Failed validation with clean teardown is valid private failure evidence; it is not final evidence.
      expect(() => assertAcceptableLiveEvidence(evidence)).toThrow(/failed or pending|failures|teardown|incomplete matrix|missing-fixture/);
      expect(evidence.totals.failed).toBeGreaterThan(0);
    }

    expect(isHistoricalEvidence(historicalLegacy)).toBe(true);
    expect(assertAcceptableLiveEvidence(historicalLegacy)).toEqual({ kind: 'historical' });
    expect(matrixSlotsMissingCoverage(historicalLegacy.results).length).toBeGreaterThan(0);

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
      ...current,
      evidenceKind: undefined
    })).toThrow(/must declare evidenceKind current/);
    expect(() => assertAcceptableLiveEvidence({
      ...historicalLegacy,
      actionVersion: '1.2.3'
    })).toThrow(/exact legacy-unbound bindings/);
    expect(() => assertAcceptableLiveEvidence({
      ...historicalLegacy,
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
      ...historicalLegacy,
      results: [...historicalLegacy.results, toEvidenceResult('extra', 'fail', {})],
      totals: { cases: historicalLegacy.results.length + 1, passed: historicalLegacy.results.length, failed: 1, substituted: 0 }
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
        gitCommit: 'a'.repeat(40),
        distCliSha256: 'b'.repeat(64),
        distIndexSha256: 'c'.repeat(64)
      },
      teardown: { status: 'pass' }
    });
    expect(evidence.totals.failed).toBe(1);
    expect(evidence.results[0]?.reasonCode).toBe('missing-fixture');
    expect(evidence.teardown.status).toBe('pass');
    expect(() => assertAcceptableLiveEvidence(evidence)).toThrow(/failures|failed or pending|incomplete matrix|missing-fixture/);
    expect(JSON.stringify(evidence)).not.toContain('GCP_LIVE_FIXTURES_JSON');
    expect(JSON.stringify(evidence)).not.toContain('resourceId');
  });

  it('confines live state paths, rejects symlinks/schema mismatch, and saves atomically mode-0600', async () => {
    const root = tempDir('gcp-live-state-');
    mkdirSync(join(root, 'validation/.live-runs'), { recursive: true });
    const statePath = resolveStatePath({ root });
    expect(statePath.startsWith(join(root, 'validation/.live-runs'))).toBe(true);
    expect(() => resolveStatePath({ root, statePath: '../outside.json' })).toThrow(/must stay within repo root|traversal|within/);
    expect(() => resolveStatePath({ root, statePath: 'validation/evidence/state.json' })).toThrow(/live-runs|within/);
    expect(() => resolveReceiptPath({ root, phase: 'validate', receiptPath: 'validation/evidence/validate.json' })).toThrow(/live-runs|within/);
    const link = join(root, 'validation/.live-runs/link-state.json');
    const target = join(root, 'validation/.live-runs/target.json');
    writeFileSync(target, '{}\n');
    symlinkSync(target, link);
    expect(() => resolveStatePath({ root, statePath: link })).toThrow(/symlink/);

    const binding = {
      actionVersion: '1.0.0',
      gitCommit: 'a'.repeat(40),
      distCliSha256: 'b'.repeat(64),
      distIndexSha256: 'c'.repeat(64)
    };
    const state = createEmptyLiveState({
      binding,
      env: { projectId: 'sample-project', location: 'global', apigeeOrg: 'sample-project', apigeeEnv: 'test-env' },
      manifest: {
        runId: 'abcd',
        runMarker: 'postman-live-abcd',
        gatewayName: 'postman-live-abcd',
        gatewayConfigName: 'postman-live-config-abcd',
        endpointsService: 'postman-live-abcd.endpoints.sample-project.cloud.goog',
        proxyName: 'postman-live-abcd',
        resources: createEmptyResourceStates()
      }
    });
    expect(state.schemaVersion).toBe(LIVE_STATE_SCHEMA_VERSION);
    await saveLiveState(statePath, state);
    expect(lstatSync(statePath).mode & 0o777).toBe(0o600);
    const loaded = await loadLiveState(statePath);
    expect(loaded.manifest?.runId).toBe('abcd');
    expect(() => assertLiveStateSchema({ schemaVersion: 999, manifest: {} })).toThrow(/schemaVersion/);
    expect(() => assertLiveStateSchema({
      ...state,
      manifest: { ...state.manifest, runMarker: 'foreign-marker' }
    })).toThrow(/ownership binding/);
    await expect(loadLiveState(join(root, 'validation/.live-runs/missing.json'))).rejects.toThrow(/missing|state-invalid/);
  });

  it('rejects phase bypasses and stale bindings before a remote phase can run', async () => {
    const root = tempDir('gcp-live-order-');
    mkdirSync(join(root, 'validation/.live-runs'), { recursive: true });
    const binding = { actionVersion: '1.0.0', gitCommit: 'a'.repeat(40), distCliSha256: 'b'.repeat(64), distIndexSha256: 'c'.repeat(64), cliPath: 'unused', indexPath: 'unused' };
    const env = { projectId: 'p', location: 'global', apigeeOrg: 'p', apigeeEnv: 'test-env' };
    const statePath = resolveStatePath({ root });
    const state = createEmptyLiveState({ binding, env, manifest: baseManifest() });
    await saveLiveState(statePath, state);
    await expect(runPhaseValidate({
      runner: () => { throw new Error('must not run'); }, token: 't', cliPath: 'unused', env, state, statePath,
      receiptPath: resolveReceiptPath({ root, phase: 'validate' }), slots: ['api-gateway'], fixtures: [],
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS), deps: {}, log: () => undefined
    })).rejects.toThrow(/requires successful provision/);
    await expect(runLiveValidation({
      argv: ['--phase', 'validate'], env: { GCP_PROJECT_ID: 'p' },
      deps: { root, binding: { ...binding, gitCommit: 'd'.repeat(40) }, runner: () => { throw new Error('must not run'); }, log: () => undefined }
    })).rejects.toThrow(/binding-mismatch/);
    await expect(runLiveValidation({
      argv: ['--phase', 'provision'], env: { GCP_PROJECT_ID: 'p' },
      deps: { root, binding, runner: () => { throw new Error('must not run'); }, log: () => undefined }
    })).rejects.toThrow(/requires --provision/);
  });

  it('propagates command and phase timeouts through the timed runner', () => {
    const deadline = createPhaseDeadline(50, 1_000);
    expect(resolveCommandTimeoutMs(30, deadline, 1_025)).toBe(25);
    expect(() => resolveCommandTimeoutMs(30, deadline, 1_060)).toThrow(/phase-timeout/);
    expect(() => deadline.assertNotExpired(1_060)).toThrow(/phase-timeout/);
    const timed = createTimedRunner((_command, _args, options) => {
      expect(options?.timeout).toBe(20);
      const error = new Error('spawn ETIMEDOUT');
      (error as { code?: string }).code = 'ETIMEDOUT';
      throw error;
    }, { commandTimeoutMs: 20, deadline: createPhaseDeadline(1_000) });
    expect(() => timed('gcloud', ['version'])).toThrow(/command-timeout/);
    expect(classifyPhaseFailure({ reasonCode: 'phase-timeout' })).toBe('phase-timeout');
    expect(classifyPhaseFailure({ reasonCode: 'command-timeout' })).toBe('command-timeout');
  });

  it('runs preflight without GCP resource writes and checkpoints provision/validate/teardown/assemble', async () => {
    const root = tempDir('gcp-live-phases-');
    mkdirSync(join(root, 'validation/.live-runs'), { recursive: true });
    mkdirSync(join(root, 'validation/evidence'), { recursive: true });
    const tracked = join(root, 'validation/evidence/live-gcp-surfaces.json');
    writeFileSync(tracked, JSON.stringify({ marker: 'untouched' }));
    const statePath = resolveStatePath({ root });
    const binding = {
      actionVersion: '1.0.0',
      gitCommit: 'd'.repeat(40),
      distCliSha256: 'e'.repeat(64),
      distIndexSha256: 'f'.repeat(64),
      cliPath: join(root, 'dist/cli.cjs'),
      indexPath: join(root, 'dist/index.cjs')
    };
    const env = { projectId: 'sample-project', location: 'global', apigeeOrg: 'sample-project', apigeeEnv: 'test-env' };
    const commands: string[] = [];
    const runner = (command: string, args: string[]) => {
      commands.push([command, ...args].join(' '));
      if (args[0] === 'projects' && args[1] === 'describe') return 'sample-project\n';
      if (args[0] === 'auth') return 'token\n';
      if (args.includes('apis') && args.includes('create')) return '';
      if (args.includes('api-configs') && args.includes('create')) return '';
      if (args.includes('services') && args.includes('deploy')) return '';
      if (args.includes('configs') && args.includes('list')) return 'cfg-1\n';
      if (args[0] === 'services' && args[1] === 'enable') return '';
      if (command === 'zip') return '';
      if (command === 'curl' && args.includes('-X') && args.includes('POST')) return '{}';
      if (command === 'curl' && args.includes('-X') && args.includes('GET')) {
        const err = new Error('NOT_FOUND');
        throw err;
      }
      if (args.includes('describe')) {
        const err = new Error('NOT_FOUND');
        throw err;
      }
      if (args.includes('delete')) return '';
      return '';
    };

    const preflightReceipt = resolveReceiptPath({ root, phase: 'preflight' });
    const preflight = await runPhasePreflight({
      runner,
      env,
      binding,
      statePath,
      receiptPath: preflightReceipt,
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS),
      log: () => undefined
    });
    expect(preflight.receipt.status).toBe('pass');
    expect(commands.some((line) => /apis create|services deploy|action=import/.test(line))).toBe(false);
    expect(commands.some((line) => line.includes('projects describe sample-project'))).toBe(true);

    let checkpoints = 0;
    const provisionReceipt = resolveReceiptPath({ root, phase: 'provision' });
    const provisioned = await runPhaseProvision({
      runner,
      token: 'token',
      env,
      state: preflight.state,
      statePath,
      receiptPath: provisionReceipt,
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS),
      deps: {
        provision: async ({ manifest, onCheckpoint }: {
          manifest: { resources?: Record<string, { attempted: boolean; created: boolean }> };
          onCheckpoint?: (manifest: unknown) => Promise<void> | void;
        }) => {
          markResourceAttempted(manifest as never, 'gateway');
          await onCheckpoint?.(manifest);
          checkpoints += 1;
          markResourceCreated(manifest as never, 'gateway');
          await onCheckpoint?.(manifest);
          checkpoints += 1;
          return { endpointsConfigId: 'cfg-1' };
        }
      },
      log: () => undefined
    });
    expect(checkpoints).toBeGreaterThanOrEqual(2);
    expect(provisioned.state.phaseStatus.provision).toBe('pass');
    const mid = await loadLiveState(statePath);
    expect(mid.manifest?.resources?.gateway.created).toBe(true);

    const validateReceipt = resolveReceiptPath({ root, phase: 'validate' });
    await expect(runPhaseValidate({
      runner,
      token: 'token',
      cliPath: binding.cliPath,
      env,
      state: provisioned.state,
      statePath,
      receiptPath: validateReceipt,
      slots: ['not-allowed-slot'],
      fixtures: [],
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS),
      deps: {},
      log: () => undefined
    })).rejects.toThrow(/slot-not-allowed/);

    const prior = [toEvidenceResult('gateway-explicit-api-id', 'pass', {
      providerType: 'api-gateway',
      sourceType: 'api-gateway-config',
      validationMode: 'exact-bytes'
    })];
    await saveLiveState(statePath, { ...provisioned.state, completedSlots: prior });
    const validated = await runPhaseValidate({
      runner,
      token: 'token',
      cliPath: binding.cliPath,
      env,
      state: { ...provisioned.state, completedSlots: prior },
      statePath,
      receiptPath: validateReceipt,
      slots: ['gateway-explicit-api-id'],
      fixtures: [],
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS),
      deps: {
        runProvisionedCases: async () => {
          throw new Error('should carry forward completed slots without re-running');
        }
      },
      log: () => undefined
    });
    expect(validated.results).toEqual(prior);
    expect(mergeCompletedSlots(prior, [
      toEvidenceResult('iac-single', 'pass', { providerType: 'iac-local', sourceType: 'iac-embedded', validationMode: 'exact-bytes' })
    ]).map((result) => result.name)).toEqual(['gateway-explicit-api-id', 'iac-single']);

    const failedPrior = [toEvidenceResult('gateway-explicit-api-id', 'fail', {
      providerType: 'api-gateway',
      validationMode: 'exact-bytes',
      reasonCode: 'cli-failed'
    })];
    await saveLiveState(statePath, { ...provisioned.state, completedSlots: failedPrior });
    let retryRuns = 0;
    const retried = await runPhaseValidate({
      runner,
      token: 'token',
      cliPath: binding.cliPath,
      env,
      state: { ...provisioned.state, completedSlots: failedPrior },
      statePath,
      receiptPath: validateReceipt,
      slots: ['gateway-explicit-api-id'],
      fixtures: [],
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS),
      deps: {
        runProvisionedCases: async () => {
          retryRuns += 1;
          return [toEvidenceResult('gateway-explicit-api-id', 'pass', {
            providerType: 'api-gateway',
            sourceType: 'api-gateway-config',
            validationMode: 'exact-bytes'
          })];
        }
      },
      log: () => undefined
    });
    expect(retryRuns).toBe(1);
    expect(retried.results).toEqual([expect.objectContaining({ name: 'gateway-explicit-api-id', status: 'pass' })]);

    await expect(runPhaseValidate({
      runner,
      token: 'token',
      cliPath: binding.cliPath,
      env,
      state: validated.state,
      statePath,
      receiptPath: validateReceipt,
      slots: ['api-hub-original'],
      fixtures: [],
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS),
      deps: {
        runMatrixCoverage: async () => [
          toEvidenceResult('api-hub-original', 'fail', {
            providerType: 'api-hub',
            validationMode: 'exact-bytes',
            reasonCode: 'missing-fixture'
          }),
          toEvidenceResult('api-hub-additional', 'pass', {
            providerType: 'api-hub',
            validationMode: 'exact-bytes'
          })
        ]
      },
      log: () => undefined
    })).rejects.toThrow(/fail-fast|missing-fixture/);
    const afterFail = await loadLiveState(statePath);
    expect(afterFail.completedSlots.some((result) => result.name === 'gateway-explicit-api-id')).toBe(true);
    expect(afterFail.completedSlots.some((result) => result.name === 'api-hub-additional')).toBe(false);

    const teardownReceipt = resolveReceiptPath({ root, phase: 'teardown' });
    const torn1 = await runPhaseTeardown({
      runner,
      env,
      state: afterFail,
      statePath,
      receiptPath: teardownReceipt,
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS),
      deps: {
        teardown: async () => ({ status: 'pass' })
      },
      log: () => undefined
    });
    expect(torn1.receipt.status).toBe('pass');
    const torn2 = await runPhaseTeardown({
      runner,
      env,
      state: torn1.state,
      statePath,
      receiptPath: teardownReceipt,
      deadline: createPhaseDeadline(DEFAULT_PHASE_TIMEOUT_MS),
      deps: {
        teardown: async () => ({ status: 'pass' })
      },
      log: () => undefined
    });
    expect(torn2.receipt.status).toBe('pass');
    expect(JSON.parse(readFileSync(tracked, 'utf8')).marker).toBe('untouched');

    const completeResults = [
      ...[
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
      ].map((name) => toEvidenceResult(name, 'pass', { validationMode: 'exact-bytes' })),
      ...LIVE_COVERAGE_MATRIX
        .filter((slot) => !slot.satisfiedBy?.length)
        .map((slot) => toEvidenceResult(slot.name, 'substitute', {
          providerType: slot.providerType,
          sourceType: slot.expectedSourceTypes[0],
          validationMode: slot.validationMode,
          reasonCode: 'iam-denied'
        }))
    ];
    const receiptBinding = {
      actionVersion: binding.actionVersion,
      gitCommit: binding.gitCommit,
      distCliSha256: binding.distCliSha256,
      distIndexSha256: binding.distIndexSha256
    };
    const receipts = {
      preflight: join(root, 'validation/.live-runs/preflight-receipt.json'),
      provision: join(root, 'validation/.live-runs/provision-receipt.json'),
      validate: join(root, 'validation/.live-runs/validate-full.json'),
      teardown: join(root, 'validation/.live-runs/teardown-clean.json')
    };
    await writePhaseReceipt(receipts.preflight, { phase: 'preflight', binding: receiptBinding, status: 'pass', elapsedMs: 1 });
    await writePhaseReceipt(receipts.provision, { phase: 'provision', binding: receiptBinding, status: 'pass', elapsedMs: 1 });
    await writePhaseReceipt(receipts.validate, {
      phase: 'validate',
      binding: receiptBinding,
      status: 'pass',
      elapsedMs: 1,
      results: completeResults
    });
    await writePhaseReceipt(receipts.teardown, {
      phase: 'teardown',
      binding: receiptBinding,
      status: 'pass',
      elapsedMs: 1,
      teardown: { status: 'pass' }
    });
    expect(() => assembleFromPhaseReceipts({
      receipts: [
        JSON.parse(readFileSync(receipts.preflight, 'utf8')),
        JSON.parse(readFileSync(receipts.provision, 'utf8')),
        JSON.parse(readFileSync(receipts.validate, 'utf8')),
        JSON.parse(readFileSync(receipts.teardown, 'utf8')),
        JSON.parse(readFileSync(receipts.teardown, 'utf8'))
      ],
      binding: receiptBinding
    })).toThrow(/duplicate phase/);
    expect(() => assembleFromPhaseReceipts({
      receipts: [
        JSON.parse(readFileSync(receipts.preflight, 'utf8')),
        JSON.parse(readFileSync(receipts.provision, 'utf8')),
        {
          ...JSON.parse(readFileSync(receipts.validate, 'utf8')),
          results: completeResults.slice(1)
        },
        JSON.parse(readFileSync(receipts.teardown, 'utf8'))
      ],
      binding: receiptBinding
    })).toThrow(/exactly once|assemble-incomplete/);
    expect(() => assembleFromPhaseReceipts({
      receipts: [
        JSON.parse(readFileSync(receipts.preflight, 'utf8')),
        JSON.parse(readFileSync(receipts.provision, 'utf8')),
        JSON.parse(readFileSync(receipts.validate, 'utf8')),
        {
          ...JSON.parse(readFileSync(receipts.teardown, 'utf8')),
          binding: { ...receiptBinding, gitCommit: '0'.repeat(40) }
        }
      ],
      binding: receiptBinding
    })).toThrow(/binding-mismatch/);
    expect(() => assembleFromPhaseReceipts({
      receipts: [
        JSON.parse(readFileSync(receipts.preflight, 'utf8')),
        JSON.parse(readFileSync(receipts.provision, 'utf8')),
        JSON.parse(readFileSync(receipts.validate, 'utf8')),
        {
          ...JSON.parse(readFileSync(receipts.teardown, 'utf8')),
          teardown: { status: 'fail', reasonCode: 'teardown-failed' },
          status: 'fail'
        }
      ],
      binding: receiptBinding
    })).toThrow(/assemble-incomplete|did not pass|teardown/);

    const promoted = await runPhaseAssemble({
      binding: receiptBinding,
      receiptPaths: [receipts.preflight, receipts.provision, receipts.validate, receipts.teardown],
      root,
      promote: true
    });
    expect(assertAcceptableLiveEvidence(promoted)).toEqual({ kind: 'current' });
    expect(JSON.parse(readFileSync(tracked, 'utf8')).evidenceKind).toBe('current');

    await expect(runLiveValidation({
      argv: ['--phase', 'all'],
      env: { GCP_PROJECT_ID: 'sample-project' },
      deps: { root, runner, binding, log: () => undefined }
    })).rejects.toThrow(/--provision --teardown/);
    expect(assertValidateSlotsAllowed(['api-gateway'])).toEqual(['api-gateway']);
  });

  it('keeps tracked evidence untouched when a phase fails after clean teardown', async () => {
    const root = tempDir('gcp-live-fail-clean-');
    mkdirSync(join(root, 'validation/.live-runs/failed-runs'), { recursive: true });
    mkdirSync(join(root, 'validation/evidence'), { recursive: true });
    const tracked = join(root, 'validation/evidence/live-gcp-surfaces.json');
    const before = { schemaVersion: 2, evidenceKind: 'historical', marker: 'stable' };
    writeFileSync(tracked, `${JSON.stringify(before)}\n`);
    const failed = buildEvidence({
      results: [toEvidenceResult('runner', 'fail', { reasonCode: 'cli-failed', validationMode: '' })],
      binding: {
        actionVersion: '1.0.0',
        gitCommit: 'a'.repeat(40),
        distCliSha256: 'b'.repeat(64),
        distIndexSha256: 'c'.repeat(64)
      },
      teardown: { status: 'pass' }
    });
    expect(failed.teardown.status).toBe('pass');
    expect(failed.totals.failed).toBe(1);
    expect(() => assertAcceptableLiveEvidence(failed)).toThrow(/failures|failed or pending|incomplete matrix/);
    await writeAtomicJson(join(root, 'validation/.live-runs/failed-runs/private-failed.json'), failed, { mode: 0o600 });
    expect(JSON.parse(readFileSync(tracked, 'utf8')).marker).toBe('stable');
    expect(existsSync(join(root, 'validation/.live-runs/failed-runs/private-failed.json'))).toBe(true);
  });
});
