import { describe, expect, it, vi } from 'vitest';

import { ApigeeRegistryProvider, parseApigeeRegistrySpecName } from '../src/lib/providers/apigee-registry.js';
import type { ApigeeRegistrySpecSummary, GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: Legacy\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const SPEC_NAME = 'projects/sample-project-123/locations/us-west1/apis/payments/versions/v1/specs/openapi';

function spec(overrides: Partial<ApigeeRegistrySpecSummary> = {}): ApigeeRegistrySpecSummary {
  return {
    name: SPEC_NAME,
    filename: 'openapi.yaml',
    mimeType: 'application/vnd.apigee.openapi',
    labels: {},
    createTime: '2024-01-01T00:00:00Z',
    ...overrides
  };
}

function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({
    probeApigeeRegistry: vi.fn(),
    listApigeeRegistrySpecs: vi.fn(async () => [spec()]),
    getApigeeRegistrySpec: vi.fn(async () => spec()),
    getApigeeRegistrySpecContents: vi.fn(async () => ({
      bytes: Buffer.from(OAS),
      mimeType: 'application/vnd.apigee.openapi'
    })),
    ...overrides
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('legacy Apigee Registry provider', () => {
  it('GCP-REGISTRY-001: parses spec resource names strictly and confines project', () => {
    expect(parseApigeeRegistrySpecName(SPEC_NAME)).toEqual({
      projectId: 'sample-project-123',
      location: 'us-west1',
      apiName: 'payments',
      versionId: 'v1',
      specId: 'openapi'
    });
    expect(parseApigeeRegistrySpecName('organizations/o/apis/a/revisions/1')).toBeUndefined();
  });

  it('GCP-REGISTRY-002: probes available and maps IAM/disabled/404 fail-soft', async () => {
    await expect(new ApigeeRegistryProvider(client(), { projectId: 'sample-project-123' }).probe()).resolves.toBe('available');
    await expect(
      new ApigeeRegistryProvider(client({ probeApigeeRegistry: vi.fn(async () => { throw new Error('HTTP 403'); }) }), { projectId: 'sample-project-123' }).probe()
    ).resolves.toBe('skipped:iam');
    await expect(
      new ApigeeRegistryProvider(client({ probeApigeeRegistry: vi.fn(async () => { throw new Error('HTTP 404'); }) }), { projectId: 'sample-project-123' }).probe()
    ).resolves.toBe('skipped:error');
  });

  it('GCP-REGISTRY-003: lists OpenAPI mime specs as stored-authoritative and labels legacy', async () => {
    const provider = new ApigeeRegistryProvider(client(), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: SPEC_NAME,
      providerType: 'apigee-registry',
      sourceType: 'apigee-registry-spec',
      authority: 'stored-authoritative',
      supported: true
    });
    expect(candidates[0]!.evidence.join(' ')).toMatch(/legacy|no-longer-supported/i);
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml' });
  });

  it('GCP-REGISTRY-004: non-OpenAPI mime types are unsupported', async () => {
    const provider = new ApigeeRegistryProvider(client({
      listApigeeRegistrySpecs: vi.fn(async () => [spec({ mimeType: 'application/vnd.apigee.proto' })])
    }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates[0]).toMatchObject({ supported: false, authority: 'unsupported-format' });
  });

  it('GCP-REGISTRY-005: foreign project api-id is rejected before export', async () => {
    const foreign = 'projects/other-project/locations/us-west1/apis/payments/versions/v1/specs/openapi';
    await expect(
      new ApigeeRegistryProvider(client(), { projectId: 'sample-project-123', apiId: foreign }).listCandidates()
    ).rejects.toThrow('api-id must belong to the configured project-id Apigee Registry instance');
  });

  it('GCP-REGISTRY-006: explicit api-id bypasses list and uses getContents binary shape', async () => {
    const fake = client();
    const provider = new ApigeeRegistryProvider(fake, { projectId: 'sample-project-123', apiId: SPEC_NAME });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(fake.listApigeeRegistrySpecs).not.toHaveBeenCalled();
    expect(fake.getApigeeRegistrySpec).toHaveBeenCalledWith(SPEC_NAME);
    await provider.exportSpec(candidates[0]!);
    expect(fake.getApigeeRegistrySpecContents).toHaveBeenCalledWith(SPEC_NAME);
  });
});
