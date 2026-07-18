import type { ProviderProbeStatus } from '../../contracts.js';
import type { CustomConnectorVersionSummary, GcpDiscoveryClient } from '../gcp/clients.js';
import { decodeUtf8OpenApi } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const GCS_PATTERN = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])\/(.+)$/;

export interface ConnectorsCustomScope {
  projectId: string;
  apiId?: string;
}

export function parseGcsSpecLocation(value: string): { bucket: string; object: string } | undefined {
  const match = GCS_PATTERN.exec(value);
  return match ? { bucket: match[1]!, object: match[2]! } : undefined;
}

function shortName(value: string): string {
  return value.split('/').pop() ?? value;
}

/**
 * Integration Connectors custom connectors are defined BY an OpenAPI document:
 * each custom connector version records specLocation pointing at the exact
 * spec it was built from. gs:// locations are fetched through the authenticated
 * Cloud Storage JSON API; arbitrary https URLs are surfaced as unsupported
 * candidates because v1 never fetches non-GCP remote URLs.
 */
export class ConnectorsCustomProvider implements SpecProvider {
  public readonly type = 'connectors-custom' as const;

  public constructor(
    private readonly client: GcpDiscoveryClient,
    private readonly scope: ConnectorsCustomScope
  ) {}

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeConnectors(this.scope.projectId);
      return 'available';
    } catch (error) {
      return probeFailureStatus(error);
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    if (this.scope.apiId) return [];
    const versions = await this.client.listCustomConnectorVersions(this.scope.projectId);
    const candidates = versions.map((version) => this.toCandidate(version));
    for (const connection of await this.client.listConnectorConnections(this.scope.projectId)) {
      const schema = await this.client.getConnectorSchemaMetadata(connection.name);
      if (!schema) continue;
      const document = JSON.stringify(schemaToOpenApi(connection.name, schema));
      candidates.push({ id: connection.name, apiId: connection.name, name: shortName(connection.name), providerType: this.type, sourceType: 'connectors-generated-spec', projectId: this.scope.projectId, tags: {}, supported: true, evidence: ['OpenAPI generated from connector schema metadata; confidence is lower than stored specification sources'], meta: { generatedOpenApi: document } });
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    if (candidate.sourceType === 'connectors-generated-spec') {
      return { ...decodeUtf8OpenApi(candidate.meta.generatedOpenApi ?? ''), evidence: ['OpenAPI generated from connector schema metadata'] };
    }
    const location = candidate.meta.specLocation ?? '';
    const gcs = parseGcsSpecLocation(location);
    if (!gcs) throw new Error('Custom connector specLocation is not a gs:// object; v1.0.0 does not fetch remote URLs');
    const content = await this.client.getStorageObjectText(gcs.bucket, gcs.object);
    const decoded = decodeUtf8OpenApi(content);
    return {
      ...decoded,
      evidence: ['Fetched custom connector source spec from [gs-object]']
    };
  }

  private toCandidate(version: CustomConnectorVersionSummary): SpecCandidate {
    const specLocation = version.specLocation ?? '';
    const gcs = parseGcsSpecLocation(specLocation);
    const evidence = [`Custom connector version ${shortName(version.name)} records specLocation ${gcs ? '[gs-object]' : specLocation || '(none)'}`];
    let supported = true;
    if (!specLocation) {
      supported = false;
      evidence.push('Custom connector version has no specLocation');
    } else if (!gcs) {
      supported = false;
      evidence.push('Only gs:// specLocation objects are fetched in v1.0.0; remote URLs are manual review');
    }
    return {
      id: version.name,
      name: version.name.split('/customConnectors/')[1]?.split('/')[0] ?? shortName(version.name),
      providerType: this.type,
      projectId: this.scope.projectId,
      tags: version.labels,
      supported,
      evidence,
      meta: {
        specLocation,
        connectorName: version.name.split('/customConnectorVersions/')[0] ?? version.name,
        versionId: shortName(version.name),
        updateTime: version.updateTime ?? ''
      }
    };
  }
}

function schemaToOpenApi(connectionName: string, schema: import('../gcp/clients.js').ConnectorSchemaMetadata): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const [entity, metadata] of Object.entries(schema.entities ?? {})) {
    const properties = Object.fromEntries((metadata.fields ?? []).filter((field) => field.name).map((field) => [field.name!, { type: connectorType(field.dataType), ...(field.description ? { description: field.description } : {}) }]));
    paths[`/${entity}`] = { get: { operationId: `list_${entity}`, responses: { '200': { description: 'Connector schema-derived response', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties } } } } } } } };
  }
  for (const action of schema.actions ?? []) if (action.name) paths[`/actions/${action.name}`] = { post: { operationId: action.name, description: action.description, responses: { '200': { description: 'Connector action response' } } } };
  return { openapi: '3.0.3', info: { title: `${shortName(connectionName)} connector`, version: 'generated', description: 'Generated from connector schema metadata' }, paths };
}

function connectorType(value?: string): string {
  if (/bool/i.test(value ?? '')) return 'boolean';
  if (/int|number|decimal|double|float/i.test(value ?? '')) return 'number';
  if (/array|list/i.test(value ?? '')) return 'array';
  if (/object|json|struct/i.test(value ?? '')) return 'object';
  return 'string';
}
