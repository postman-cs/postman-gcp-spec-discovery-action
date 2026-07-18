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
});
