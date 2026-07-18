import { describe, expect, it, vi } from 'vitest';
import { AgentEnginesProvider } from '../src/lib/providers/agent-engines.js';
import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

function client(classMethods: Array<Record<string, unknown>>): GcpDiscoveryClient {
  return new Proxy({ listVertexLocations: vi.fn(async () => ['us-central1']), probeAgentEngines: vi.fn(), listAgentEngines: vi.fn(async () => [{ name: 'projects/p/locations/us-central1/reasoningEngines/support', displayName: 'Support', classMethods }]) }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as unknown as GcpDiscoveryClient;
}

describe('Vertex AI Agent Engine provider', () => {
  it('assembles and validates OpenAPI from classMethods declarations', async () => {
    const provider = new AgentEnginesProvider(client([{ name: 'answer', path: '/answer', httpMethod: 'POST', responses: { '200': { description: 'ok' } } }]), { projectId: 'p' });
    await expect(provider.probe()).resolves.toBe('available');
    const candidates = await provider.listCandidates();
    expect(candidates[0]).toMatchObject({ sourceType: 'agent-engine-generated-spec', providerType: 'agent-engines', supported: true });
    expect(candidates[0]?.evidence[0]).toBe('OpenAPI assembled from Agent Engine classMethods declarations; confidence is lower than stored specification sources');
    expect(JSON.parse((await provider.exportSpec(candidates[0]!)).content)).toMatchObject({ openapi: '3.0.3', paths: { '/answer': { post: { operationId: 'answer' } } } });
  });
  it('marks invalid generated declarations unsupported for manual review', async () => {
    const candidates = await new AgentEnginesProvider(client([{ name: 'answer', httpMethod: 'NOT A VERB' }]), { projectId: 'p' }).listCandidates();
    expect(candidates[0]).toMatchObject({ supported: false });
    expect(candidates[0]?.evidence.join(' ')).toContain('manual review');
  });
  it('emits no candidate when classMethods is empty', async () => {
    await expect(new AgentEnginesProvider(client([]), { projectId: 'p' }).listCandidates()).resolves.toEqual([]);
  });
});
