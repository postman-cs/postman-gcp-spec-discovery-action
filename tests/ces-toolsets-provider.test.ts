import { describe, expect, it, vi } from 'vitest';
import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';
import { CesToolsetsProvider } from '../src/lib/providers/ces-toolsets.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: CES Toolset\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const ID = 'projects/sample-project-123/locations/global/apps/support/toolsets/payments';
const TOOL_ID = 'projects/sample-project-123/locations/global/apps/support/tools/refunds';
function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({ probeCes: vi.fn(), listCesToolsets: vi.fn(async () => [{ name: ID, displayName: 'Payments', openApiSchema: OAS }]), ...overrides }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}
describe('CES toolsets provider', () => {
  it('probes and lists toolset candidates', async () => {
    const provider = new CesToolsetsProvider(client(), { projectId: 'sample-project-123' });
    await expect(provider.probe()).resolves.toBe('available');
    await expect(provider.listCandidates()).resolves.toEqual([expect.objectContaining({ id: ID, supported: true, providerType: 'ces-toolsets' })]);
  });
  it('treats disabled and forbidden APIs as fail-soft', async () => {
    for (const message of ['403 SERVICE_DISABLED', '403 PERMISSION_DENIED', '404 not found']) {
      const provider = new CesToolsetsProvider(client({ probeCes: vi.fn(async () => { throw new Error(message); }) }), { projectId: 'sample-project-123' });
      await expect(provider.probe()).resolves.toMatch(/^skipped:/);
    }
  });
  it('exports and decodes the stored schema bytes', async () => {
    const provider = new CesToolsetsProvider(client(), { projectId: 'sample-project-123' });
    await expect(provider.exportSpec((await provider.listCandidates())[0]!)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml' });
  });
  it('exports standalone tool schemas and supports exact tool resource selection', async () => {
    const provider = new CesToolsetsProvider(client({ listCesToolsets: vi.fn(async () => [{ name: ID, openApiSchema: OAS }, { name: TOOL_ID, displayName: 'Refunds', openApiSchema: OAS }]) }), { projectId: 'sample-project-123', apiId: TOOL_ID });
    const candidates = await provider.listCandidates();
    expect(candidates).toEqual([expect.objectContaining({ id: TOOL_ID, supported: true })]);
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml' });
  });
  it('marks a standalone tool without a schema unsupported', async () => {
    const provider = new CesToolsetsProvider(client({ listCesToolsets: vi.fn(async () => [{ name: TOOL_ID }]) }), { projectId: 'sample-project-123' });
    await expect(provider.listCandidates()).resolves.toEqual([expect.objectContaining({ id: TOOL_ID, supported: false })]);
  });
  it('rejects malformed stored schemas', async () => {
    const provider = new CesToolsetsProvider(client({ listCesToolsets: vi.fn(async () => [{ name: ID, openApiSchema: 'not openapi' }]) }), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate.supported).toBe(false);
    await expect(provider.exportSpec(candidate)).rejects.toThrow();
  });
});
