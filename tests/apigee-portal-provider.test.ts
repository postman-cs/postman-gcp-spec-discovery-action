import { describe, expect, it, vi } from 'vitest';

import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';
import { ApigeePortalProvider } from '../src/lib/providers/apigee-portal.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: Portal\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const GRAPHQL = 'type Query { ping: String! }\n';
const ASYNCAPI = JSON.stringify({
  asyncapi: '2.6.0',
  info: { title: 'Events', version: '1.0.0' },
  channels: { ping: { publish: { message: { payload: { type: 'string' } } } } }
});
const INTROSPECTION = JSON.stringify({
  __schema: { queryType: { name: 'Query' }, types: [{ kind: 'OBJECT', name: 'Query', fields: [] }] }
});
const ID = 'organizations/sample-project-123/sites/developer/apidocs/payments';

function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({
    probeApigeePortal: vi.fn(),
    listApigeePortalSites: vi.fn(async () => [{ id: 'developer' }]),
    listApigeePortalApidocs: vi.fn(async () => [{ id: 'payments', title: 'Payments' }]),
    getApigeePortalDocumentation: vi.fn(async () => ({
      type: 'oasDocumentation' as const,
      family: 'openapi' as const,
      contents: OAS
    })),
    ...overrides
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('Apigee portal provider', () => {
  it('lists and exports OAS documentation', async () => {
    const provider = new ApigeePortalProvider(client(), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({
      id: ID,
      supported: true,
      providerType: 'apigee-portal',
      authority: 'stored-authoritative'
    });
    await expect(provider.exportSpec(candidate)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml' });
  });

  it.each([
    ['graphqlDocumentation', 'graphql', GRAPHQL, 'graphql-sdl', 'schema.graphql'],
    ['graphqlDocumentation', 'graphql', INTROSPECTION, 'graphql-introspection-json', 'introspection.json'],
    ['asyncApiDocumentation', 'asyncapi', ASYNCAPI, 'asyncapi-json', 'asyncapi.json']
  ] as const)('exports %s (%s) via shared native-family decoder', async (type, family, body, format, filename) => {
    const provider = new ApigeePortalProvider(client({
      getApigeePortalDocumentation: vi.fn(async () => ({ type, family, contents: body }))
    }), { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({ supported: true, authority: 'stored-authoritative' });
    expect(candidate.evidence.join(' ')).toContain(type);
    await expect(provider.exportSpec(candidate)).resolves.toMatchObject({ content: body, format, filename });
  });

  it.each(['missing', 'malformed'] as const)('surfaces %s as unsupported with evidence', async (type) => {
    const candidate = (await new ApigeePortalProvider(client({
      getApigeePortalDocumentation: vi.fn(async () => ({ type }))
    }), { projectId: 'sample-project-123' }).listCandidates())[0]!;
    expect(candidate.supported).toBe(false);
    expect(candidate.authority).toBe('unsupported-format');
    expect(candidate.evidence.join(' ')).toContain(type);
  });

  it('keeps known arms with invalid contents metadata-only / unsupported', async () => {
    const candidate = (await new ApigeePortalProvider(client({
      getApigeePortalDocumentation: vi.fn(async () => ({
        type: 'oasDocumentation' as const,
        family: 'openapi' as const,
        contents: 'not openapi'
      }))
    }), { projectId: 'sample-project-123' }).listCandidates())[0]!;
    expect(candidate.supported).toBe(false);
    expect(candidate.authority).toBe('metadata-only');
  });

  it('resolves an explicit api-id directly and rejects a foreign org', async () => {
    const fake = client();
    expect((await new ApigeePortalProvider(fake, { projectId: 'sample-project-123', apiId: ID }).listCandidates())[0]?.id).toBe(ID);
    expect(fake.listApigeePortalSites).not.toHaveBeenCalled();
    await expect(new ApigeePortalProvider(fake, { projectId: 'sample-project-123', apiId: ID.replace('sample-project-123', 'other-project') }).listCandidates()).rejects.toThrow('does not belong');
  });

  it('maps probe 403 to skipped:iam', async () => {
    await expect(new ApigeePortalProvider(client({ probeApigeePortal: vi.fn(async () => { throw new Error('HTTP 403'); }) }), { projectId: 'sample-project-123' }).probe()).resolves.toBe('skipped:iam');
  });
});
