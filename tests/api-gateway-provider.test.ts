import { describe, expect, it, vi } from 'vitest';

import { ApiGatewayProvider } from '../src/lib/providers/api-gateway.js';
import type { ApiGatewayConfig, GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const VALID_JSON = JSON.stringify({ openapi: '3.0.3', info: { title: 'Gateway', version: '1' }, paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } } });
const VALID_YAML = 'openapi: 3.0.3\ninfo:\n  title: Gateway\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';

function fullConfig(overrides: Partial<ApiGatewayConfig> = {}): ApiGatewayConfig {
  return {
    name: 'projects/sample-project-123/locations/global/apis/payments/configs/v1',
    displayName: 'payments-v1',
    labels: { 'postman-repo': 'postman--payments' },
    state: 'ACTIVE',
    openapiDocuments: [{ document: { path: 'openapi.json', contents: Buffer.from(VALID_JSON).toString('base64') } }],
    grpcServices: [],
    managedServiceConfigs: [],
    ...overrides
  };
}

function fakeClient(config = fullConfig()): GcpDiscoveryClient {
  return {
    preflightProject: vi.fn(),
    probeApiGateway: vi.fn(),
    listApiGatewayApis: vi.fn(async () => [{ name: 'projects/sample-project-123/locations/global/apis/payments', displayName: 'payments', labels: {}, state: 'ACTIVE' }]),
    listApiGatewayConfigs: vi.fn(async () => [{ ...config, openapiDocuments: [], grpcServices: [], managedServiceConfigs: [] }]),
    getApiGatewayConfig: vi.fn(async () => config),
    probeAgentEngines: vi.fn(),
    listAgentEngines: vi.fn(async () => []),
    probeCloudEndpoints: vi.fn(),
    listManagedServices: vi.fn(async () => []),
    listEndpointConfigs: vi.fn(async () => []),
    getEndpointConfig: vi.fn(async () => ({ id: '' })),
    probeApigee: vi.fn(),
    listApigeeProxies: vi.fn(async () => []),
    listApigeeRevisions: vi.fn(async () => []),
    downloadApigeeRevisionBundle: vi.fn(),
    listApigeeEnvironments: vi.fn(async () => []),
    probeApiHub: vi.fn(),
    listApiHubSpecs: vi.fn(async () => []),
    getApiHubSpec: vi.fn(async () => ({ name: '', specTypeIds: [], attributes: {}, additionalSpecContentTypes: [] })),
    getApiHubSpecContents: vi.fn(async () => ({})),
    fetchApiHubAdditionalSpecContent: vi.fn(async () => ({})),
    probeApigeeRegistry: vi.fn(),
    listApigeeRegistrySpecs: vi.fn(async () => []),
    getApigeeRegistrySpec: vi.fn(async () => ({ name: '', labels: {} })),
    getApigeeRegistrySpecContents: vi.fn(async () => ({ bytes: Buffer.alloc(0) })),
    listApigeeArchiveDeployments: vi.fn(async () => []),
    generateApigeeArchiveDeploymentDownloadUrl: vi.fn(async () => ''),
    downloadTrustedGcsSignedUrl: vi.fn(async () => Buffer.alloc(0)),
    probeApigeePortal: vi.fn(),
    listApigeePortalSites: vi.fn(async () => []),
    listApigeePortalApidocs: vi.fn(async () => []),
    getApigeePortalDocumentation: vi.fn(async () => ({ type: 'missing' as const })),
    probeVertexExtensions: vi.fn(),
    listVertexLocations: vi.fn(async () => []),
    listVertexExtensions: vi.fn(async () => []),
    probeDialogflow: vi.fn(),
    listDialogflowAgents: vi.fn(async () => []),
    listDialogflowTools: vi.fn(async () => []),
    probeCes: vi.fn(),
    listCesToolsets: vi.fn(async () => []),
    probeAppIntegration: vi.fn(),
    listAppIntegrationApiTriggers: vi.fn(async () => []),
    generateAppIntegrationOpenApiSpec: vi.fn(async () => ''),
    probeConnectors: vi.fn(),
    listCustomConnectorVersions: vi.fn(async () => []),
    listConnectorConnections: vi.fn(async () => []),
    getConnectorSchemaMetadata: vi.fn(async () => undefined),
    getStorageObjectText: vi.fn(async () => '')
  };
}

