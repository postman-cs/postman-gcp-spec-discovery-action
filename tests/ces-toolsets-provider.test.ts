import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';
import { CesToolsetsProvider } from '../src/lib/providers/ces-toolsets.js';
import { execute, resolveInputs, type ReporterLike } from '../src/runtime.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: CES Toolset\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const ID = 'projects/sample-project-123/locations/global/apps/support/toolsets/payments';
const TOOL_ID = 'projects/sample-project-123/locations/global/apps/support/tools/refunds';
const NESTED_TOOL_ID = `${ID}/tools/charge`;
function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({ probeCes: vi.fn(), listCesToolsets: vi.fn(async () => [{ name: ID, displayName: 'Payments', openApiSchema: OAS }]), ...overrides }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}
describe('CES toolsets provider', () => {
  it('probes and lists toolset candidates', async () => {
    const provider = new CesToolsetsProvider(client(), { projectId: 'sample-project-123' });
    await expect(provider.probe()).resolves.toBe('available');
    await expect(provider.listCandidates()).resolves.toEqual([
      expect.objectContaining({ id: ID, supported: true, providerType: 'ces-toolsets', authority: 'stored-authoritative' })
    ]);
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
    expect(candidates).toEqual([expect.objectContaining({ id: TOOL_ID, supported: true, authority: 'stored-authoritative' })]);
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml' });
  });
  it('selects an exact toolset-scoped tool as ces-toolset-schema while standalone tools remain ces-tool-schema', async () => {
    const values = [{ name: NESTED_TOOL_ID, displayName: 'Charge', openApiSchema: OAS }, { name: TOOL_ID, displayName: 'Refunds', openApiSchema: OAS }];
    const nested = new CesToolsetsProvider(client({ listCesToolsets: vi.fn(async () => values) }), { projectId: 'sample-project-123', apiId: NESTED_TOOL_ID });
    await expect(nested.listCandidates()).resolves.toEqual([
      expect.objectContaining({ id: NESTED_TOOL_ID, sourceType: 'ces-toolset-schema', evidence: ['CES toolset-scoped tool stores an OpenAPI schema'] })
    ]);
    const standalone = new CesToolsetsProvider(client({ listCesToolsets: vi.fn(async () => values) }), { projectId: 'sample-project-123', apiId: TOOL_ID });
    await expect(standalone.listCandidates()).resolves.toEqual([
      expect.objectContaining({ id: TOOL_ID, sourceType: 'ces-tool-schema' })
    ]);
  });
  it('preserves standalone tool and toolset source identity through execute', async () => {
    const core: ReporterLike = { group: async (_name, fn) => fn(), info: () => undefined, warning: () => undefined };
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'gcp-ces-'));
    try {
      for (const [apiId, sourceType] of [[TOOL_ID, 'ces-tool-schema'], [ID, 'ces-toolset-schema']] as const) {
        const provider = new CesToolsetsProvider(client({ listCesToolsets: vi.fn(async () => [{ name: ID, openApiSchema: OAS }, { name: TOOL_ID, openApiSchema: OAS }]) }), { projectId: 'sample-project-123', apiId });
        const inputs = { ...resolveInputs({ INPUT_PROJECT_ID: 'sample-project-123', INPUT_API_ID: apiId, INPUT_REPO_ROOT: repoRoot }), repoRoot, dryRun: true };
        const result = await execute(inputs, { core, client: client(), providers: [provider], writeSpecFile: vi.fn(async () => undefined) });
        expect(result.resolution).toMatchObject({ status: 'resolved', sourceType, apiId });
        expect(result.resolution?.evidence.join(' ')).toContain(sourceType === 'ces-tool-schema' ? 'CES tool ' : 'CES toolset ');
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
  it('marks a standalone tool without a schema unsupported', async () => {
    const provider = new CesToolsetsProvider(client({ listCesToolsets: vi.fn(async () => [{ name: TOOL_ID }]) }), { projectId: 'sample-project-123' });
    await expect(provider.listCandidates()).resolves.toEqual([
      expect.objectContaining({ id: TOOL_ID, supported: false, authority: 'metadata-only' })
    ]);
  });
  it('rejects malformed stored schemas', async () => {
    const provider = new CesToolsetsProvider(client({ listCesToolsets: vi.fn(async () => [{ name: ID, openApiSchema: 'not openapi' }]) }), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate.supported).toBe(false);
    await expect(provider.exportSpec(candidate)).rejects.toThrow();
  });
});
