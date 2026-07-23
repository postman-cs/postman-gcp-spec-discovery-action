import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CI_PROVIDER,
  DEFAULT_ABSENCE_RETRY_COUNT,
  DEFAULT_RECEIPT_RELATIVE,
  EXPECTED_PROVIDER_TYPE,
  EXPECTED_RESOLUTION_STATUS,
  EXPECTED_SOURCE_TYPE,
  GCP_CREDENTIAL_CLASS,
  PINNED_RELEASE_TAG,
  POSTMAN_API_HOST,
  POSTMAN_CREDENTIAL_CLASS,
  RECEIPT_SCHEMA_VERSION,
  RUNNER_KIND,
  assertDiscoveryAndRelease,
  assertResourcesYaml,
  confinePathWithinRoot,
  extractWorkspaceUidFromResources,
  readVerifierInputs,
  reconcileWorkspaceUids,
  runCli,
  sanitizeReceipt,
  teardownVerifiedWorkspace,
  verifyLiveGcsOnboarding
} from '../validation/scripts/verify-live-gcs-onboarding.mjs';

const root = process.cwd();
const tempDirs: string[] = [];

/** Distinct runtime SHA used in happy-path tests (not a hardcoded verifier default). */
const RUNTIME_RELEASE_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** Alternate valid runtime SHA — must be recorded faithfully with no substitution. */
const ALTERNATE_RUNTIME_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_RUN_ID: '30123456789',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_URL: 'https://github.com/postman-cs/postman-gcp-spec-discovery-action/actions/runs/30123456789',
    RELEASE_TAG: PINNED_RELEASE_TAG,
    RELEASE_COMMIT: RUNTIME_RELEASE_COMMIT,
    RESOLUTION_STATUS: EXPECTED_RESOLUTION_STATUS,
    PROVIDER_TYPE: EXPECTED_PROVIDER_TYPE,
    SOURCE_TYPE: EXPECTED_SOURCE_TYPE,
    SPEC_PATH: 'discovered-specs/connector-openapi.yaml',
    PROJECT_NAME: 'live-gcs-onboarding-30123456789-1',
    ONBOARD_OUTCOME: 'success',
    POSTMAN_API_KEY: 'PMAK-test-key-not-real',
    RESOURCES_PATH: '.postman/resources.yaml',
    RECEIPT_PATH: DEFAULT_RECEIPT_RELATIVE,
    ...overrides
  };
}

function validResourcesYaml(projectName: string, specPath: string, workspaceUid = 'ws123abc'): string {
  return [
    'version: 2',
    'workspace:',
    `  id: ${workspaceUid}`,
    'canonical:',
    '  specs:',
    `    ../${specPath}: specuid123`,
    '  collections:',
    `    ../postman/collections/${projectName}: colbaseline1`,
    `    ../postman/collections/[Smoke] ${projectName}: colsmoke1`,
    `    ../postman/collections/[Contract] ${projectName}: colcontract1`,
    'localResources:',
    '  specs:',
    `    ../${specPath}: local-spec-ref`
  ].join('\n');
}

function workspaceOnlyYaml(workspaceUid = 'ws123abc'): string {
  return ['version: 2', 'workspace:', `  id: ${workspaceUid}`].join('\n');
}

type MockCall = { method: string; url: string; headers: Record<string, string> };

function mockFetchSequence(
  handlers: Array<(call: MockCall) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>>
) {
  const calls: MockCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
    const call = { method, url, headers };
    calls.push(call);
    const handler = handlers[calls.length - 1];
    if (!handler) {
      return {
        ok: false,
        status: 500,
        json: async () => ({})
      } as Response;
    }
    const result = await handler(call);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body ?? {}
    } as Response;
  };
  return { fetchImpl, calls };
}