describe('API Gateway provider', () => {
  it('GCP-GATEWAY-001: lists stable candidates and classifies state/source shapes without dropping them', async () => {
    const client = fakeClient();
    const provider = new ApiGatewayProvider(client, { projectId: 'sample-project-123', location: 'global' });
    const candidates = await provider.listCandidates();
    expect(candidates).toEqual([
      expect.objectContaining({
        id: 'projects/sample-project-123/locations/global/apis/payments/configs/v1',
        providerType: 'api-gateway',
        supported: true,
        authority: 'stored-authoritative',
        tags: { 'postman-repo': 'postman--payments' }
      })
    ]);

    const inactive = new ApiGatewayProvider(fakeClient(fullConfig({ state: 'FAILED' })), { projectId: 'sample-project-123', location: 'global' });
    expect((await inactive.listCandidates())[0]).toMatchObject({ supported: false, authority: 'metadata-only' });
    const grpc = new ApiGatewayProvider(fakeClient(fullConfig({ openapiDocuments: [], grpcServices: [{}] })), { projectId: 'sample-project-123', location: 'global' });
    expect((await grpc.listCandidates())[0]?.evidence.join(' ')).toContain('no OpenAPI source document');
  });

  it('GCP-GATEWAY-002: FULL export decodes and preserves original JSON/YAML bytes and format', async () => {
    for (const [text, expected] of [[VALID_JSON, 'openapi-json'], [VALID_YAML, 'openapi-yaml']] as const) {
      const config = fullConfig({ openapiDocuments: [{ document: { path: `openapi.${expected === 'openapi-json' ? 'json' : 'yaml'}`, contents: Buffer.from(text).toString('base64') } }] });
      const provider = new ApiGatewayProvider(fakeClient(config), { projectId: 'sample-project-123', location: 'global' });
      const candidate = (await provider.listCandidates())[0]!;
      const exported = await provider.exportSpec(candidate);
      expect(exported.format).toBe(expected);
      expect(exported.content).toBe(`${text.replace(/(?:\r?\n)+$/, '')}\n`);
    }
  });

  it('GCP-GATEWAY-003: malformed, oversize, invalid, zero/multiple, and gRPC sources do not export', async () => {
    const variants = [
      fullConfig({ openapiDocuments: [{ document: { contents: 'not base64!' } }] }),
      fullConfig({ openapiDocuments: [{ document: { contents: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') } }] }),
      fullConfig({ openapiDocuments: [{ document: { contents: Buffer.from('{}').toString('base64') } }] }),
      fullConfig({ openapiDocuments: [] }),
      fullConfig({ openapiDocuments: [{ document: { contents: Buffer.from(VALID_JSON).toString('base64') } }, { document: { contents: Buffer.from(VALID_JSON).toString('base64') } }] }),
      fullConfig({ openapiDocuments: [], grpcServices: [{}] })
    ];
    for (const config of variants) {
      const provider = new ApiGatewayProvider(fakeClient(config), { projectId: 'sample-project-123', location: 'global' });
      const candidate = (await provider.listCandidates())[0]!;
      await expect(provider.exportSpec(candidate)).rejects.toThrow();
    }
  });

  it('GCP-GATEWAY-004: exact config ID bypasses API/config list calls', async () => {
    const client = fakeClient();
    const id = fullConfig().name;
    const provider = new ApiGatewayProvider(client, { projectId: 'sample-project-123', location: 'global', apiId: id });
    await expect(provider.listCandidates()).resolves.toHaveLength(1);
    expect(client.listApiGatewayApis).not.toHaveBeenCalled();
    expect(client.listApiGatewayConfigs).not.toHaveBeenCalled();
    expect(client.getApiGatewayConfig).toHaveBeenCalledWith(id);
  });

  it('GCP-GATEWAY-005: automatic discovery keeps inactive configs unsupported', async () => {
    const provider = new ApiGatewayProvider(fakeClient(fullConfig({ state: 'FAILED' })), {
      projectId: 'sample-project-123',
      location: 'global'
    });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({ supported: false, authority: 'metadata-only' });
    await expect(provider.exportSpec(candidate)).rejects.toThrow(/Only ACTIVE/);
  });

  it('GCP-GATEWAY-006: explicit full config api-id can export inactive config with one OpenAPI and no gRPC', async () => {
    const config = fullConfig({ state: 'FAILED' });
    const provider = new ApiGatewayProvider(fakeClient(config), {
      projectId: 'sample-project-123',
      location: 'global',
      apiId: config.name
    });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({
      supported: true,
      authority: 'stored-authoritative',
      apiId: config.name
    });
    expect(candidate.evidence.join(' ')).toContain('inactive/historical');
    await expect(provider.exportSpec(candidate)).resolves.toMatchObject({ format: 'openapi-json' });
  });

  it('GCP-GATEWAY-007: explicit inactive config with zero/multiple OpenAPI or gRPC stays unsupported', async () => {
    const id = fullConfig().name;
    for (const config of [
      fullConfig({ state: 'FAILED', openapiDocuments: [] }),
      fullConfig({
        state: 'FAILED',
        openapiDocuments: [
          { document: { contents: Buffer.from(VALID_JSON).toString('base64') } },
          { document: { contents: Buffer.from(VALID_JSON).toString('base64') } }
        ]
      }),
      fullConfig({ state: 'FAILED', openapiDocuments: [], grpcServices: [{}] })
    ]) {
      const provider = new ApiGatewayProvider(fakeClient(config), {
        projectId: 'sample-project-123',
        location: 'global',
        apiId: id
      });
      const candidate = (await provider.listCandidates())[0]!;
      expect(candidate.supported).toBe(false);
      await expect(provider.exportSpec(candidate)).rejects.toThrow();
    }
  });
});
