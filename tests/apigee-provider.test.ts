import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { ApigeeProvider } from '../src/lib/providers/apigee.js';
import { inflateZip } from '../src/lib/gcp/zip.js';
import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: Apigee\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';

function zip(entries: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function client(bundle: Buffer, overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({
    probeApigee: vi.fn(),
    listApigeeProxies: vi.fn(async () => [{ name: 'payments' }]),
    listApigeeRevisions: vi.fn(async () => ['1', '10', '2']),
    downloadApigeeRevisionBundle: vi.fn(async () => bundle),
    ...overrides
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('Apigee provider', () => {
  it('probes available and maps IAM failure', async () => {
    await expect(new ApigeeProvider(client(zip({})), { projectId: 'sample-project-123' }).probe()).resolves.toBe('available');
    await expect(new ApigeeProvider(client(zip({}), { probeApigee: vi.fn(async () => { throw new Error('HTTP 403'); }) }), { projectId: 'sample-project-123' }).probe()).resolves.toBe('skipped:iam');
  });
  it('lists newest revision with one OAS as supported and exports it', async () => {
    const fake = client(zip({ 'apiproxy/resources/oas/openapi.yaml': OAS }));
    const provider = new ApigeeProvider(fake, { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates())[0]!;
    expect(candidate).toMatchObject({ id: 'organizations/sample-project-123/apis/payments/revisions/10', supported: true, providerType: 'apigee' });
    await expect(provider.exportSpec(candidate)).resolves.toMatchObject({ content: OAS, format: 'openapi-yaml', filename: 'index.yaml' });
  });
  it('classifies no OAS and multiple OAS as unsupported', async () => {
    for (const bundle of [zip({ 'apiproxy/proxies/default.xml': '<x/>' }), zip({ 'apiproxy/resources/oas/a.yaml': OAS, 'apiproxy/resources/openapi/b.json': '{"swagger":"2.0","info":{"title":"b","version":"1"},"paths":{"/b":{"get":{"responses":{"200":{"description":"ok"}}}}}}' })]) {
      const candidate = (await new ApigeeProvider(client(bundle), { projectId: 'sample-project-123' }).listCandidates())[0]!;
      expect(candidate.supported).toBe(false);
    }
  });
  it('fetches an explicit revision directly and validates org', async () => {
    const fake = client(zip({ 'apiproxy/resources/openapi/openapi.yaml': OAS }));
    const id = 'organizations/sample-project-123/apis/orders/revisions/3';
    const candidates = await new ApigeeProvider(fake, { projectId: 'sample-project-123', apiId: id }).listCandidates();
    expect(candidates[0]?.id).toBe(id);
    expect(fake.listApigeeProxies).not.toHaveBeenCalled();
  });
  it('GCP-APIGEE-ASSOC-001: projects proxy labels into candidate tags for repo association', async () => {
    const fake = client(zip({ 'apiproxy/resources/oas/openapi.yaml': OAS }), {
      listApigeeProxies: vi.fn(async () => [{ name: 'payments', labels: { 'postman-repo': 'acme--payments-api' } }])
    });
    const candidate = (await new ApigeeProvider(fake, { projectId: 'sample-project-123' }).listCandidates())[0]!;
    expect(candidate.tags).toEqual({ 'postman-repo': 'acme--payments-api' });
  });
  it('GCP-APIGEE-ASSOC-001: explicit api-id candidates carry no proxy labels', async () => {
    const id = 'organizations/sample-project-123/apis/orders/revisions/3';
    const candidates = await new ApigeeProvider(client(zip({ 'apiproxy/resources/oas/openapi.yaml': OAS })), { projectId: 'sample-project-123', apiId: id }).listCandidates();
    expect(candidates[0]?.tags).toEqual({});
  });
  it('extracts stored and deflated zip paths', () => {
    expect(inflateZip(zip({ 'a.txt': 'stored' }, false)).get('a.txt')?.toString()).toBe('stored');
    expect(inflateZip(zip({ 'b.txt': 'deflated' })).get('b.txt')?.toString()).toBe('deflated');
  });
  it('lists, validates, and exports environment OAS resource files', async () => {
    const fake = client(zip({}), {
      listApigeeEnvironments: vi.fn(async () => ['test env']),
      listApigeeEnvironmentOasFiles: vi.fn(async () => ['payments.yaml']),
      getApigeeEnvironmentOasFile: vi.fn(async () => OAS)
    });
    const provider = new ApigeeProvider(fake, { projectId: 'sample-project-123' });
    const candidate = (await provider.listCandidates()).find((value) => value.sourceType === 'apigee-env-oas')!;
    expect(candidate).toMatchObject({ id: 'organizations/sample-project-123/environments/test env/resourcefiles/oas/payments.yaml', supported: true, sourceType: 'apigee-env-oas' });
    await expect(provider.exportSpec(candidate)).resolves.toMatchObject({ content: OAS, evidence: ['Exported original validated Apigee environment OAS resource file'] });
  });
});
