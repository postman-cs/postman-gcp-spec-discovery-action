import { describe, expect, it, vi } from 'vitest';

import { ConnectorsCustomProvider, parseGcsSpecLocation } from '../src/lib/providers/connectors-custom.js';
import type { CustomConnectorVersionSummary, GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const OAS = '{"openapi":"3.0.0","info":{"title":"Connector","version":"1"},"paths":{"/ping":{"get":{"responses":{"200":{"description":"ok"}}}}}}';

function version(overrides: Partial<CustomConnectorVersionSummary> = {}): CustomConnectorVersionSummary {
  return {
    name: 'projects/sample-project-123/locations/global/customConnectors/billing/customConnectorVersions/1',
    specLocation: 'gs://sample-bucket/specs/billing.json',
    labels: {},
    updateTime: '2026-07-01T00:00:00Z',
    ...overrides
  };
}

function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({
    probeConnectors: vi.fn(),
    listCustomConnectorVersions: vi.fn(async () => [version()]),
    getStorageObjectText: vi.fn(async () => OAS),
    ...overrides
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('Integration Connectors custom connector provider', () => {
  it('GCP-CONNECTORS-001: parses gs:// spec locations strictly', () => {
    expect(parseGcsSpecLocation('gs://sample-bucket/specs/billing.json')).toEqual({ bucket: 'sample-bucket', object: 'specs/billing.json' });
    expect(parseGcsSpecLocation('https://example.com/spec.json')).toBeUndefined();
    expect(parseGcsSpecLocation('gs://bad')).toBeUndefined();
  });

  it('GCP-CONNECTORS-002: probes available and maps non-IAM failure to skipped:error', async () => {
    await expect(new ConnectorsCustomProvider(client(), { projectId: 'sample-project-123' }).probe()).resolves.toBe('available');
    await expect(
      new ConnectorsCustomProvider(client({ probeConnectors: vi.fn(async () => { throw new Error('service unavailable'); }) }), { projectId: 'sample-project-123' }).probe()
    ).resolves.toBe('skipped:error');
  });

  it('GCP-CONNECTORS-003: fetches gs:// specLocation bytes through authenticated storage', async () => {
    const getObject = vi.fn(async () => OAS);
    const provider = new ConnectorsCustomProvider(client({ getStorageObjectText: getObject }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ providerType: 'connectors-custom', supported: true });
    expect(candidates[0]?.evidence.join(' ')).toContain('[gs-object]');
    expect(candidates[0]?.evidence.join(' ')).not.toContain('gs://');
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({ format: 'openapi-json', filename: 'index.json', evidence: ['Fetched custom connector source spec from [gs-object]'] });
    expect(getObject).toHaveBeenCalledWith('sample-bucket', 'specs/billing.json');
  });

  it('GCP-CONNECTORS-004: https specLocation stays a manual-review candidate and never fetches', async () => {
    const getObject = vi.fn(async () => OAS);
    const provider = new ConnectorsCustomProvider(
      client({
        listCustomConnectorVersions: vi.fn(async () => [version({ specLocation: 'https://example.com/spec.json' })]),
        getStorageObjectText: getObject
      }),
      { projectId: 'sample-project-123' }
    );
    const candidates = await provider.listCandidates();
    expect(candidates[0]).toMatchObject({ supported: false });
    await expect(provider.exportSpec(candidates[0]!)).rejects.toThrow('not a gs:// object');
    expect(getObject).not.toHaveBeenCalled();
  });
  it('generates OpenAPI from connection schema metadata and skips absent schemas', async () => {
    const provider = new ConnectorsCustomProvider(client({
      listCustomConnectorVersions: vi.fn(async () => []),
      listConnectorConnections: vi.fn(async () => [{ name: 'projects/sample-project-123/locations/us-central1/connections/salesforce' }, { name: 'projects/sample-project-123/locations/us-central1/connections/empty' }]),
      getConnectorSchemaMetadata: vi.fn(async (name) => name.endsWith('/empty') ? undefined : { entities: { Account: { fields: [{ name: 'id', dataType: 'STRING' }] } } })
    }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sourceType: 'connectors-generated-spec', supported: true });
    const exported = await provider.exportSpec(candidates[0]!);
    expect(exported.evidence.join(' ')).toContain('generated from connector schema metadata');
    expect(JSON.parse(exported.content)).toMatchObject({ openapi: '3.0.3', paths: { '/Account': {} } });
  });
});
