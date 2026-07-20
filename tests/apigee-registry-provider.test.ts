import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import { ApigeeRegistryProvider, parseApigeeRegistrySpecName } from '../src/lib/providers/apigee-registry.js';
import type { ApigeeRegistrySpecSummary, GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: Legacy\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';
const GRAPHQL = 'type Query { ping: String! }\n';
const PROTO =
  'syntax = "proto3";\npackage demo;\nmessage Ping { string id = 1; }\nservice Greeter {\n  rpc SayHello (Ping) returns (Ping);\n}\n';
const SPEC_NAME = 'projects/sample-project-123/locations/us-west1/apis/payments/versions/v1/specs/openapi';

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function spec(overrides: Partial<ApigeeRegistrySpecSummary> = {}): ApigeeRegistrySpecSummary {
  return {
    name: SPEC_NAME,
    filename: 'openapi.yaml',
    mimeType: 'application/vnd.apigee.openapi',
    labels: {},
    createTime: '2024-01-01T00:00:00Z',
    ...overrides
  };
}

function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({
    probeApigeeRegistry: vi.fn(),
    listApigeeRegistrySpecs: vi.fn(async () => [spec()]),
    getApigeeRegistrySpec: vi.fn(async () => spec()),
    getApigeeRegistrySpecContents: vi.fn(async () => ({
      bytes: Buffer.from(OAS),
      mimeType: 'application/vnd.apigee.openapi'
    })),
    ...overrides
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('legacy Apigee Registry provider', () => {
  it('GCP-REGISTRY-001: parses spec resource names strictly and confines project', () => {
    expect(parseApigeeRegistrySpecName(SPEC_NAME)).toEqual({
      projectId: 'sample-project-123',
      location: 'us-west1',
      apiName: 'payments',
      versionId: 'v1',
      specId: 'openapi'
    });
    expect(parseApigeeRegistrySpecName('organizations/o/apis/a/revisions/1')).toBeUndefined();
  });

  it('GCP-REGISTRY-002: probes available and maps IAM/disabled/404 fail-soft', async () => {
    await expect(new ApigeeRegistryProvider(client(), { projectId: 'sample-project-123' }).probe()).resolves.toBe('available');
    await expect(
      new ApigeeRegistryProvider(client({ probeApigeeRegistry: vi.fn(async () => { throw new Error('HTTP 403'); }) }), { projectId: 'sample-project-123' }).probe()
    ).resolves.toBe('skipped:iam');
    await expect(
      new ApigeeRegistryProvider(client({ probeApigeeRegistry: vi.fn(async () => { throw new Error('HTTP 404'); }) }), { projectId: 'sample-project-123' }).probe()
    ).resolves.toBe('skipped:error');
  });

  it('GCP-REGISTRY-003: lists OpenAPI mime specs as stored-authoritative and labels legacy', async () => {
    const provider = new ApigeeRegistryProvider(client(), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: SPEC_NAME,
      providerType: 'apigee-registry',
      sourceType: 'apigee-registry-spec',
      authority: 'stored-authoritative',
      supported: true
    });
    expect(candidates[0]!.evidence.join(' ')).toMatch(/legacy|no-longer-supported/i);
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml' });
  });

  it('GCP-REGISTRY-004: native mime types are tentatively supported; MIME is a hint only', async () => {
    const provider = new ApigeeRegistryProvider(client({
      listApigeeRegistrySpecs: vi.fn(async () => [spec({ mimeType: 'application/vnd.apigee.proto' })]),
      getApigeeRegistrySpecContents: vi.fn(async () => ({
        bytes: Buffer.from(PROTO),
        mimeType: 'application/vnd.apigee.proto'
      }))
    }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates[0]).toMatchObject({ supported: true, authority: 'stored-authoritative' });
    expect(candidates[0]!.evidence.join(' ')).toMatch(/hint/i);
    await expect(provider.exportSpec(candidates[0]!)).resolves.toMatchObject({
      content: PROTO,
      format: 'protobuf',
      filename: 'service.proto'
    });
  });

  it('GCP-REGISTRY-005: foreign project api-id is rejected before export', async () => {
    const foreign = 'projects/other-project/locations/us-west1/apis/payments/versions/v1/specs/openapi';
    await expect(
      new ApigeeRegistryProvider(client(), { projectId: 'sample-project-123', apiId: foreign }).listCandidates()
    ).rejects.toThrow('api-id must belong to the configured project-id Apigee Registry instance');
  });

  it('GCP-REGISTRY-006: explicit api-id bypasses list and uses getContents binary shape', async () => {
    const fake = client();
    const provider = new ApigeeRegistryProvider(fake, { projectId: 'sample-project-123', apiId: SPEC_NAME });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(fake.listApigeeRegistrySpecs).not.toHaveBeenCalled();
    expect(fake.getApigeeRegistrySpec).toHaveBeenCalledWith(SPEC_NAME);
    await provider.exportSpec(candidates[0]!);
    expect(fake.getApigeeRegistrySpecContents).toHaveBeenCalledWith(SPEC_NAME);
  });

  it('GCP-REGISTRY-007: raw/gzip/zip native seams with mixed-family rejection', async () => {
    const provider = new ApigeeRegistryProvider(client({
      getApigeeRegistrySpecContents: vi.fn(async () => ({
        bytes: Buffer.from(GRAPHQL),
        mimeType: 'application/vnd.apigee.graphql'
      }))
    }), { projectId: 'sample-project-123', apiId: SPEC_NAME });
    const [candidate] = await provider.listCandidates();
    await expect(provider.exportSpec(candidate!)).resolves.toMatchObject({
      content: GRAPHQL,
      format: 'graphql-sdl',
      filename: 'schema.graphql'
    });

    const gzipProvider = new ApigeeRegistryProvider(client({
      getApigeeRegistrySpecContents: vi.fn(async () => ({
        bytes: gzipSync(Buffer.from(OAS)),
        mimeType: 'application/vnd.apigee.openapi+gzip'
      }))
    }), { projectId: 'sample-project-123', apiId: SPEC_NAME });
    await expect(gzipProvider.exportSpec((await gzipProvider.listCandidates())[0]!)).resolves.toMatchObject({
      content: OAS,
      format: 'openapi-yaml'
    });

    const zipProvider = new ApigeeRegistryProvider(client({
      getApigeeRegistrySpecContents: vi.fn(async () => ({
        bytes: zip({ 'specs/openapi.yaml': OAS }),
        mimeType: 'application/zip'
      }))
    }), { projectId: 'sample-project-123', apiId: SPEC_NAME });
    await expect(zipProvider.exportSpec((await zipProvider.listCandidates())[0]!)).resolves.toMatchObject({
      content: OAS,
      format: 'openapi-yaml'
    });

    const mixed = new ApigeeRegistryProvider(client({
      getApigeeRegistrySpecContents: vi.fn(async () => ({
        bytes: zip({ 'a.yaml': OAS, 'b.graphql': GRAPHQL }),
        mimeType: 'application/zip'
      }))
    }), { projectId: 'sample-project-123', apiId: SPEC_NAME });
    await expect(mixed.exportSpec((await mixed.listCandidates())[0]!)).rejects.toThrow(/mixed native families/i);

    const ambiguous = new ApigeeRegistryProvider(client({
      getApigeeRegistrySpecContents: vi.fn(async () => ({
        bytes: zip({ 'a.yaml': OAS, 'b.yaml': OAS }),
        mimeType: 'application/zip'
      }))
    }), { projectId: 'sample-project-123', apiId: SPEC_NAME });
    await expect(ambiguous.exportSpec((await ambiguous.listCandidates())[0]!)).rejects.toThrow(/2 native documents/i);

    const unsupported = new ApigeeRegistryProvider(client({
      getApigeeRegistrySpecContents: vi.fn(async () => ({
        bytes: Buffer.from('not a native spec'),
        mimeType: 'application/vnd.apigee.openapi'
      }))
    }), { projectId: 'sample-project-123', apiId: SPEC_NAME });
    await expect(unsupported.exportSpec((await unsupported.listCandidates())[0]!)).rejects.toThrow(
      /not a valid bootstrap-supported native document/i
    );
  });
});
