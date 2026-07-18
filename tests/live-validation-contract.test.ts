import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEvidence, classifyProbeError, isResourceNotFoundError, parseFlags, requiredEnv, toEvidenceResult, verifyRemoteApigeeOwnership, verifyRemoteEndpointsOwnership, verifyRemoteGatewayOwnership } from '../validation/scripts/validate-live-gcp-surfaces.mjs';

describe('GCP live validation contract', () => {
  it('requires project and both destructive lifecycle flags', () => {
    expect(() => requiredEnv({})).toThrow(/GCP_PROJECT_ID is required/);
    expect(requiredEnv({ GCP_PROJECT_ID: 'sample-project' })).toEqual({ projectId: 'sample-project', location: 'global', apigeeOrg: 'sample-project', apigeeEnv: 'test-env' });
    expect(parseFlags([])).toEqual({ provision: false, teardown: false });
    expect(parseFlags(['--provision', '--teardown'])).toEqual({ provision: true, teardown: true });
  });

  it('deletes only exact current-run resources', () => {
    const manifest = { runId: '1234', runMarker: 'postman-1234', gatewayName: 'postman-live-1234', endpointsService: 'postman-live-1234.endpoints.p.cloud.goog', proxyName: 'postman-live-1234' };
    expect(verifyRemoteGatewayOwnership(manifest, { labels: { 'postman-run-marker': manifest.runMarker } })).toBe(true);
    expect(() => verifyRemoteGatewayOwnership(manifest, { labels: { 'postman-run-marker': 'foreign' } })).toThrow('REFUSING');
    expect(verifyRemoteEndpointsOwnership(manifest, manifest.endpointsService)).toBe(true);
    expect(() => verifyRemoteEndpointsOwnership(manifest, 'foreign')).toThrow('REFUSING');
    expect(verifyRemoteApigeeOwnership(manifest, { name: manifest.proxyName })).toBe(true);
    expect(() => verifyRemoteApigeeOwnership(manifest, { name: 'foreign' })).toThrow('REFUSING');
  });

  it('classifies GCP probe and absence errors', () => {
    expect(classifyProbeError('403 permission denied')).toBe('fatal');
    expect(classifyProbeError('400 invalid argument')).toBe('fatal');
    expect(classifyProbeError('404 not found')).toBe('retryable');
    expect(classifyProbeError('503 unavailable')).toBe('retryable');
    expect(isResourceNotFoundError(new Error('404 not found'))).toBe(true);
    expect(isResourceNotFoundError('resource does not exist')).toBe(true);
    expect(isResourceNotFoundError('permission denied')).toBe(false);
  });

  it('sanitizes evidence', () => {
    const result = toEvidenceResult('gateway-explicit-api-id', 'pass', { sourceType: 'api-gateway-config', providerType: 'api-gateway', specFormat: 'openapi-yaml', apiId: 'secret' } as never);
    expect(result).toEqual({ name: 'gateway-explicit-api-id', status: 'pass', sourceType: 'api-gateway-config', providerType: 'api-gateway', specFormat: 'openapi-yaml' });
    expect(buildEvidence([result])).toMatchObject({ cases: 1, passed: 1, failed: 0 });
  });

  it('committed evidence contains only eight GCP cases and matching totals', () => {
    const root = process.cwd();
    const raw = readFileSync(join(root, 'validation/evidence/live-gcp-surfaces.json'), 'utf8');
    const evidence = JSON.parse(raw);
    expect(evidence.results).toHaveLength(8);
    expect(evidence.passed + evidence.failed).toBe(evidence.cases);
    expect(evidence.results.map((result: { name: string }) => result.name)).toEqual(['gateway-explicit-api-id', 'gateway-discovery', 'endpoints-explicit-api-id', 'endpoints-discovery', 'apigee-discovery', 'discover-many', 'iac-single', 'ambiguity']);
    expect(raw).not.toMatch(/https?:\/\/|Bearer |projectNumber|specBody/i);
    expect(readFileSync(join(root, 'validation/evidence/README.md'), 'utf8')).toContain('latest credentialed live run');
  });
});