describe('live GCS onboarding verifier', () => {
  it('succeeds with resources.yaml assertions, name-guarded delete, 404 absence, and schema-v1 receipt', async () => {
    const dir = tempDir('gcs-onboard-ok-');
    const projectName = 'live-gcs-onboarding-30123456789-1';
    const specPath = 'discovered-specs/connector-openapi.yaml';
    mkdirSync(join(dir, '.postman'), { recursive: true });
    writeFileSync(join(dir, '.postman/resources.yaml'), validResourcesYaml(projectName, specPath));

    const { fetchImpl, calls } = mockFetchSequence([
      () => ({ status: 200, body: { workspace: { id: 'ws123abc', name: projectName } } }),
      () => ({ status: 200, body: {} }),
      () => ({ status: 404, body: {} })
    ]);

    const result = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({ SPEC_PATH: specPath, PROJECT_NAME: projectName }),
      fetchImpl,
      absenceRetryCount: 2,
      absenceRetryDelayMs: 0,
      now: () => '2026-07-23T12:00:00.000Z'
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.receiptPath).toContain('gcs-onboarding-receipt.json');
    expect(existsSync(result.receiptPath)).toBe(true);

    const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8')) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      capturedAt: '2026-07-23T12:00:00.000Z',
      releaseTag: PINNED_RELEASE_TAG,
      releaseCommit: RUNTIME_RELEASE_COMMIT,
      runId: '30123456789',
      runAttempt: 1,
      runUrl: 'https://github.com/postman-cs/postman-gcp-spec-discovery-action/actions/runs/30123456789',
      ciProvider: CI_PROVIDER,
      runnerKind: RUNNER_KIND,
      gcpCredentialClass: GCP_CREDENTIAL_CLASS,
      postmanCredentialClass: POSTMAN_CREDENTIAL_CLASS,
      discoveryProvider: EXPECTED_PROVIDER_TYPE,
      discoverySource: EXPECTED_SOURCE_TYPE,
      onboardingStatus: 'success',
      teardownStatus: 'pass'
    });
    expect(receipt.failureClass).toBeUndefined();
    expect(receipt.artifactAssertions).toEqual({
      resourcesYamlPresent: true,
      resourcesYamlValid: true,
      workspaceUidPresent: true,
      specUidPresent: true,
      baselineCollectionUidPresent: true,
      smokeCollectionUidPresent: true,
      contractCollectionUidPresent: true,
      discoveredSpecMapped: true,
      discoveryHandoffValid: true,
      releaseIdentityValid: true
    });

    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(calls.every((c) => c.url.startsWith(`${POSTMAN_API_HOST}/workspaces/`))).toBe(true);
    expect(calls.every((c) => c.headers['x-api-key'] === 'PMAK-test-key-not-real')).toBe(true);

    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('PMAK-');
    expect(serialized).not.toContain('ws123abc');
    expect(serialized).not.toContain('specuid123');
    expect(serialized).not.toContain('colbaseline1');
    expect(serialized).not.toContain(projectName);
    expect(serialized).not.toContain(specPath);
  });

  it('fails closed on missing or malformed resources.yaml', async () => {
    const missingDir = tempDir('gcs-onboard-missing-');
    const missing = await verifyLiveGcsOnboarding({
      root: missingDir,
      env: baseEnv(),
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
      absenceRetryDelayMs: 0
    });
    expect(missing.ok).toBe(false);
    expect(missing.receipt.failureClass).toBe('resources-missing');
    expect(missing.receipt.artifactAssertions.resourcesYamlPresent).toBe(false);
    expect(missing.receipt.teardownStatus).toBe('skipped');

    const malformedDir = tempDir('gcs-onboard-bad-');
    mkdirSync(join(malformedDir, '.postman'), { recursive: true });
    writeFileSync(join(malformedDir, '.postman/resources.yaml'), '- not: a-mapping\n');
    const malformed = await verifyLiveGcsOnboarding({
      root: malformedDir,
      env: baseEnv(),
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response,
      absenceRetryDelayMs: 0
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.receipt.failureClass).toBe('resources-malformed');
    expect(malformed.receipt.artifactAssertions.resourcesYamlPresent).toBe(true);
  });

  it('cleans up from partial workspace-only YAML when later mapping assertions fail', async () => {
    const dir = tempDir('gcs-onboard-partial-ws-');
    const projectName = 'live-gcs-onboarding-30123456789-1';
    mkdirSync(join(dir, '.postman'), { recursive: true });
    writeFileSync(join(dir, '.postman/resources.yaml'), workspaceOnlyYaml('wspartial1'));

    expect(extractWorkspaceUidFromResources(workspaceOnlyYaml('wspartial1'))).toBe('wspartial1');

    const { fetchImpl, calls } = mockFetchSequence([
      () => ({ status: 200, body: { workspace: { id: 'wspartial1', name: projectName } } }),
      () => ({ status: 200, body: {} }),
      () => ({ status: 404, body: {} })
    ]);

    const result = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({ PROJECT_NAME: projectName }),
      fetchImpl,
      absenceRetryCount: 2,
      absenceRetryDelayMs: 0
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.failureClass).toBe('resources-assertion-failed');
    expect(result.receipt.artifactAssertions.resourcesYamlPresent).toBe(true);
    expect(result.receipt.artifactAssertions.resourcesYamlValid).toBe(false);
    expect(result.receipt.artifactAssertions.workspaceUidPresent).toBe(true);
    expect(result.receipt.teardownStatus).toBe('pass');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(JSON.stringify(result.receipt)).not.toContain('wspartial1');
    expect(JSON.stringify(result.receipt)).not.toContain('PMAK-');
  });

  it('cleans up from composite WORKSPACE_UID when resources.yaml is absent (still resources-missing)', async () => {
    const dir = tempDir('gcs-onboard-output-uid-');
    const projectName = 'live-gcs-onboarding-30123456789-1';

    const { fetchImpl, calls } = mockFetchSequence([
      () => ({ status: 200, body: { workspace: { id: 'wsfromout1', name: projectName } } }),
      () => ({ status: 200, body: {} }),
      () => ({ status: 404, body: {} })
    ]);

    const result = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({ PROJECT_NAME: projectName, WORKSPACE_UID: 'wsfromout1' }),
      fetchImpl,
      absenceRetryCount: 2,
      absenceRetryDelayMs: 0
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.failureClass).toBe('resources-missing');
    expect(result.receipt.artifactAssertions.resourcesYamlPresent).toBe(false);
    expect(result.receipt.teardownStatus).toBe('pass');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET']);
    expect(JSON.stringify(result.receipt)).not.toContain('wsfromout1');
    expect(JSON.stringify(result.receipt)).not.toContain('PMAK-');
  });

  it('refuses DELETE on composite vs resources workspace UID mismatch', async () => {
    const dir = tempDir('gcs-onboard-uid-mismatch-');
    const projectName = 'live-gcs-onboarding-30123456789-1';
    const specPath = 'discovered-specs/connector-openapi.yaml';
    mkdirSync(join(dir, '.postman'), { recursive: true });
    writeFileSync(join(dir, '.postman/resources.yaml'), validResourcesYaml(projectName, specPath, 'wsfromyaml1'));

    expect(reconcileWorkspaceUids('wsfromout1', 'wsfromyaml1')).toEqual({
      mismatch: true,
      workspaceUid: ''
    });

    const { fetchImpl, calls } = mockFetchSequence([
      () => ({ status: 200, body: { workspace: { id: 'wsfromyaml1', name: projectName } } })
    ]);

    const result = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({
        PROJECT_NAME: projectName,
        SPEC_PATH: specPath,
        WORKSPACE_UID: 'wsfromout1'
      }),
      fetchImpl,
      absenceRetryDelayMs: 0
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.failureClass).toBe('resources-assertion-failed');
    expect(result.receipt.teardownStatus).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(JSON.stringify(result.receipt)).not.toContain('wsfromout1');
    expect(JSON.stringify(result.receipt)).not.toContain('wsfromyaml1');
  });

  it('refuses DELETE when workspace name does not match the run-scoped expected name', async () => {
    const dir = tempDir('gcs-onboard-foreign-');
    const projectName = 'live-gcs-onboarding-30123456789-1';
    mkdirSync(join(dir, '.postman'), { recursive: true });
    writeFileSync(
      join(dir, '.postman/resources.yaml'),
      validResourcesYaml(projectName, 'discovered-specs/connector-openapi.yaml')
    );

    const { fetchImpl, calls } = mockFetchSequence([
      () => ({ status: 200, body: { workspace: { id: 'ws123abc', name: 'someone-elses-workspace' } } }),
      () => ({ status: 200, body: { workspace: { id: 'ws123abc', name: 'someone-elses-workspace' } } })
    ]);

    const result = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({ PROJECT_NAME: projectName }),
      fetchImpl,
      absenceRetryDelayMs: 0
    });

    expect(result.ok).toBe(false);
    expect(result.receipt.failureClass).toBe('foreign-workspace-name');
    // Primary teardown GET plus guarded finally cleanup GET; never DELETE.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('proves deletion then absence and bounds absence retries', async () => {
    let getsAfterDelete = 0;
    const { fetchImpl, calls } = mockFetchSequence([
      () => ({ status: 200, body: { workspace: { name: 'live-gcs-onboarding-1-1' } } }),
      () => ({ status: 200, body: {} }),
      () => {
        getsAfterDelete += 1;
        return { status: 200, body: { workspace: { name: 'live-gcs-onboarding-1-1' } } };
      },
      () => {
        getsAfterDelete += 1;
        return { status: 200, body: { workspace: { name: 'live-gcs-onboarding-1-1' } } };
      },
      () => {
        getsAfterDelete += 1;
        return { status: 404, body: {} };
      }
    ]);

    const sleeps: number[] = [];
    await expect(
      teardownVerifiedWorkspace(
        {
          fetchImpl,
          absenceRetryCount: 3,
          absenceRetryDelayMs: 11,
          sleep: async (ms) => {
            sleeps.push(ms);
          }
        },
        'PMAK-test',
        'ws123abc',
        'live-gcs-onboarding-1-1'
      )
    ).resolves.toMatchObject({ status: 'pass', deleted: true });

    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'GET', 'GET', 'GET']);
    expect(getsAfterDelete).toBe(3);
    expect(sleeps.length).toBeLessThanOrEqual(DEFAULT_ABSENCE_RETRY_COUNT);
    expect(sleeps).toEqual([11, 11]);

    const unbounded = mockFetchSequence(
      Array.from({ length: 8 }, () => () => ({
        status: 200,
        body: { workspace: { name: 'live-gcs-onboarding-1-1' } }
      }))
    );
    await expect(
      teardownVerifiedWorkspace(
        {
          fetchImpl: unbounded.fetchImpl,
          absenceRetryCount: 2,
          absenceRetryDelayMs: 0
        },
        'PMAK-test',
        'ws123abc',
        'live-gcs-onboarding-1-1'
      )
    ).rejects.toMatchObject({ failureClass: 'workspace-absence-unproven' });
    expect(unbounded.calls.filter((c) => c.method === 'GET').length).toBe(1 + 2);
  });

  it('sanitizes timeout and API failures without leaking secrets or ids into the receipt', async () => {
    const dir = tempDir('gcs-onboard-timeout-');
    const projectName = 'live-gcs-onboarding-30123456789-1';
    mkdirSync(join(dir, '.postman'), { recursive: true });
    writeFileSync(
      join(dir, '.postman/resources.yaml'),
      validResourcesYaml(projectName, 'discovered-specs/connector-openapi.yaml')
    );

    const timeout = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({ PROJECT_NAME: projectName, POSTMAN_API_KEY: 'PMAK-super-secret' }),
      fetchImpl: async () => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      },
      absenceRetryDelayMs: 0
    });
    expect(timeout.ok).toBe(false);
    expect(timeout.receipt.failureClass).toBe('api-timeout');
    expect(JSON.stringify(timeout.receipt)).not.toContain('PMAK-super-secret');
    expect(JSON.stringify(timeout.receipt)).not.toContain('ws123abc');
    expect(JSON.stringify(timeout.receipt)).not.toContain('aborted due to timeout');

    const apiError = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({ PROJECT_NAME: projectName }),
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'upstream boom' }) }) as Response,
      absenceRetryDelayMs: 0
    });
    expect(apiError.ok).toBe(false);
    expect(apiError.receipt.failureClass).toBe('api-error');
    expect(JSON.stringify(apiError.receipt)).not.toContain('upstream boom');
  });

  it('rejects receipt/resources path escape and symlink targets', async () => {
    expect(() => confinePathWithinRoot(root, '../outside.json', 'receipt-path')).toThrow(/outside-root/);

    const dir = tempDir('gcs-onboard-symlink-');
    mkdirSync(join(dir, '.postman'), { recursive: true });
    mkdirSync(join(dir, 'validation/.live-runs'), { recursive: true });
    writeFileSync(join(dir, '.postman/resources.yaml'), validResourcesYaml('p', 'discovered-specs/x.yaml'));
    writeFileSync(join(dir, 'outside-receipt.json'), '{}\n');
    symlinkSync(join(dir, 'outside-receipt.json'), join(dir, 'validation/.live-runs/gcs-onboarding-receipt.json'));

    const result = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({
        PROJECT_NAME: 'p',
        SPEC_PATH: 'discovered-specs/x.yaml',
        RECEIPT_PATH: 'validation/.live-runs/gcs-onboarding-receipt.json'
      }),
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ workspace: { name: 'p' } })
        }) as Response,
      absenceRetryDelayMs: 0
    });
    expect(result.ok).toBe(false);
    expect(result.receipt.failureClass).toBe('symlink-rejected');
  });

  it('requires runtime RELEASE_COMMIT (no default SHA) and immutable tag v1.1.6', async () => {
    expect(PINNED_RELEASE_TAG).toBe('v1.1.6');

    expect(() =>
      readVerifierInputs(
        baseEnv({
          RELEASE_COMMIT: undefined
        })
      )
    ).toThrow(/input-invalid/);

    try {
      readVerifierInputs(baseEnv({ RELEASE_COMMIT: undefined }));
      expect.unreachable('expected missing RELEASE_COMMIT to throw');
    } catch (error) {
      expect(error).toMatchObject({ failureClass: 'input-invalid' });
      expect((error as { missing?: string[] }).missing).toContain('RELEASE_COMMIT');
    }

    expect(() =>
      readVerifierInputs(
        baseEnv({
          RELEASE_COMMIT: 'not-a-commit'
        })
      )
    ).toThrow(/release-identity/);

    expect(() =>
      readVerifierInputs(
        baseEnv({
          RELEASE_COMMIT: 'AAAAAAAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        })
      )
    ).toThrow(/release-identity/);

    const inputs = readVerifierInputs(baseEnv({ RELEASE_COMMIT: ALTERNATE_RUNTIME_COMMIT }));
    expect(inputs.releaseCommit).toBe(ALTERNATE_RUNTIME_COMMIT);
    expect(inputs.releaseTag).toBe('v1.1.6');

    expect(() =>
      assertDiscoveryAndRelease({
        discoveryStatus: EXPECTED_RESOLUTION_STATUS,
        discoveryProvider: EXPECTED_PROVIDER_TYPE,
        discoverySource: EXPECTED_SOURCE_TYPE,
        releaseTag: 'v1.1.4',
        releaseCommit: ALTERNATE_RUNTIME_COMMIT
      })
    ).toThrow(/release-identity-invalid/);

    expect(
      assertDiscoveryAndRelease({
        discoveryStatus: EXPECTED_RESOLUTION_STATUS,
        discoveryProvider: EXPECTED_PROVIDER_TYPE,
        discoverySource: EXPECTED_SOURCE_TYPE,
        releaseTag: PINNED_RELEASE_TAG,
        releaseCommit: ALTERNATE_RUNTIME_COMMIT
      })
    ).toEqual({ discoveryHandoffValid: true, releaseIdentityValid: true });

    const dir = tempDir('gcs-onboard-runtime-sha-');
    const projectName = 'live-gcs-onboarding-30123456789-1';
    const specPath = 'discovered-specs/connector-openapi.yaml';
    mkdirSync(join(dir, '.postman'), { recursive: true });
    writeFileSync(join(dir, '.postman/resources.yaml'), validResourcesYaml(projectName, specPath));

    const { fetchImpl } = mockFetchSequence([
      () => ({ status: 200, body: { workspace: { id: 'ws123abc', name: projectName } } }),
      () => ({ status: 200, body: {} }),
      () => ({ status: 404, body: {} })
    ]);

    const result = await verifyLiveGcsOnboarding({
      root: dir,
      env: baseEnv({
        SPEC_PATH: specPath,
        PROJECT_NAME: projectName,
        RELEASE_COMMIT: ALTERNATE_RUNTIME_COMMIT
      }),
      fetchImpl,
      absenceRetryCount: 2,
      absenceRetryDelayMs: 0
    });

    expect(result.ok).toBe(true);
    expect(result.receipt.releaseCommit).toBe(ALTERNATE_RUNTIME_COMMIT);
    expect(result.receipt.releaseTag).toBe('v1.1.6');
    expect(result.receipt.releaseCommit).not.toBe(RUNTIME_RELEASE_COMMIT);

    const asserted = assertResourcesYaml(validResourcesYaml('proj', 'discovered-specs/a.yaml'), {
      specPath: 'discovered-specs/a.yaml',
      expectedWorkspaceName: 'proj'
    });
    expect(asserted.workspaceUid).toBe('ws123abc');
    expect(asserted.specUid).toBe('specuid123');
    expect(asserted.baselineCollectionUid).toBe('colbaseline1');
    expect(asserted.smokeCollectionUid).toBe('colsmoke1');
    expect(asserted.contractCollectionUid).toBe('colcontract1');

    expect(() =>
      assertResourcesYaml('workspace:\n  id: ws1\n', {
        specPath: 'discovered-specs/a.yaml',
        expectedWorkspaceName: 'proj'
      })
    ).toThrow(/resources-assertion-failed/);

    const receipt = sanitizeReceipt({
      releaseTag: PINNED_RELEASE_TAG,
      releaseCommit: ALTERNATE_RUNTIME_COMMIT,
      runId: '1',
      runAttempt: 1,
      runUrl: 'https://github.com/postman-cs/postman-gcp-spec-discovery-action/actions/runs/1',
      discoveryProvider: EXPECTED_PROVIDER_TYPE,
      discoverySource: EXPECTED_SOURCE_TYPE,
      onboardingStatus: 'success',
      teardownStatus: 'pass',
      failureClass: 'raw-secret-should-not-pass',
      artifactAssertions: { resourcesYamlPresent: true }
    });
    expect(receipt.failureClass).toBe('api-error');
    expect(receipt.ciProvider).toBe(CI_PROVIDER);
    expect(receipt.releaseCommit).toBe(ALTERNATE_RUNTIME_COMMIT);
  });

  it('writes a sanitized fallback receipt when CLI inputs are incomplete', async () => {
    const dir = tempDir('gcs-onboard-input-invalid-');
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runCli({
        root: dir,
        env: baseEnv({ PROVIDER_TYPE: undefined }),
        now: () => '2026-07-23T12:00:00.000Z'
      });

      expect(result.ok).toBe(false);
      expect(result.receipt.failureClass).toBe('input-invalid');
      expect(result.receiptPath).toBe(join(dir, DEFAULT_RECEIPT_RELATIVE));
      expect(existsSync(result.receiptPath)).toBe(true);
      expect(JSON.parse(readFileSync(result.receiptPath, 'utf8'))).toEqual(result.receipt);
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});

describe('live GCS onboarding workflow contract', () => {
  const workflow = readFileSync(join(root, '.github/workflows/live-gcs-onboarding.yml'), 'utf8');

  it('fails before keyless auth when required live configuration is missing', () => {
    const preflightStart = workflow.indexOf('- name: Validate live GCS configuration');
    const authStart = workflow.indexOf('- name: Authenticate to Google Cloud');
    expect(preflightStart).toBeGreaterThan(0);
    expect(authStart).toBeGreaterThan(preflightStart);

    const preflight = workflow.slice(preflightStart, authStart);
    for (const name of [
      'GCP_WORKLOAD_IDENTITY_PROVIDER',
      'GCP_SERVICE_ACCOUNT',
      'GCP_PROJECT_ID',
      'GCP_LIVE_CONNECTOR_RESOURCE_IDS_JSON',
      'POSTMAN_E2E_API_KEY_NON_ORG_MODE'
    ]) {
      expect(preflight).toContain(`${name}: \${{`);
      expect(preflight).toContain(name);
    }
    expect(preflight).toContain('if [ -z "${!name:-}" ]');
    expect(preflight).toContain('missing+=("$name")');
    expect(preflight).toContain('Missing required live configuration:');
    expect(preflight).not.toContain('${!name}');
  });

  it('authenticates only through WIF with an explicit project ID', () => {
    const authStart = workflow.indexOf('- name: Authenticate to Google Cloud');
    const authEnd = workflow.indexOf('\n      - name:', authStart + 1);
    const authStep = workflow.slice(authStart, authEnd);

    expect(authStep).toContain('uses: google-github-actions/auth@v3');
    expect(authStep).toContain('workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}');
    expect(authStep).toContain('service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}');
    expect(authStep).toContain('project_id: ${{ secrets.GCP_PROJECT_ID }}');
    expect(workflow).not.toContain('credentials_json:');
  });

  it('isolates the checked-in validation fixture before released cloud discovery', () => {
    const isolateStart = workflow.indexOf('- name: Isolate cloud discovery from validation fixture');
    const discoverStart = workflow.indexOf('- name: Discover custom connector spec (released pin)');
    expect(isolateStart).toBeGreaterThan(0);
    expect(discoverStart).toBeGreaterThan(isolateStart);

    const isolateStep = workflow.slice(isolateStart, discoverStart);
    expect(isolateStep).toContain(
      'mv validation/fixtures/gcp/openapi.yaml "$RUNNER_TEMP/live-gcs-openapi.yaml"'
    );
  });

  it('pins immutable discovery release, env-safe shell binding, always cleanup, artifact path, and required vars/secret', () => {
    expect(workflow).toContain('uses: postman-cs/postman-gcp-spec-discovery-action@v1.1.6');
    expect(workflow).toContain("refs/tags/v1.1.6^{}");
    // Runtime-observed peeled SHA only — no hardcoded expected commit in workflow.
    expect(workflow).not.toMatch(/EXPECTED_PEELED_SHA:\s*[0-9a-f]{40}/);
    expect(workflow).toContain('id: release_identity');
    expect(workflow).toContain('echo "release_commit=${peeled}" >> "$GITHUB_OUTPUT"');

    expect(workflow).toContain('uses: postman-cs/postman-api-onboarding-action@v2');
    expect(workflow).toContain('repo-write-mode: none');
    expect(workflow).toContain('project-name: live-gcs-onboarding-${{ github.run_id }}-${{ github.run_attempt }}');

    const verifyStep = workflow.slice(workflow.indexOf('- name: Verify resource state and cleanup'));
    expect(verifyStep).toContain('if: always()');
    expect(verifyStep).toMatch(/RESOLUTION_STATUS:\s*\$\{\{\s*steps\.discover\.outputs\.resolution-status\s*\}\}/);
    expect(verifyStep).toMatch(/PROVIDER_TYPE:\s*\$\{\{\s*steps\.discover\.outputs\.provider-type\s*\}\}/);
    expect(verifyStep).toMatch(/SOURCE_TYPE:\s*\$\{\{\s*steps\.discover\.outputs\.source-type\s*\}\}/);
    expect(verifyStep).toMatch(/SPEC_PATH:\s*\$\{\{\s*steps\.discover\.outputs\.spec-path\s*\}\}/);
    expect(verifyStep).toMatch(/RELEASE_TAG:\s*v1\.1\.6/);
    expect(verifyStep).toMatch(
      /RELEASE_COMMIT:\s*\$\{\{\s*steps\.release_identity\.outputs\.release_commit\s*\}\}/
    );
    expect(verifyStep).toMatch(/WORKSPACE_UID:\s*\$\{\{\s*steps\.onboard\.outputs\.workspace-id\s*\}\}/);
    expect(verifyStep).toMatch(/POSTMAN_API_KEY:\s*\$\{\{\s*secrets\.POSTMAN_E2E_API_KEY_NON_ORG_MODE\s*\}\}/);
    expect(verifyStep).toContain('node validation/scripts/verify-live-gcs-onboarding.mjs');
    const verifyRun = verifyStep.match(/run: \|([\s\S]*?)(?=\n {6}- |\n?$)/)?.[1] ?? '';
    expect(verifyRun.length).toBeGreaterThan(0);
    expect(verifyRun).not.toMatch(/\$\{\{\s*secrets\./);
    expect(verifyRun).not.toMatch(/\$\{\{\s*steps\.[^}]+\.outputs\./);

    expect(workflow).toContain('name: Upload GCS onboarding receipt');
    expect(workflow).toMatch(/Upload GCS onboarding receipt[\s\S]*if: always\(\)/);
    expect(workflow).toContain('path: validation/.live-runs/gcs-onboarding-receipt.json');
    expect(workflow).toContain('name: gcs-onboarding-receipt-${{ github.run_id }}-${{ github.run_attempt }}');

    expect(workflow).toMatch(/Enforce verifier exit[\s\S]*if: always\(\)/);
    expect(workflow).toContain('exit "${VERIFY_EXIT:-1}"');

    expect(workflow).toContain('secrets.GCP_WORKLOAD_IDENTITY_PROVIDER');
    expect(workflow).toContain('secrets.GCP_SERVICE_ACCOUNT');
    expect(workflow).toContain('secrets.GCP_PROJECT_ID');
    expect(workflow).toContain('secrets.GCP_LIVE_CONNECTOR_RESOURCE_IDS_JSON');
    expect(workflow).toContain('secrets.POSTMAN_E2E_API_KEY_NON_ORG_MODE');

    expect(workflow).toContain('expected-api-ids-json: ${{ secrets.GCP_LIVE_CONNECTOR_RESOURCE_IDS_JSON }}');
    expect(workflow).not.toContain('api-id:');
    expect(workflow).not.toContain('vars.GCP_');
    expect(workflow).toContain("on:\n  workflow_dispatch: {}");
    expect(workflow).not.toContain('pull_request');
  });
});
