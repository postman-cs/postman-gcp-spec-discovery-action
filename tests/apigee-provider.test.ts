import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { ApigeeProvider } from '../src/lib/providers/apigee.js';
import { inflateZip } from '../src/lib/gcp/zip.js';
import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const OAS = 'openapi: 3.0.3\ninfo:\n  title: Apigee\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n';

function zip(entries: Record<string, string>, deflate = true): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(deflate ? 8 : 0, 8);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(Buffer.byteLength(name), 26);
    chunks.push(header, Buffer.from(name), data);
  }
  return Buffer.concat(chunks);
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
  it('extracts stored and deflated zip paths', () => {
    expect(inflateZip(zip({ 'a.txt': 'stored' }, false)).get('a.txt')?.toString()).toBe('stored');
    expect(inflateZip(zip({ 'b.txt': 'deflated' })).get('b.txt')?.toString()).toBe('deflated');
  });
});
