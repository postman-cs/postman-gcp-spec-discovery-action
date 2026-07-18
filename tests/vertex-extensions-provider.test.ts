import { describe, expect, it, vi } from 'vitest';

import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';
import { VertexExtensionsProvider } from '../src/lib/providers/vertex-extensions.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: Extension\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const ID = 'projects/sample-project-123/locations/us-central1/extensions/payments';

function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({ probeVertexExtensions: vi.fn(), listVertexExtensions: vi.fn(async () => [{ name: ID, displayName: 'Payments', openApiYaml: OAS }]), getStorageObjectText: vi.fn(async () => OAS), ...overrides }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('Vertex extensions provider', () => {
  it('exports an inline manifest OpenAPI document', async () => {
    const provider = new VertexExtensionsProvider(client(), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({ supported: true, providerType: 'vertex-extensions' });
    await expect(provider.exportSpec(candidate)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml' });
  });

  it('fetches an openApiGcsUri through storage', async () => {
    const getStorageObjectText = vi.fn(async () => OAS);
    const provider = new VertexExtensionsProvider(client({ listVertexExtensions: vi.fn(async () => [{ name: ID, openApiGcsUri: 'gs://spec-bucket/ext/openapi.yaml' }]), getStorageObjectText }), { projectId: 'sample-project-123' });
    const exported = await provider.exportSpec((await provider.listCandidates())[0]!);
    expect(getStorageObjectText).toHaveBeenCalledWith('spec-bucket', 'ext/openapi.yaml');
    expect(exported.content).toBe(OAS);
    expect(exported.evidence.join(' ')).toContain('[gs-object]');
    expect(exported.evidence.join(' ')).not.toContain('gs://');
  });

  it('marks a manifest with neither OpenAPI source unsupported', async () => {
    expect((await new VertexExtensionsProvider(client({ listVertexExtensions: vi.fn(async () => [{ name: ID }]) }), { projectId: 'sample-project-123' }).listCandidates())[0]?.supported).toBe(false);
  });

  it('supports explicit api-id and rejects a foreign project', async () => {
    const list = vi.fn(async () => [{ name: ID, openApiYaml: OAS }]);
    expect((await new VertexExtensionsProvider(client({ listVertexExtensions: list }), { projectId: 'sample-project-123', location: 'europe-west1', apiId: ID }).listCandidates())[0]?.id).toBe(ID);
    expect(list).toHaveBeenCalledWith('sample-project-123', 'us-central1');
    await expect(new VertexExtensionsProvider(client(), { projectId: 'sample-project-123', apiId: ID.replace('sample-project-123', 'other-project') }).listCandidates()).rejects.toThrow('does not belong');
  });
});
