import { describe, expect, it, vi } from 'vitest';

import { ApiHubProvider, parseApiHubSpecName } from '../src/lib/providers/api-hub.js';
import type { ApiHubSpecSummary, GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: Hub\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const SPEC_NAME = 'projects/sample-project-123/locations/us-central1/apis/payments/versions/v1/specs/openapi';

function spec(overrides: Partial<ApiHubSpecSummary> = {}): ApiHubSpecSummary {
  return {
    name: SPEC_NAME,
    displayName: 'payments-openapi',
    apiDisplayName: 'payments',
    specTypeIds: ['openapi'],
    attributes: {},
    createTime: '2026-07-01T00:00:00Z',
    ...overrides
  };
}

function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({
    probeApiHub: vi.fn(),
    listApiHubSpecs: vi.fn(async () => [spec()]),
    getApiHubSpec: vi.fn(async () => spec()),
    getApiHubSpecContents: vi.fn(async () => ({ contents: Buffer.from(OAS).toString('base64'), mimeType: 'application/yaml' })),
    ...overrides
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('API Hub provider', () => {
  it('GCP-APIHUB-001: parses spec resource names strictly', () => {
    expect(parseApiHubSpecName(SPEC_NAME)).toEqual({
      projectId: 'sample-project-123',
      location: 'us-central1',
      apiName: 'payments',
      versionId: 'v1',
      specId: 'openapi'
    });
    expect(parseApiHubSpecName('projects/p/locations/l/apis/a/configs/c')).toBeUndefined();
    expect(parseApiHubSpecName('organizations/o/apis/a/revisions/1')).toBeUndefined();
  });

  it('GCP-APIHUB-002: probes available and maps IAM failure to skipped:iam', async () => {
    await expect(new ApiHubProvider(client(), { projectId: 'sample-project-123' }).probe()).resolves.toBe('available');
    await expect(
      new ApiHubProvider(client({ probeApiHub: vi.fn(async () => { throw new Error('HTTP 403'); }) }), { projectId: 'sample-project-123' }).probe()
    ).resolves.toBe('skipped:iam');
  });

  it('GCP-APIHUB-003: lists OpenAPI-typed specs as supported and exports verbatim contents', async () => {
    const provider = new ApiHubProvider(client(), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: SPEC_NAME, providerType: 'api-hub', supported: true, apiId: SPEC_NAME });
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml', filename: 'index.yaml' });
  });

  it('GCP-APIHUB-004: non-OpenAPI spec types are unsupported candidates, not dropped', async () => {
    const provider = new ApiHubProvider(client({ listApiHubSpecs: vi.fn(async () => [spec({ specTypeIds: ['wsdl'] })]) }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ supported: false });
    expect(candidates[0]!.evidence.join(' ')).toContain('Only OpenAPI-typed API Hub specs');
  });

  it('GCP-APIHUB-005: explicit api-id must belong to the configured project', async () => {
    const foreign = 'projects/other-project/locations/us-central1/apis/payments/versions/v1/specs/openapi';
    const provider = new ApiHubProvider(client(), { projectId: 'sample-project-123', apiId: foreign });
    await expect(provider.listCandidates()).rejects.toThrow('api-id must belong to the configured project-id API Hub instance');
  });

  it('GCP-APIHUB-006: falls back to the registered Cloud Storage source when contents are empty', async () => {
    const getStorageObjectText = vi.fn(async () => OAS);
    const provider = new ApiHubProvider(client({
      listApiHubSpecs: vi.fn(async () => [spec({ sourceUri: 'gs://spec-bucket/apis/openapi.yaml' })]),
      getApiHubSpecContents: vi.fn(async () => ({})),
      getStorageObjectText
    }), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    const exported = await provider.exportSpec(candidate);
    expect(getStorageObjectText).toHaveBeenCalledWith('spec-bucket', 'apis/openapi.yaml');
    expect(exported).toMatchObject({ content: OAS, format: 'openapi-yaml' });
    expect(exported.evidence.join(' ')).toContain('Cloud Storage');
  });
});
