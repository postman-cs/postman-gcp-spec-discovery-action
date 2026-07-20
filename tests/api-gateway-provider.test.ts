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
    const grpc = new ApiGatewayProvider(
      fakeClient(fullConfig({ openapiDocuments: [], grpcServices: [{ source: [] }] })),
      { projectId: 'sample-project-123', location: 'global' }
    );
    expect((await grpc.listCandidates())[0]?.supported).toBe(false);
    expect((await grpc.listCandidates())[0]?.evidence.join(' ')).toMatch(/protobuf|No protobuf|descriptor/i);
  });

  it('GCP-GATEWAY-002: FULL export decodes and preserves original JSON/YAML bytes and format', async () => {
    for (const [text, expected] of [[VALID_JSON, 'openapi-json'], [VALID_YAML, 'openapi-yaml']] as const) {
      const config = fullConfig({ openapiDocuments: [{ document: { path: `openapi.${expected === 'openapi-json' ? 'json' : 'yaml'}`, contents: Buffer.from(text).toString('base64') } }] });
      const provider = new ApiGatewayProvider(fakeClient(config), { projectId: 'sample-project-123', location: 'global' });
      const candidate = (await provider.listCandidates())[0]!;
      const exported = await provider.exportSpec(candidate);
      expect(exported.format).toBe(expected);
      expect(exported.content).toBe(text);
    }
  });

  it('GCP-GATEWAY-003: malformed, oversize, invalid, zero/multiple, and gRPC sources do not export', async () => {
    const variants = [
      fullConfig({ openapiDocuments: [{ document: { contents: 'not base64!' } }] }),
      fullConfig({ openapiDocuments: [{ document: { contents: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') } }] }),
      fullConfig({ openapiDocuments: [{ document: { contents: Buffer.from('{}').toString('base64') } }] }),
      fullConfig({ openapiDocuments: [] }),
      fullConfig({ openapiDocuments: [{ document: { contents: Buffer.from(VALID_JSON).toString('base64') } }, { document: { contents: Buffer.from(VALID_JSON).toString('base64') } }] }),
      fullConfig({ openapiDocuments: [], grpcServices: [{ source: [] }] })
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
      fullConfig({ state: 'FAILED', openapiDocuments: [], grpcServices: [{ source: [] }] })
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

  it('GCP-GATEWAY-008: one broken FULL export does not hide healthy configs during automatic discovery', async () => {
    const client = fakeClient();
    const healthy = fullConfig();
    const broken = fullConfig({ name: 'projects/sample-project-123/locations/global/apis/payments/configs/broken' });
    client.listApiGatewayConfigs = vi.fn(async () => [
      { ...broken, openapiDocuments: [], grpcServices: [], managedServiceConfigs: [] },
      { ...healthy, openapiDocuments: [], grpcServices: [], managedServiceConfigs: [] }
    ]);
    client.getApiGatewayConfig = vi.fn(async (name) => {
      if (name === broken.name) throw new Error('FAILED_PRECONDITION');
      return healthy;
    });

    const candidates = await new ApiGatewayProvider(client, {
      projectId: 'sample-project-123',
      location: 'global'
    }).listCandidates();

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      id: broken.name,
      supported: false,
      authority: 'metadata-only'
    });
    expect(candidates[0]?.evidence).toContain('API Gateway FULL source export is unavailable; retained for manual review');
    expect(candidates[1]).toMatchObject({
      id: healthy.name,
      supported: true,
      authority: 'stored-authoritative'
    });
  });

  it('GCP-GATEWAY-009: single service/rpc protobuf source exports exact bytes as service.proto', async () => {
    const proto = 'syntax = "proto3";\n\nservice Payments {\n  rpc Get(GetReq) returns (GetRes);\n}\nmessage GetReq { string id = 1; }\nmessage GetRes { string id = 1; }\n';
    const config = fullConfig({
      openapiDocuments: [],
      grpcServices: [
        {
          source: [{ path: 'payments/v1/api.proto', contents: Buffer.from(proto).toString('base64') }]
        }
      ],
      managedServiceConfigs: [{ path: 'service.yaml', contents: Buffer.from('type: google.api.Service\n').toString('base64') }]
    });
    const provider = new ApiGatewayProvider(fakeClient(config), {
      projectId: 'sample-project-123',
      location: 'global'
    });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({
      id: config.name,
      supported: true,
      authority: 'stored-authoritative',
      meta: expect.objectContaining({
        exportFamily: 'protobuf',
        originalProtoPath: 'payments/v1/api.proto'
      })
    });
    const exported = await provider.exportSpec(candidate);
    expect(exported).toEqual({
      content: proto,
      format: 'protobuf',
      filename: 'service.proto',
      evidence: expect.arrayContaining([
        'Exported original API Gateway protobuf source payments/v1/api.proto'
      ])
    });
  });

  it('GCP-GATEWAY-010: descriptor-only / message-only / multi-entrypoint / imported protobuf stay unsupported', async () => {
    const service = 'syntax = "proto3";\nservice A { rpc X(M) returns (M); }\nmessage M { string id = 1; }\n';
    const variants = [
      fullConfig({
        openapiDocuments: [],
        grpcServices: [{ fileDescriptorSet: { path: 'api.pb', contents: Buffer.from([1, 2, 3]).toString('base64') }, source: [] }]
      }),
      fullConfig({
        openapiDocuments: [],
        grpcServices: [{ source: [{ path: 'types.proto', contents: Buffer.from('syntax = "proto3";\nmessage M {}\n').toString('base64') }] }]
      }),
      fullConfig({
        openapiDocuments: [],
        grpcServices: [{
          source: [
            { path: 'a.proto', contents: Buffer.from(service).toString('base64') },
            { path: 'b.proto', contents: Buffer.from(service.replace('service A', 'service B')).toString('base64') }
          ]
        }]
      }),
      fullConfig({
        openapiDocuments: [],
        grpcServices: [{
          source: [
            {
              path: 'service.proto',
              contents: Buffer.from(`syntax = "proto3";\nimport "types.proto";\n${service}`).toString('base64')
            },
            { path: 'types.proto', contents: Buffer.from('syntax = "proto3";\nmessage T {}\n').toString('base64') }
          ]
        }]
      })
    ];
    for (const config of variants) {
      const provider = new ApiGatewayProvider(fakeClient(config), {
        projectId: 'sample-project-123',
        location: 'global'
      });
      const candidate = (await provider.listCandidates())[0]!;
      expect(candidate.supported).toBe(false);
      await expect(provider.exportSpec(candidate)).rejects.toThrow();
    }
  });

  it('GCP-GATEWAY-011: OpenAPI remains authoritative and protobuf variant uses a distinct #protobuf id', async () => {
    const proto = 'syntax = "proto3";\nservice Payments { rpc Get(M) returns (M); }\nmessage M { string id = 1; }\n';
    const config = fullConfig({
      grpcServices: [{ source: [{ path: 'api.proto', contents: Buffer.from(proto).toString('base64') }] }]
    });
    const provider = new ApiGatewayProvider(fakeClient(config), {
      projectId: 'sample-project-123',
      location: 'global'
    });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      id: config.name,
      supported: true,
      meta: { exportFamily: 'openapi' }
    });
    expect(candidates[1]).toMatchObject({
      id: `${config.name}#protobuf`,
      supported: true,
      meta: { exportFamily: 'protobuf' }
    });
    const openapi = await provider.exportSpec(candidates[0]!);
    const protobuf = await provider.exportSpec(candidates[1]!);
    expect(openapi.format).toBe('openapi-json');
    expect(openapi.filename).toBe('index.json');
    expect(protobuf.format).toBe('protobuf');
    expect(protobuf.filename).toBe('service.proto');
    expect(protobuf.content).toBe(proto);
  });
});
