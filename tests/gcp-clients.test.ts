import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { GoogleAuth } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';

import {
  GcpSdkClient,
  type GcpAuthenticatedRequester,
  type GcpRequestOptions
} from '../src/lib/gcp/clients.js';

function clientWith(handler: (options: GcpRequestOptions) => Promise<{ data: unknown }>) {
  const request = vi.fn(handler);
  const requester = { request } as unknown as GcpAuthenticatedRequester;
  return {
    client: new GcpSdkClient({} as GoogleAuth, { requestTimeoutMs: 1234, maxAttempts: 3 }, requester),
    request
  };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

describe('GCP authenticated REST client', () => {
  it('probes the Apigee portal sites collection without unsupported pagination', async () => {
    const { client, request } = clientWith(async () => ({ data: { sites: [] } }));
    await client.probeApigeePortal('sample-project-123');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://apigee.googleapis.com/v1/organizations/sample-project-123/sites'
    }));
  });
  it('GCP-CLIENT-001: production has one GoogleAuth construction and project preflight uses the explicit project', async () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/lib/gcp/clients.ts'), 'utf8');
    expect(source.match(/new GoogleAuth\(/g)).toHaveLength(1);
    const { client, request } = clientWith(async () => ({ data: { projectId: 'sample-project-123', state: 'ACTIVE' } }));

    await client.preflightProject('sample-project-123');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://cloudresourcemanager.googleapis.com/v3/projects/sample-project-123',
      timeout: 1234,
      retry: false
    });
  });

  it('GCP-CLIENT-002: transient failures retry within max-attempts while 400/401 do not retry', async () => {
    let transientCalls = 0;
    const transient = clientWith(async () => {
      transientCalls += 1;
      if (transientCalls < 3) throw httpError(503);
      return { data: { projectId: 'sample-project-123' } };
    });
    await transient.client.preflightProject('sample-project-123');
    expect(transient.request).toHaveBeenCalledTimes(3);

    for (const status of [400, 401]) {
      const terminal = clientWith(async () => { throw httpError(status); });
      await expect(terminal.client.preflightProject('sample-project-123')).rejects.toThrow(`HTTP ${status}`);
      expect(terminal.request).toHaveBeenCalledTimes(1);
    }
  });

  it('GCP-CLIENT-003: pagination combines pages in order and rejects a repeated token', async () => {
    const paged = clientWith(async (options) => {
      const token = new URL(options.url).searchParams.get('pageToken');
      return token
        ? { data: { apis: [{ name: 'projects/p/locations/global/apis/b' }] } }
        : { data: { apis: [{ name: 'projects/p/locations/global/apis/a' }], nextPageToken: 'next-1' } };
    });
    await expect(paged.client.listApiGatewayApis('sample-project-123', 'global')).resolves.toEqual([
      expect.objectContaining({ name: 'projects/p/locations/global/apis/a' }),
      expect.objectContaining({ name: 'projects/p/locations/global/apis/b' })
    ]);
    expect(paged.request).toHaveBeenCalledTimes(2);

    const repeated = clientWith(async () => ({ data: { services: [], nextPageToken: 'same' } }));
    await expect(repeated.client.listManagedServices('sample-project-123')).rejects.toThrow(
      'Cloud Endpoints service list returned a repeated page token; aborting'
    );
    expect(repeated.request).toHaveBeenCalledTimes(2);
  });

  it('GCP-CLIENT-004: query construction encodes resource names and exact producer filtering', async () => {
    const { client, request } = clientWith(async (options) => {
      if (options.url.includes('servicemanagement')) {
        return { data: { services: [{ serviceName: 'svc.example.com', producerProjectId: 'sample-project-123' }] } };
      }
      return { data: { openapiDocuments: [], labels: { team: 'cse' } } };
    });
    await client.getApiGatewayConfig('projects/sample-project-123/locations/global/apis/a/configs/v1');
    await client.listManagedServices('sample-project-123');

    expect(request.mock.calls[0]?.[0].url).toContain('/v1/projects/sample-project-123/locations/global/apis/a/configs/v1?view=FULL');
    const endpointsUrl = new URL(request.mock.calls[1]![0].url);
    expect(endpointsUrl.searchParams.get('producerProjectId')).toBe('sample-project-123');
    expect(endpointsUrl.searchParams.get('pageSize')).toBe('1000');
  });

  it('uses encoded Apigee URLs and binary response mode', async () => {
    const { client, request } = clientWith(async (options) => options.responseType === 'arraybuffer'
      ? { data: Uint8Array.from([1, 2, 3]) }
      : { data: ['1', '2'] });
    await expect(client.listApigeeRevisions('sample-project-123', 'proxy name')).resolves.toEqual(['1', '2']);
    await expect(client.downloadApigeeRevisionBundle('sample-project-123', 'proxy name', '2')).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(request.mock.calls[0]?.[0].url).toContain('/organizations/sample-project-123/apis/proxy%20name/revisions');
    expect(request.mock.calls[1]?.[0]).toMatchObject({ responseType: 'arraybuffer' });
  });
  it('lists Apigee environments without resourcefiles/oas calls', async () => {
    const { client, request } = clientWith(async () => ({ data: ['test env'] }));
    await expect(client.listApigeeEnvironments('sample-project-123')).resolves.toEqual(['test env']);
    expect(request.mock.calls.map((call) => call[0].url)).toEqual([
      'https://apigee.googleapis.com/v1/organizations/sample-project-123/environments'
    ]);
    expect(request.mock.calls.map((call) => call[0].url).join('\n')).not.toMatch(/resourcefiles|type=oas/);
    expect(client).not.toHaveProperty('listApigeeEnvironmentOasFiles');
    expect(client).not.toHaveProperty('getApigeeEnvironmentOasFile');
  });

  it('GETs connector schema metadata singleton without a request body', async () => {
    const connection = 'projects/sample-project-123/locations/us-central1/connections/salesforce';
    const { client, request } = clientWith(async (options) => {
      if (options.url.includes('/locations?')) return { data: { locations: [{ locationId: 'us-central1' }] } };
      if (options.url.includes('/connections?')) return { data: { connections: [{ name: connection }] } };
      return {
        data: {
          name: `${connection}/connectionSchemaMetadata`,
          entities: ['Account', 'Contact'],
          actions: ['ExecuteQuery'],
          state: 'UPDATED',
          updateTime: '2026-07-01T00:00:00Z',
          refreshTime: '2026-07-01T00:00:01Z'
        }
      };
    });
    await expect(client.listConnectorConnections('sample-project-123')).resolves.toEqual([{ name: connection }]);
    await expect(client.getConnectorSchemaMetadata(connection)).resolves.toEqual({
      name: `${connection}/connectionSchemaMetadata`,
      entities: ['Account', 'Contact'],
      actions: ['ExecuteQuery'],
      state: 'UPDATED',
      updateTime: '2026-07-01T00:00:00Z',
      refreshTime: '2026-07-01T00:00:01Z'
    });
    expect(request.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: `https://connectors.googleapis.com/v1/${connection}/connectionSchemaMetadata`,
        method: 'GET'
      })
    ]));
    expect(request.mock.calls.map((call) => call[0].url).join('\n')).not.toContain(':getConnectionSchemaMetadata');
    expect(request.mock.calls.some((call) => call[0].method === 'POST' && call[0].url.includes('connectionSchemaMetadata'))).toBe(false);
  });

  it('uses Vertex Extensions v1beta1 and Dialogflow CX v3 on global/regional hosts', async () => {
    const { client, request } = clientWith(async (options) => {
      if (options.url.includes('/locations?pageSize=200')) return { data: { locations: [{ locationId: 'global' }, { locationId: 'europe-west1' }] } };
      return { data: {} };
    });
    await client.probeVertexExtensions('sample-project-123', 'europe-west1');
    await client.listVertexExtensions('sample-project-123', 'europe-west1');
    await client.listDialogflowAgents('sample-project-123');
    await client.listDialogflowTools('projects/sample-project-123/locations/europe-west1/agents/support');
    const urls = request.mock.calls.map((call) => call[0].url);
    expect(urls).toContain('https://europe-west1-aiplatform.googleapis.com/v1beta1/projects/sample-project-123/locations/europe-west1/extensions?pageSize=1');
    expect(urls).toContain('https://europe-west1-aiplatform.googleapis.com/v1beta1/projects/sample-project-123/locations/europe-west1/extensions?pageSize=1000');
    expect(urls).toContain('https://dialogflow.googleapis.com/v3/projects/sample-project-123/locations?pageSize=200');
    expect(urls).toContain('https://dialogflow.googleapis.com/v3/projects/sample-project-123/locations/global/agents?pageSize=1000');
    expect(urls).toContain('https://europe-west1-dialogflow.googleapis.com/v3/projects/sample-project-123/locations/europe-west1/agents?pageSize=1000');
    expect(urls).toContain('https://europe-west1-dialogflow.googleapis.com/v3/projects/sample-project-123/locations/europe-west1/agents/support/tools?pageSize=1000');
    expect(urls.join('\n')).not.toMatch(/aiplatform\.googleapis\.com\/v1\/.*\/extensions/);
    expect(urls.join('\n')).not.toMatch(/dialogflow\.googleapis\.com\/v1\//);
  });

  it('paginates regional Vertex Agent Engine reasoningEngines and maps classMethods', async () => {
    const engine = 'projects/sample-project-123/locations/us-central1/reasoningEngines/support';
    const { client, request } = clientWith(async (options) => new URL(options.url).searchParams.get('pageToken')
      ? { data: { reasoningEngines: [{ name: `${engine}-2`, spec: { classMethods: [{ name: 'second' }] } }] } }
      : { data: { reasoningEngines: [{ name: engine, displayName: 'Support', spec: { classMethods: [{ name: 'answer' }] } }], nextPageToken: 'next' } });
    await expect(client.listAgentEngines('sample-project-123', 'us-central1')).resolves.toEqual([
      { name: engine, displayName: 'Support', classMethods: [{ name: 'answer' }] },
      { name: `${engine}-2`, displayName: undefined, classMethods: [{ name: 'second' }] }
    ]);
    expect(request.mock.calls.map((call) => call[0].url)).toEqual([
      `https://us-central1-aiplatform.googleapis.com/v1/projects/sample-project-123/locations/us-central1/reasoningEngines?pageSize=1000`,
      `https://us-central1-aiplatform.googleapis.com/v1/projects/sample-project-123/locations/us-central1/reasoningEngines?pageSize=1000&pageToken=next`
    ]);
  });

  it('lists CES toolsets and standalone app tools as real resource candidates', async () => {
    const app = 'projects/sample-project-123/locations/global/apps/support';
    const toolset = `${app}/toolsets/payments`;
    const tool = `${app}/tools/refunds`;
    const nestedTool = `${toolset}/tools/charge`;
    const { client, request } = clientWith(async (options) => {
      if (options.url.includes('/apps?')) return { data: { apps: [{ name: app }] } };
      if (options.url.includes('toolsets/payments:retrieveTools')) {
        return { data: { tools: [{ name: nestedTool, openApiTool: { openApiSchema: 'nested-schema' } }] } };
      }
      if (options.url.includes('/toolsets?') && !options.url.includes(':retrieveTools')) return { data: { toolsets: [{ name: toolset, openApiToolset: { openApiSchema: 'toolset-schema' } }] } };
      if (options.url.includes('/tools?')) return { data: { tools: [{ name: tool, openApiTool: { openApiSchema: 'tool-schema' } }] } };
      return { data: {} };
    });

    await expect(client.listCesToolsets('sample-project-123')).resolves.toEqual([
      { name: toolset, displayName: undefined, openApiSchema: 'toolset-schema' },
      { name: nestedTool, displayName: undefined, openApiSchema: 'nested-schema' },
      { name: tool, displayName: undefined, openApiSchema: 'tool-schema' }
    ]);
    expect(request.mock.calls.map((call) => call[0].url)).toEqual(expect.arrayContaining([
      `https://ces.googleapis.com/v1/${app}/toolsets?pageSize=1000`,
      `https://ces.googleapis.com/v1/${toolset}:retrieveTools`,
      `https://ces.googleapis.com/v1/${app}/tools?pageSize=1000`
    ]));
    expect(request.mock.calls.filter((call) => call[0].url.endsWith(':retrieveTools')).map((call) => call[0])).toEqual([
      expect.objectContaining({ method: 'POST', data: {} })
    ]);
  });

  it('paginates location enumeration and merges both pages', async () => {
    const { client, request } = clientWith(async (options) => {
      const token = new URL(options.url).searchParams.get('pageToken');
      if (options.url.includes('/locations?')) return token
        ? { data: { locations: [{ locationId: 'europe-west1' }] } }
        : { data: { locations: [{ locationId: 'global' }], nextPageToken: 'locations-2' } };
      return { data: {} };
    });
    await client.listDialogflowAgents('sample-project-123');
    expect(request.mock.calls.map((call) => call[0].url)).toEqual(expect.arrayContaining([
      'https://dialogflow.googleapis.com/v3/projects/sample-project-123/locations?pageSize=200',
      'https://dialogflow.googleapis.com/v3/projects/sample-project-123/locations?pageSize=200&pageToken=locations-2',
      'https://dialogflow.googleapis.com/v3/projects/sample-project-123/locations/global/agents?pageSize=1000',
      'https://europe-west1-dialogflow.googleapis.com/v3/projects/sample-project-123/locations/europe-west1/agents?pageSize=1000'
    ]));
  });

  it('paginates every ACTIVE Application Integration version and preserves each trigger group', async () => {
    const integration = 'projects/sample-project-123/locations/us-central1/integrations/orders-api';
    const { client, request } = clientWith(async (options) => {
      const url = new URL(options.url);
      if (url.pathname.endsWith('/locations')) return { data: { locations: [{ locationId: 'us-central1' }] } };
      if (url.pathname.endsWith('/integrations')) return { data: { integrations: [{ name: integration, updateTime: '2026-07-01T00:00:00Z' }] } };
      if (url.pathname.endsWith('/versions')) {
        expect(url.searchParams.get('filter')).toBe('state=ACTIVE');
        expect(url.searchParams.get('pageSize')).toBe('1000');
        expect(url.searchParams.get('pageSize')).not.toBe('1');
        const token = url.searchParams.get('pageToken');
        return token
          ? {
            data: {
              integrationVersions: [{
                name: `${integration}/versions/0002`,
                updateTime: '2026-07-03T00:00:00Z',
                triggerConfigs: [{ triggerId: 'api_trigger/orders-api_API_2' }, { triggerId: 'schedule/ignored' }]
              }]
            }
          }
          : {
            data: {
              integrationVersions: [{
                name: `${integration}/versions/0001`,
                updateTime: '2026-07-02T00:00:00Z',
                triggerConfigs: [{ triggerId: 'api_trigger/orders-api_API_1' }]
              }],
              nextPageToken: 'versions-2'
            }
          };
      }
      return { data: {} };
    });

    await expect(client.listAppIntegrationApiTriggers('sample-project-123')).resolves.toEqual([
      {
        integrationResource: integration,
        location: 'us-central1',
        triggerIds: ['api_trigger/orders-api_API_1'],
        updateTime: '2026-07-02T00:00:00Z',
        versionName: `${integration}/versions/0001`
      },
      {
        integrationResource: integration,
        location: 'us-central1',
        triggerIds: ['api_trigger/orders-api_API_2'],
        updateTime: '2026-07-03T00:00:00Z',
        versionName: `${integration}/versions/0002`
      }
    ]);

    const versionCalls = request.mock.calls
      .map((call) => new URL(call[0].url))
      .filter((url) => url.pathname.endsWith('/versions'));
    expect(versionCalls).toHaveLength(2);
    expect(versionCalls[0]).toMatchObject({
      origin: 'https://integrations.googleapis.com',
      pathname: `/v1/${integration}/versions`
    });
    expect(Object.fromEntries(versionCalls[0]!.searchParams)).toEqual({
      filter: 'state=ACTIVE',
      pageSize: '1000'
    });
    expect(Object.fromEntries(versionCalls[1]!.searchParams)).toEqual({
      filter: 'state=ACTIVE',
      pageSize: '1000',
      pageToken: 'versions-2'
    });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('pins GCS media downloads to metadata generation and verifies CRC32C', async () => {
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('openapi: 3.0.3\ninfo:\n  title: GCS\n  version: "1"\npaths: {}\n');
    const polynomial = 0x82f63b78;
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let crc = index;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? polynomial ^ (crc >>> 1) : crc >>> 1;
      table[index] = crc >>> 0;
    }
    let crc = 0xffffffff;
    for (let index = 0; index < body.byteLength; index += 1) crc = table[(crc ^ body[index]!) & 0xff]! ^ (crc >>> 8);
    const crc32c = Buffer.alloc(4);
    crc32c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    const { client, request } = clientWith(async (options) => {
      const url = new URL(options.url);
      expect(url.pathname).toBe('/storage/v1/b/spec-bucket/o/path%2Fwith%20spaces%2Fopenapi.yaml');
      expect(options.url).not.toContain('/b/spec-bucket/o?');
      if (options.responseType === 'arraybuffer') {
        expect(url.searchParams.get('alt')).toBe('media');
        expect(url.searchParams.get('generation')).toBe('42');
        return { data: body };
      }
      expect(url.searchParams.get('alt')).toBeNull();
      return {
        data: {
          generation: '42',
          size: String(body.byteLength),
          contentType: 'application/yaml',
          crc32c: crc32c.toString('base64'),
          md5Hash: createHash('md5').update(body).digest('base64')
        }
      };
    });
    await expect(client.getStorageObjectText('spec-bucket', 'path/with spaces/openapi.yaml')).resolves.toBe(body.toString('utf8'));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fails closed on GCS checksum mismatch, missing checksums, and oversized objects', async () => {
    const oversize = clientWith(async () => ({
      data: { generation: '1', size: String(10 * 1024 * 1024 + 1), crc32c: 'AAAAAA==' }
    }));
    await expect(oversize.client.getStorageObjectText('b', 'o')).rejects.toThrow('exceeds 10 MiB');

    const missingChecksum = clientWith(async (options) => options.responseType === 'arraybuffer'
      ? { data: Buffer.from('x') }
      : { data: { generation: '1', size: '1' } });
    await expect(missingChecksum.client.getStorageObjectText('b', 'o')).rejects.toThrow('omitted CRC32C and MD5');

    const mismatched = clientWith(async (options) => options.responseType === 'arraybuffer'
      ? { data: Buffer.from('mutated') }
      : { data: { generation: '9', size: '7', crc32c: 'AAAAAA==' } });
    await expect(mismatched.client.getStorageObjectText('b', 'o')).rejects.toThrow('CRC32C mismatch');
  });

  it('terminates repeated location tokens via the collectPages guard', async () => {
    const { client, request } = clientWith(async () => ({ data: { locations: [], nextPageToken: 'same-location' } }));
    await expect(client.listVertexLocations('sample-project-123')).rejects.toThrow('Vertex AI location list returned a repeated page token; aborting');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('GCP-CLIENT-005: API Hub attributes flatten from nested AttributeValues to string tags', async () => {
    // Real API Hub attributes are map<string, AttributeValues> keyed by the full
    // attribute resource name; a labels-flattener would drop them to {}. The
    // client must surface the scalar so postman-repo reaches the matcher.
    const { client } = clientWith(async (options) => {
      const url = new URL(options.url);
      if (url.hostname !== 'apihub.googleapis.com') return { data: {} };
      if (url.pathname.endsWith('/locations')) return { data: { locations: [{ locationId: 'us-central1' }] } };
      if (url.pathname.endsWith('/apis')) return { data: { apis: [{ name: 'projects/sample-project-123/locations/us-central1/apis/payments', displayName: 'payments' }] } };
      if (url.pathname.endsWith('/versions')) return { data: { versions: [{ name: 'projects/sample-project-123/locations/us-central1/apis/payments/versions/v1' }] } };
      if (url.pathname.endsWith('/specs')) {
        return { data: { specs: [{
          name: 'projects/sample-project-123/locations/us-central1/apis/payments/versions/v1/specs/openapi',
          specType: { enumValues: { values: [{ id: 'openapi' }] } },
          attributes: {
            'projects/sample-project-123/locations/us-central1/attributes/postman-repo': { stringValues: { values: ['org--payments'] } },
            'projects/sample-project-123/locations/us-central1/attributes/team': { enumValues: { values: [{ id: 'payments-team' }] } },
            'projects/sample-project-123/locations/us-central1/attributes/ignored': { jsonValues: { values: ['{}'] } }
          }
        }] } };
      }
      return { data: {} };
    });
    const specs = await client.listApiHubSpecs('sample-project-123');
    expect(specs).toHaveLength(1);
    expect(specs[0]?.attributes).toEqual({ 'postman-repo': 'org--payments', team: 'payments-team' });
  });

  it('GCP-CLIENT-010: constructing GcpSdkClient never starts ADC credential resolution', () => {
    const getClient = vi.fn(() => Promise.reject(new Error('ADC lookup must not run at construction')));
    const auth = { getClient } as unknown as GoogleAuth;
    new GcpSdkClient(auth, { requestTimeoutMs: 1234, maxAttempts: 3 });
    expect(getClient).not.toHaveBeenCalled();
  });

  it('GCP-CLIENT-011: API Hub additional content uses exact query enum and response path', async () => {
    const { client, request } = clientWith(async () => ({
      data: {
        additionalSpecContent: {
          specContents: { contents: Buffer.from('openapi: 3.0.3\n').toString('base64'), mimeType: 'application/yaml' }
        }
      }
    }));
    const name = 'projects/sample-project-123/locations/us-central1/apis/a/versions/v1/specs/s';
    await expect(client.fetchApiHubAdditionalSpecContent(name, 'BOOSTED_SPEC_CONTENT')).resolves.toMatchObject({
      mimeType: 'application/yaml'
    });
    const url = new URL(request.mock.calls[0]![0].url);
    expect(url.pathname).toBe(`/v1/${name}:fetchAdditionalSpecContent`);
    expect(url.searchParams.get('specContentType')).toBe('BOOSTED_SPEC_CONTENT');
  });

  it('GCP-CLIENT-013: API Hub additional content preserves valid percent-encoded resource IDs', async () => {
    const { client, request } = clientWith(async () => ({
      data: { additionalSpecContent: { specContents: {} } }
    }));
    const name = 'projects/sample-project-123/locations/us-central1/apis/a%2Fb/versions/v1/specs/s%20one';
    await client.fetchApiHubAdditionalSpecContent(name, 'GATEWAY_OPEN_API_SPEC');
    const url = new URL(request.mock.calls[0]![0].url);
    expect(url.pathname).toContain('/apis/a%2Fb/versions/v1/specs/s%20one:fetchAdditionalSpecContent');
    expect(url.pathname).not.toContain('%252F');
    expect(url.pathname).not.toContain('%2520');
  });

  it('GCP-CLIENT-012: API Hub mapper defaults additionalSpecContentTypes and parses advertised types', async () => {
    const { client } = clientWith(async (options) => {
      const url = new URL(options.url);
      if (url.pathname.endsWith('/locations')) return { data: { locations: [{ locationId: 'us-central1' }] } };
      if (url.pathname.endsWith('/apis')) return { data: { apis: [{ name: 'projects/sample-project-123/locations/us-central1/apis/a' }] } };
      if (url.pathname.endsWith('/versions')) return { data: { versions: [{ name: 'projects/sample-project-123/locations/us-central1/apis/a/versions/v1' }] } };
      if (url.pathname.endsWith('/specs')) {
        return {
          data: {
            specs: [{
              name: 'projects/sample-project-123/locations/us-central1/apis/a/versions/v1/specs/s',
              specType: { enumValues: { values: [{ id: 'openapi' }] } },
              additionalSpecContents: [
                { specContentType: 'BOOSTED_SPEC_CONTENT' },
                { specContentType: 'GATEWAY_OPEN_API_SPEC' },
                { specContentType: 'UNKNOWN' }
              ]
            }]
          }
        };
      }
      return { data: {} };
    });
    const specs = await client.listApiHubSpecs('sample-project-123');
    expect(specs[0]?.additionalSpecContentTypes).toEqual(['BOOSTED_SPEC_CONTENT', 'GATEWAY_OPEN_API_SPEC']);
  });

  it('GCP-CLIENT-013: Apigee Registry getContents is binary with Content-Type metadata', async () => {
    const { client, request } = clientWith(async () => ({
      data: Uint8Array.from(Buffer.from('openapi: 3.0.3\n')),
      headers: { 'content-type': 'application/vnd.apigee.openapi' }
    }));
    const name = 'projects/sample-project-123/locations/us/apis/a/versions/v1/specs/s';
    await expect(client.getApigeeRegistrySpecContents(name)).resolves.toEqual({
      bytes: Buffer.from('openapi: 3.0.3\n'),
      mimeType: 'application/vnd.apigee.openapi'
    });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      responseType: 'arraybuffer',
      url: `https://apigeeregistry.googleapis.com/v1/${name}:getContents`
    });
  });

  it('GCP-CLIENT-014: archive download URL generation and trusted GCS host checks', async () => {
    const { client, request } = clientWith(async () => ({
      data: { downloadUri: 'https://storage.googleapis.com/bucket/object.zip?X-Goog-Signature=SECRET' }
    }));
    const name = 'organizations/sample-project-123/environments/test/archiveDeployments/a1';
    await expect(client.generateApigeeArchiveDeploymentDownloadUrl(name)).resolves.toContain('storage.googleapis.com');
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'POST',
      url: `https://apigee.googleapis.com/v1/${name}:generateDownloadUrl`
    });

    const { isTrustedGcsHost, safeUrlForErrors } = await import('../src/lib/gcp/clients.js');
    expect(isTrustedGcsHost('storage.googleapis.com')).toBe(true);
    expect(isTrustedGcsHost('storage.cloud.google.com')).toBe(true);
    expect(isTrustedGcsHost('my-bucket.storage.googleapis.com')).toBe(true);
    expect(isTrustedGcsHost('evil.com.storage.googleapis.com.evil.com')).toBe(false);
    expect(isTrustedGcsHost('example.com')).toBe(false);
    const signed = new URL('https://storage.googleapis.com/bucket/object.zip?X-Goog-Signature=SECRET');
    expect(safeUrlForErrors(signed)).toBe('https://storage.googleapis.com/bucket/object.zip');
    expect(safeUrlForErrors(signed)).not.toContain('Signature');

    await expect(
      client.downloadTrustedGcsSignedUrl('https://evil.example/path?sig=1')
    ).rejects.toThrow(/trusted GCS endpoint/);
    await expect(
      client.downloadTrustedGcsSignedUrl('http://storage.googleapis.com/bucket/object.zip')
    ).rejects.toThrow(/HTTPS/);
  });

  it('GCP-CLIENT-015: archive list paginates and rejects repeated tokens', async () => {
    const paged = clientWith(async (options) => {
      const token = new URL(options.url).searchParams.get('pageToken');
      return token
        ? { data: { archiveDeployments: [{ name: 'organizations/p/environments/e/archiveDeployments/b' }] } }
        : {
            data: {
              archiveDeployments: [{ name: 'organizations/p/environments/e/archiveDeployments/a' }],
              nextPageToken: 'next'
            }
          };
    });
    await expect(paged.client.listApigeeArchiveDeployments('p', 'e')).resolves.toEqual([
      expect.objectContaining({ name: 'organizations/p/environments/e/archiveDeployments/a' }),
      expect.objectContaining({ name: 'organizations/p/environments/e/archiveDeployments/b' })
    ]);

    const repeated = clientWith(async () => ({ data: { archiveDeployments: [], nextPageToken: 'same' } }));
    await expect(repeated.client.listApigeeArchiveDeployments('p', 'e')).rejects.toThrow(
      'Apigee archive deployment list returned a repeated page token; aborting'
    );
  });
});
