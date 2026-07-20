import { describe, expect, it, vi } from 'vitest';

import { AppIntegrationProvider } from '../src/lib/providers/app-integration.js';
import type { AppIntegrationApiTrigger, GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const OAS = 'openapi: 3.0.0\ninfo:\n  title: Integration\n  version: "1"\npaths:\n  /run:\n    post:\n      responses:\n        "200":\n          description: ok\n';

function trigger(overrides: Partial<AppIntegrationApiTrigger> = {}): AppIntegrationApiTrigger {
  return {
    integrationResource: 'projects/sample-project-123/locations/us-central1/integrations/orders-api',
    location: 'us-central1',
    triggerIds: ['api_trigger/orders-api_API_1'],
    updateTime: '2026-07-01T00:00:00Z',
    ...overrides
  };
}

function client(overrides: Partial<GcpDiscoveryClient> = {}): GcpDiscoveryClient {
  return new Proxy({
    probeAppIntegration: vi.fn(),
    listAppIntegrationApiTriggers: vi.fn(async () => [trigger()]),
    generateAppIntegrationOpenApiSpec: vi.fn(async () => OAS),
    ...overrides
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(async () => []) }) as GcpDiscoveryClient;
}

describe('Application Integration provider', () => {
  it('GCP-APPINT-001: probes available and maps IAM failure to skipped:iam', async () => {
    await expect(new AppIntegrationProvider(client(), { projectId: 'sample-project-123' }).probe()).resolves.toBe('available');
    await expect(
      new AppIntegrationProvider(client({ probeAppIntegration: vi.fn(async () => { throw new Error('permission denied'); }) }), { projectId: 'sample-project-123' }).probe()
    ).resolves.toBe('skipped:iam');
  });

  it('GCP-APPINT-002: lists integrations with API triggers and generates the OpenAPI contract', async () => {
    const generate = vi.fn(async () => OAS);
    const provider = new AppIntegrationProvider(client({ generateAppIntegrationOpenApiSpec: generate }), { projectId: 'sample-project-123' });
    const candidates = await provider.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      providerType: 'app-integration',
      sourceType: 'app-integration-trigger',
      authority: 'google-generated',
      supported: true
    });
    const exported = await provider.exportSpec(candidates[0]!);
    expect(exported).toMatchObject({ format: 'openapi-yaml', filename: 'index.yaml' });
    expect(exported.evidence.join(' ')).toContain('generateOpenApiSpec');
    expect(generate).toHaveBeenCalledWith('us-central1', trigger().integrationResource, trigger().triggerIds);
  });

  it('GCP-APPINT-003: an explicit non-integration api-id yields no candidates', async () => {
    const provider = new AppIntegrationProvider(client(), {
      projectId: 'sample-project-123',
      apiId: 'projects/sample-project-123/locations/global/apis/payments/configs/v1'
    });
    await expect(provider.listCandidates()).resolves.toEqual([]);
  });
});
