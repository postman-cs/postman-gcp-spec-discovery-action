import { describe, expect, it, vi } from 'vitest';

import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';
import { DialogflowToolsProvider } from '../src/lib/providers/dialogflow-tools.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: Tool\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const AGENT = 'projects/sample-project-123/locations/global/agents/support';
const ID = `${AGENT}/tools/payments`;

function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({ probeDialogflow: vi.fn(), listDialogflowAgents: vi.fn(async () => [{ name: AGENT }]), listDialogflowTools: vi.fn(async () => [{ name: ID, displayName: 'Payments', textSchema: OAS }]), ...overrides }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('Dialogflow tools provider', () => {
  it('lists and exports tools with openApiSpec.textSchema', async () => {
    const provider = new DialogflowToolsProvider(client(), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({ id: ID, supported: true, providerType: 'dialogflow-tools' });
    await expect(provider.exportSpec(candidate)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml' });
  });

  it('surfaces tools without openApiSpec as unsupported', async () => {
    const datastoreId = `${AGENT}/tools/datastore`;
    const provider = new DialogflowToolsProvider(client({ listDialogflowTools: vi.fn(async () => [{ name: ID, textSchema: OAS }, { name: datastoreId }]) }), { projectId: 'sample-project-123' });
    await expect(provider.listCandidates()).resolves.toEqual([
      expect.objectContaining({ id: ID, supported: true }),
      expect.objectContaining({ id: datastoreId, supported: false, evidence: ['Dialogflow tool has no OpenAPI text schema; only OPEN_API_TOOL tools are exportable'] })
    ]);
  });

  it('supports explicit api-id and rejects a foreign project', async () => {
    expect((await new DialogflowToolsProvider(client(), { projectId: 'sample-project-123', apiId: ID }).listCandidates())[0]?.id).toBe(ID);
    await expect(new DialogflowToolsProvider(client(), { projectId: 'sample-project-123', apiId: ID.replace('sample-project-123', 'other-project') }).listCandidates()).rejects.toThrow('does not belong');
  });
});
