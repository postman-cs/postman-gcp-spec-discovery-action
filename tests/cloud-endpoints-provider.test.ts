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
    listApigeeEnvironmentOasFiles: vi.fn(async () => []),
    getApigeeEnvironmentOasFile: vi.fn(async () => ''),
    probeApiHub: vi.fn(),
    listApiHubSpecs: vi.fn(async () => []),
    getApiHubSpec: vi.fn(async () => ({ name: '', specTypeIds: [], attributes: {} })),
    getApiHubSpecContents: vi.fn(async () => ({})),
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
        supported: true
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
});
