import { describe, expect, it, vi } from 'vitest';

import { ApiHubProvider, parseApiHubAdditionalSpecName, parseApiHubSpecName } from '../src/lib/providers/api-hub.js';
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
    additionalSpecContentTypes: [],
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
    expect(parseApiHubAdditionalSpecName(`${SPEC_NAME}#BOOSTED_SPEC_CONTENT`)).toEqual({
      projectId: 'sample-project-123',
      location: 'us-central1',
      apiName: 'payments',
      versionId: 'v1',
      specId: 'openapi',
      specName: SPEC_NAME,
      contentType: 'BOOSTED_SPEC_CONTENT'
    });
    expect(parseApiHubAdditionalSpecName(SPEC_NAME)).toBeUndefined();
    expect(parseApiHubAdditionalSpecName(`${SPEC_NAME}#OTHER`)).toBeUndefined();
    const encoded = 'projects/sample-project-123/locations/us-central1/apis/payments%2Fv2/versions/v1/specs/openapi%20spec';
    expect(parseApiHubSpecName(encoded)).toMatchObject({
      projectId: 'sample-project-123',
      location: 'us-central1',
      apiName: 'payments%2Fv2',
      specId: 'openapi%20spec'
    });
    expect(parseApiHubAdditionalSpecName(`${encoded}#GATEWAY_OPEN_API_SPEC`)).toMatchObject({
      specName: encoded,
      contentType: 'GATEWAY_OPEN_API_SPEC'
    });
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
    expect(candidates[0]).toMatchObject({
      id: SPEC_NAME,
      providerType: 'api-hub',
      supported: true,
      apiId: SPEC_NAME,
      authority: 'stored-authoritative'
    });
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml', filename: 'index.yaml' });
  });

  it('GCP-APIHUB-004: non-OpenAPI spec types are unsupported candidates, not dropped', async () => {
    const provider = new ApiHubProvider(client({ listApiHubSpecs: vi.fn(async () => [spec({ specTypeIds: ['wsdl'] })]) }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ supported: false, authority: 'unsupported-format' });
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

  it('GCP-APIHUB-007: emits distinct google-generated additional content candidates after stored original', async () => {
    const boosted = 'openapi: 3.0.3\ninfo:\n  title: Boosted\n  version: "1"\npaths:\n  /boosted:\n    get:\n      responses:\n        "200":\n          description: ok\n';
    const gateway = 'openapi: 3.0.3\ninfo:\n  title: Gateway\n  version: "1"\npaths:\n  /gw:\n    get:\n      responses:\n        "200":\n          description: ok\n';
    const fetchAdditional = vi.fn(async (_name: string, type: string) => ({
      contents: Buffer.from(type === 'BOOSTED_SPEC_CONTENT' ? boosted : gateway).toString('base64'),
      mimeType: 'application/yaml'
    }));
    const provider = new ApiHubProvider(client({
      listApiHubSpecs: vi.fn(async () => [spec({
        additionalSpecContentTypes: ['BOOSTED_SPEC_CONTENT', 'GATEWAY_OPEN_API_SPEC']
      })]),
      getApiHubSpecContents: vi.fn(async () => ({ contents: Buffer.from(OAS).toString('base64') })),
      fetchApiHubAdditionalSpecContent: fetchAdditional
    }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates.map((candidate) => candidate.sourceType)).toEqual([
      'api-hub-spec',
      'api-hub-boosted-spec',
      'api-hub-gateway-openapi-spec'
    ]);
    expect(candidates[0]).toMatchObject({ authority: 'stored-authoritative', supported: true });
    expect(candidates[1]).toMatchObject({
      id: `${SPEC_NAME}#BOOSTED_SPEC_CONTENT`,
      authority: 'google-generated',
      supported: true
    });
    expect(candidates[2]).toMatchObject({
      id: `${SPEC_NAME}#GATEWAY_OPEN_API_SPEC`,
      authority: 'google-generated',
      supported: true
    });
    expect(fetchAdditional).toHaveBeenCalledWith(SPEC_NAME, 'BOOSTED_SPEC_CONTENT');
    expect(fetchAdditional).toHaveBeenCalledWith(SPEC_NAME, 'GATEWAY_OPEN_API_SPEC');
    await expect(provider.exportSpec(candidates[1]!)).resolves.toMatchObject({ content: boosted, format: 'openapi-yaml' });
  });

  it('GCP-APIHUB-009: explicit additional variant api-id selects only that candidate', async () => {
    const boosted = 'openapi: 3.0.3\ninfo:\n  title: Boosted\n  version: "1"\npaths:\n  /boosted:\n    get:\n      responses:\n        "200":\n          description: ok\n';
    const fetchAdditional = vi.fn(async () => ({
      contents: Buffer.from(boosted).toString('base64'),
      mimeType: 'application/yaml'
    }));
    const provider = new ApiHubProvider(client({
      getApiHubSpec: vi.fn(async () => spec({ additionalSpecContentTypes: ['BOOSTED_SPEC_CONTENT'] })),
      fetchApiHubAdditionalSpecContent: fetchAdditional
    }), { projectId: 'sample-project-123', apiId: `${SPEC_NAME}#BOOSTED_SPEC_CONTENT` });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: `${SPEC_NAME}#BOOSTED_SPEC_CONTENT`,
      sourceType: 'api-hub-boosted-spec',
      authority: 'google-generated',
      supported: true
    });
    expect(fetchAdditional).toHaveBeenCalledWith(SPEC_NAME, 'BOOSTED_SPEC_CONTENT');
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({ content: boosted });
  });

  it('ignores duplicate or invalid API Hub additional content', async () => {
    const originalB64 = Buffer.from(OAS).toString('base64');
    const invalidB64 = Buffer.from('not openapi').toString('base64');
    const provider = new ApiHubProvider(client({
      listApiHubSpecs: vi.fn(async () => [spec({
        additionalSpecContentTypes: ['BOOSTED_SPEC_CONTENT', 'GATEWAY_OPEN_API_SPEC']
      })]),
      getApiHubSpecContents: vi.fn(async () => ({ contents: originalB64 })),
      fetchApiHubAdditionalSpecContent: vi.fn(async (_name, type) => {
        if (type === 'BOOSTED_SPEC_CONTENT') return { contents: originalB64 };
        return { contents: invalidB64 };
      })
    }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates.map((candidate) => candidate.sourceType)).toEqual(['api-hub-spec', 'api-hub-gateway-openapi-spec']);
    expect(candidates[1]).toMatchObject({ supported: false, authority: 'unsupported-format' });
  });
});
