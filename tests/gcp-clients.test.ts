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
  it('uses encoded Apigee environment OAS wire calls', async () => {
    const { client, request } = clientWith(async (options) => options.responseType === 'arraybuffer'
      ? { data: Buffer.from('openapi: 3.0.3') }
      : options.url.includes('/resourcefiles') ? { data: { resourceFile: [{ name: 'payments spec.yaml' }] } } : { data: ['test env'] });
    await expect(client.listApigeeEnvironments('sample-project-123')).resolves.toEqual(['test env']);
    await expect(client.listApigeeEnvironmentOasFiles('sample-project-123', 'test env')).resolves.toEqual(['payments spec.yaml']);
    await client.getApigeeEnvironmentOasFile('sample-project-123', 'test env', 'payments spec.yaml');
    expect(request.mock.calls.map((call) => call[0].url)).toEqual([
      'https://apigee.googleapis.com/v1/organizations/sample-project-123/environments',
      'https://apigee.googleapis.com/v1/organizations/sample-project-123/environments/test%20env/resourcefiles?type=oas',
      'https://apigee.googleapis.com/v1/organizations/sample-project-123/environments/test%20env/resourcefiles/oas/payments%20spec.yaml'
    ]);
  });

  it('lists connector connections and posts schema metadata retrieval', async () => {
    const connection = 'projects/sample-project-123/locations/us-central1/connections/salesforce';
    const { client, request } = clientWith(async (options) => {
      if (options.url.includes('/locations?')) return { data: { locations: [{ locationId: 'us-central1' }] } };
      if (options.url.includes('/connections?')) return { data: { connections: [{ name: connection }] } };
      return { data: { entities: { Account: { fields: [] } } } };
    });
    await expect(client.listConnectorConnections('sample-project-123')).resolves.toEqual([{ name: connection }]);
    await expect(client.getConnectorSchemaMetadata(connection)).resolves.toMatchObject({ entities: { Account: {} } });
    expect(request.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `https://connectors.googleapis.com/v1/${connection}:getConnectionSchemaMetadata`, method: 'POST', data: {} })
    ]));
  });

  it('regionalizes Vertex Extensions and Dialogflow agents and tools', async () => {
    const { client, request } = clientWith(async (options) => {
      if (options.url.endsWith('/locations?pageSize=200')) return { data: { locations: [{ locationId: 'global' }, { locationId: 'europe-west1' }] } };
      return { data: {} };
    });
    await client.listVertexExtensions('sample-project-123', 'europe-west1');
    await client.listDialogflowAgents('sample-project-123');
    await client.listDialogflowTools('projects/sample-project-123/locations/europe-west1/agents/support');
    const urls = request.mock.calls.map((call) => call[0].url);
    expect(urls).toContain('https://europe-west1-aiplatform.googleapis.com/v1/projects/sample-project-123/locations/europe-west1/extensions?pageSize=1000');
    expect(urls).toContain('https://dialogflow.googleapis.com/v1/projects/sample-project-123/locations/global/agents?pageSize=1000');
    expect(urls).toContain('https://europe-west1-dialogflow.googleapis.com/v1/projects/sample-project-123/locations/europe-west1/agents?pageSize=1000');
    expect(urls).toContain('https://europe-west1-dialogflow.googleapis.com/v1/projects/sample-project-123/locations/europe-west1/agents/support/tools?pageSize=1000');
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
      'https://dialogflow.googleapis.com/v1/projects/sample-project-123/locations?pageSize=200',
      'https://dialogflow.googleapis.com/v1/projects/sample-project-123/locations?pageSize=200&pageToken=locations-2',
      'https://dialogflow.googleapis.com/v1/projects/sample-project-123/locations/global/agents?pageSize=1000',
      'https://europe-west1-dialogflow.googleapis.com/v1/projects/sample-project-123/locations/europe-west1/agents?pageSize=1000'
    ]));
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
});
