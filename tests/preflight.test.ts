import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';
import type { SpecProvider } from '../src/lib/providers/types.js';
import { execute, resolveInputs } from '../src/runtime.js';

function fakeClient(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return {
    preflightProject: vi.fn(),
    probeApiGateway: vi.fn(),
    listApiGatewayApis: vi.fn(async () => []),
    listApiGatewayConfigs: vi.fn(async () => []),
    getApiGatewayConfig: vi.fn(async () => ({ name: '', labels: {}, openapiDocuments: [], grpcServices: [], managedServiceConfigs: [] })),
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
    listVertexLocations: vi.fn(async () => ['us-central1']),
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
    getStorageObjectText: vi.fn(async () => ''),
    ...overrides
  };
}

function reporter() {
  return {
    group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
    info: vi.fn(),
    warning: vi.fn()
  };
}

describe('GCP preflight and probes', () => {
  it('GCP-CLIENT-001: explicit project preflight is fatal and happens before provider enumeration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gcp-preflight-'));
    try {
      const preflightProject = vi.fn(async () => { throw new Error('project lookup failed with HTTP 403'); });
      const listCandidates = vi.fn(async () => []);
      const provider: SpecProvider = {
        type: 'api-gateway',
        probe: vi.fn(async () => 'available' as const),
        listCandidates,
        exportSpec: vi.fn()
      };
      const inputs = resolveInputs({ INPUT_PROJECT_ID: 'sample-project-123', INPUT_REPO_ROOT: root });
      await expect(execute(inputs, {
        core: reporter(),
        client: fakeClient({ preflightProject }),
        providers: [provider],
        writeSpecFile: vi.fn()
      })).rejects.toThrow('HTTP 403');
      expect(preflightProject).toHaveBeenCalledWith('sample-project-123');
      expect(listCandidates).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('GCP-CLIENT-004: mixed IAM/error/success probes are ordered and fail soft', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gcp-probes-'));
    try {
      const client = fakeClient({
        probeApiGateway: vi.fn(async () => { throw new Error('Permission denied with HTTP 403'); }),
        probeCloudEndpoints: vi.fn(async () => { throw new Error('service unavailable'); }),
        probeAgentEngines: vi.fn(async () => { throw new Error('service unavailable'); })
      });
      const result = await execute(
        resolveInputs({ INPUT_PROJECT_ID: 'sample-project-123', INPUT_REPO_ROOT: root }),
        { core: reporter(), client, writeSpecFile: vi.fn() }
      );
      expect(result.resolution?.providerProbes).toEqual([
        { provider: 'api-gateway', status: 'skipped:iam' },
        { provider: 'cloud-endpoints', status: 'skipped:error' },
        { provider: 'apigee', status: 'available' },
        { provider: 'api-hub', status: 'available' },
        { provider: 'apigee-registry', status: 'available' },
        { provider: 'app-integration', status: 'available' },
        { provider: 'connectors-custom', status: 'available' },
        { provider: 'apigee-portal', status: 'available' },
        { provider: 'vertex-extensions', status: 'available' },
        { provider: 'agent-engines', status: 'skipped:error' },
        { provider: 'dialogflow-tools', status: 'available' },
        { provider: 'ces-toolsets', status: 'available' },
        { provider: 'iac-local', status: 'available' }
      ]);
      expect(result.outputs['resolution-status']).toBe('unresolved');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
