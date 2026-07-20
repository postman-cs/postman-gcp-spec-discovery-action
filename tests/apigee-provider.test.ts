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
    expect(candidate).toMatchObject({
      id: 'organizations/sample-project-123/apis/payments/revisions/10',
      supported: true,
      providerType: 'apigee',
      authority: 'stored-authoritative',
      sourceType: 'apigee-proxy'
    });
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
  it('does not discover or export Apigee environment resourcefiles/oas candidates', async () => {
    const listEnvironments = vi.fn(async () => ['test env']);
    const listArchives = vi.fn(async () => []);
    const fake = client(zip({ 'apiproxy/resources/oas/openapi.yaml': OAS }), {
      listApigeeEnvironments: listEnvironments,
      listApigeeArchiveDeployments: listArchives
    });
    const provider = new ApigeeProvider(fake, { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates.every((candidate) => candidate.sourceType === 'apigee-proxy' || candidate.sourceType === 'apigee-archive-deployment')).toBe(true);
    expect(candidates.map((candidate) => candidate.id).join('\n')).not.toMatch(/resourcefiles\/oas/);
    expect(listEnvironments).toHaveBeenCalled();
    expect(listArchives).toHaveBeenCalled();
    await expect(provider.exportSpec({
      id: 'organizations/sample-project-123/environments/test env/resourcefiles/oas/payments.yaml',
      name: 'payments.yaml',
      providerType: 'apigee',
      sourceType: 'apigee-proxy',
      authority: 'metadata-only',
      projectId: 'sample-project-123',
      tags: {},
      supported: false,
      evidence: [],
      meta: {}
    })).rejects.toThrow(/invalid revision resource name|invalid resource name/);
  });

  it('GCP-APIGEE-ARCHIVE-001: lists archive deployments with exactly one OpenAPI as stored-authoritative', async () => {
    const archiveId = 'organizations/sample-project-123/environments/test/archiveDeployments/archive-1';
    const archiveZip = zip({ 'specs/openapi.yaml': OAS, 'readme.txt': 'ignore' });
    const fake = client(zip({ 'apiproxy/resources/oas/openapi.yaml': OAS }), {
      listApigeeEnvironments: vi.fn(async () => ['test']),
      listApigeeArchiveDeployments: vi.fn(async () => [{ name: archiveId, labels: { env: 'test' } }]),
      generateApigeeArchiveDeploymentDownloadUrl: vi.fn(async () => 'https://storage.googleapis.com/bucket/archive.zip?X-Goog-Signature=SECRET'),
      downloadTrustedGcsSignedUrl: vi.fn(async () => archiveZip)
    });
    const candidates = await new ApigeeProvider(fake, { projectId: 'sample-project-123' }).listCandidates();
    const archive = candidates.find((candidate) => candidate.sourceType === 'apigee-archive-deployment');
    expect(archive).toMatchObject({
      id: archiveId,
      apiId: archiveId,
      authority: 'stored-authoritative',
      supported: true,
      tags: { env: 'test' }
    });
  });

  it('GCP-APIGEE-ARCHIVE-002: explicit archive api-id bypasses proxy listing and confines org', async () => {
    const archiveId = 'organizations/sample-project-123/environments/test/archiveDeployments/archive-1';
    const archiveZip = zip({ 'openapi.json': JSON.stringify({ openapi: '3.0.3', info: { title: 'A', version: '1' }, paths: { '/x': { get: { responses: { 200: { description: 'ok' } } } } } }) });
    const fake = client(zip({}), {
      generateApigeeArchiveDeploymentDownloadUrl: vi.fn(async () => 'https://storage.googleapis.com/bucket/a.zip?sig=1'),
      downloadTrustedGcsSignedUrl: vi.fn(async () => archiveZip)
    });
    const candidates = await new ApigeeProvider(fake, { projectId: 'sample-project-123', apiId: archiveId }).listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceType).toBe('apigee-archive-deployment');
    expect(fake.listApigeeProxies).not.toHaveBeenCalled();
    expect(fake.listApigeeEnvironments).not.toHaveBeenCalled();
    await expect(
      new ApigeeProvider(fake, { projectId: 'sample-project-123', apiId: 'organizations/other/environments/test/archiveDeployments/a' }).listCandidates()
    ).rejects.toThrow('api-id Apigee archive deployment does not belong to the configured project-id org');
  });

  it('GCP-APIGEE-ARCHIVE-003: rejects traversal entry names and classifies zero/multiple OpenAPI', async () => {
    const archiveId = 'organizations/sample-project-123/environments/test/archiveDeployments/archive-1';
    const traversal = zip({ '../escape.yaml': OAS });
    await expect(
      new ApigeeProvider(client(zip({}), {
        generateApigeeArchiveDeploymentDownloadUrl: vi.fn(async () => 'https://storage.googleapis.com/b/a.zip'),
        downloadTrustedGcsSignedUrl: vi.fn(async () => traversal)
      }), { projectId: 'sample-project-123', apiId: archiveId }).listCandidates()
    ).resolves.toEqual([
      expect.objectContaining({
        id: archiveId,
        supported: false,
        authority: 'metadata-only'
      })
    ]);

    const multi = zip({ 'a.yaml': OAS, 'b.yaml': OAS });
    const multiCandidate = (await new ApigeeProvider(client(zip({}), {
      generateApigeeArchiveDeploymentDownloadUrl: vi.fn(async () => 'https://storage.googleapis.com/b/a.zip'),
      downloadTrustedGcsSignedUrl: vi.fn(async () => multi)
    }), { projectId: 'sample-project-123', apiId: archiveId }).listCandidates())[0]!;
    expect(multiCandidate.supported).toBe(false);
    expect(multiCandidate.evidence.join(' ')).toContain('2 OpenAPI');
  });
});
