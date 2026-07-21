import { describe, expect, it, vi } from 'vitest';

import { CloudEndpointsProvider } from '../src/lib/providers/cloud-endpoints.js';
import type { EndpointServiceConfig, GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const VALID = 'swagger: "2.0"\ninfo:\n  title: Endpoints\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';

function config(overrides: Partial<EndpointServiceConfig> = {}): EndpointServiceConfig {
  return {
    id: '2026-07-18r0',
    name: 'payments.endpoints.sample-project-123.cloud.goog',
    title: 'payments',
    producerProjectId: 'sample-project-123',
    sourceInfo: { sourceFiles: [{ fileType: 'OPEN_API_YAML', filePath: 'openapi.yaml', fileContents: Buffer.from(VALID).toString('base64') }] },
    ...overrides
  };
}

function fakeClient(value = config()): GcpDiscoveryClient {
  return {
    preflightProject: vi.fn(),
    probeApiGateway: vi.fn(),
    listApiGatewayApis: vi.fn(async () => []),
    listApiGatewayConfigs: vi.fn(async () => []),
    getApiGatewayConfig: vi.fn(async () => ({ name: '', labels: {}, openapiDocuments: [], grpcServices: [], managedServiceConfigs: [] })),
    probeAgentEngines: vi.fn(),
    listAgentEngines: vi.fn(async () => []),
    probeCloudEndpoints: vi.fn(),
    listManagedServices: vi.fn(async () => [{ serviceName: 'payments.endpoints.sample-project-123.cloud.goog', producerProjectId: 'sample-project-123' }]),
    listEndpointConfigs: vi.fn(async () => [{ id: value.id }, { id: 'older' }]),
    getEndpointConfig: vi.fn(async () => value)
    ,probeApigee: vi.fn(),
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

describe('Cloud Endpoints provider', () => {
  it('GCP-ENDPOINTS-001: automatic discovery keeps newest config per exact producer service', async () => {
    const client = fakeClient();
    const provider = new CloudEndpointsProvider(client, { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toEqual([
      expect.objectContaining({
        id: 'services/payments.endpoints.sample-project-123.cloud.goog/configs/2026-07-18r0',
        providerType: 'cloud-endpoints',
        supported: true,
        authority: 'stored-authoritative'
      })
    ]);
    expect(client.getEndpointConfig).toHaveBeenCalledWith('payments.endpoints.sample-project-123.cloud.goog', '2026-07-18r0');
    expect(client.getEndpointConfig).not.toHaveBeenCalledWith(expect.anything(), 'older');
  });

  it('GCP-ENDPOINTS-002: FULL sourceInfo exports and preserves the original source', async () => {
    const provider = new CloudEndpointsProvider(fakeClient(), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    const exported = await provider.exportSpec(candidate);
    expect(exported).toMatchObject({ format: 'openapi-yaml', filename: 'index.yaml' });
    expect(exported.content).toBe(VALID);
  });

  it('GCP-ENDPOINTS-003: absent/multiple/foreign/invalid sourceInfo is never guessed', async () => {
    const variants = [
      config({ sourceInfo: undefined }),
      config({ sourceInfo: { sourceFiles: [
        { fileType: 'OPEN_API_YAML', fileContents: Buffer.from(VALID).toString('base64') },
        { fileType: 'OPEN_API_JSON', fileContents: Buffer.from('{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{"/x":{}}}').toString('base64') }
      ] } }),
      config({ sourceInfo: { sourceFiles: [{ fileType: 'OPEN_API_YAML', fileContents: 'not base64!' }] } }),
      config({ producerProjectId: 'foreign-project-123' })
    ];
    for (const value of variants) {
      const provider = new CloudEndpointsProvider(fakeClient(value), { projectId: 'sample-project-123' });
      const candidates = await provider.listCandidates().catch(() => []);
      if (candidates[0]) await expect(provider.exportSpec(candidates[0])).rejects.toThrow();
      else expect(value.producerProjectId).toBe('foreign-project-123');
    }
  });

  it('GCP-ENDPOINTS-004: exact older config resolves directly and bypasses list calls', async () => {
    const client = fakeClient(config({ id: 'older' }));
    const id = 'services/payments.endpoints.sample-project-123.cloud.goog/configs/older';
    const provider = new CloudEndpointsProvider(client, { projectId: 'sample-project-123', apiId: id });
    await expect(provider.listCandidates()).resolves.toEqual([expect.objectContaining({ id })]);
    expect(client.listManagedServices).not.toHaveBeenCalled();
    expect(client.listEndpointConfigs).not.toHaveBeenCalled();
  });

  it('GCP-ENDPOINTS-005: single PROTO_FILE service entrypoint exports exact bytes as service.proto', async () => {
    const proto = 'syntax = "proto3";\r\nservice Payments {\r\n  rpc Get(M) returns (M);\r\n}\r\nmessage M { string id = 1; }\r\n';
    const value = config({
      sourceInfo: {
        sourceFiles: [
          {
            '@type': 'type.googleapis.com/google.api.servicemanagement.v1.ConfigFile',
            fileType: 'PROTO_FILE',
            filePath: 'payments/api.proto',
            fileContents: Buffer.from(proto).toString('base64')
          },
          {
            fileType: 'FILE_DESCRIPTOR_SET_PROTO',
            filePath: 'api.pb',
            fileContents: Buffer.from([0x0a]).toString('base64')
          },
          {
            fileType: 'SERVICE_CONFIG_YAML',
            filePath: 'service.yaml',
            fileContents: Buffer.from('type: google.api.Service\n').toString('base64')
          }
        ]
      }
    });
    const provider = new CloudEndpointsProvider(fakeClient(value), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({
      supported: true,
      authority: 'stored-authoritative',
      meta: { exportFamily: 'protobuf', originalProtoPath: 'payments/api.proto' }
    });
    const exported = await provider.exportSpec(candidate);
    expect(exported.format).toBe('protobuf');
    expect(exported.filename).toBe('service.proto');
    expect(exported.content).toBe(proto);
  });

  it('GCP-ENDPOINTS-006: descriptor-only / message-only / multi-entrypoint / missing-import PROTO_FILE stay unsupported', async () => {
    const service = 'syntax = "proto3";\nservice A { rpc X(M) returns (M); }\nmessage M { string id = 1; }\n';
    const variants = [
      config({
        sourceInfo: {
          sourceFiles: [
            {
              fileType: 'FILE_DESCRIPTOR_SET_PROTO',
              filePath: 'api.pb',
              fileContents: Buffer.from([1]).toString('base64')
            }
          ]
        }
      }),
      config({
        sourceInfo: {
          sourceFiles: [
            {
              fileType: 'PROTO_FILE',
              filePath: 'types.proto',
              fileContents: Buffer.from('syntax = "proto3";\nmessage M {}\n').toString('base64')
            }
          ]
        }
      }),
      config({
        sourceInfo: {
          sourceFiles: [
            { fileType: 'PROTO_FILE', filePath: 'a.proto', fileContents: Buffer.from(service).toString('base64') },
            {
              fileType: 'PROTO_FILE',
              filePath: 'b.proto',
              fileContents: Buffer.from(service.replace('service A', 'service B')).toString('base64')
            }
          ]
        }
      }),
      config({
        sourceInfo: {
          sourceFiles: [
            {
              fileType: 'PROTO_FILE',
              filePath: 'service.proto',
              fileContents: Buffer.from(`syntax = "proto3";\nimport "missing.proto";\n${service}`).toString('base64')
            }
          ]
        }
      })
    ];
    for (const value of variants) {
      const provider = new CloudEndpointsProvider(fakeClient(value), { projectId: 'sample-project-123' });
      const candidate = (await provider.listCandidates())[0]!;
      expect(candidate.supported).toBe(false);
      await expect(provider.exportSpec(candidate)).rejects.toThrow();
    }
  });

  it('GCP-ENDPOINTS-008: exports a complete sibling-import PROTO_FILE set with exact member artifacts', async () => {
    const types = 'syntax = "proto3";\nmessage Money { int64 units = 1; }\n';
    const root = 'syntax = "proto3";\nimport "types.proto";\nservice Payments { rpc Get(M) returns (M); }\nmessage M { string id = 1; }\n';
    const value = config({
      sourceInfo: {
        sourceFiles: [
          {
            fileType: 'PROTO_FILE',
            filePath: 'service.proto',
            fileContents: Buffer.from(root).toString('base64')
          },
          {
            fileType: 'PROTO_FILE',
            filePath: 'types.proto',
            fileContents: Buffer.from(types).toString('base64')
          }
        ]
      }
    });
    const provider = new CloudEndpointsProvider(fakeClient(value), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate.supported).toBe(true);
    const exported = await provider.exportSpec(candidate);
    expect(exported).toMatchObject({
      format: 'protobuf',
      filename: 'service.proto',
      completeness: 'full',
      rootPath: 'service.proto',
      content: root
    });
    expect(exported.artifacts).toEqual([
      { path: 'service.proto', role: 'root', content: root, originalPath: 'service.proto' },
      { path: 'types.proto', role: 'dependency', content: types, originalPath: 'types.proto' }
    ]);
  });

  it('GCP-ENDPOINTS-007: OpenAPI + PROTO_FILE emits distinct candidates without overwrite', async () => {
    const proto = 'syntax = "proto3";\nservice Payments { rpc Get(M) returns (M); }\nmessage M { string id = 1; }\n';
    const value = config({
      sourceInfo: {
        sourceFiles: [
          {
            fileType: 'OPEN_API_YAML',
            filePath: 'openapi.yaml',
            fileContents: Buffer.from(VALID).toString('base64')
          },
          {
            fileType: 'PROTO_FILE',
            filePath: 'api.proto',
            fileContents: Buffer.from(proto).toString('base64')
          }
        ]
      }
    });
    const provider = new CloudEndpointsProvider(fakeClient(value), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      id: 'services/payments.endpoints.sample-project-123.cloud.goog/configs/2026-07-18r0',
      supported: true,
      meta: { exportFamily: 'openapi' }
    });
    expect(candidates[1]).toMatchObject({
      id: 'services/payments.endpoints.sample-project-123.cloud.goog/configs/2026-07-18r0#protobuf',
      supported: true,
      meta: { exportFamily: 'protobuf' }
    });
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({
      format: 'openapi-yaml',
      filename: 'index.yaml',
      content: VALID
    });
    await expect(provider.exportSpec(candidates[1]!)).resolves.toMatchObject({
      format: 'protobuf',
      filename: 'service.proto',
      content: proto
    });
  });
});
