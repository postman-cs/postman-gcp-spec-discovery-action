import type { ProviderProbeStatus } from '../../contracts.js';
import type { ApiHubSpecSummary, GcpDiscoveryClient } from '../gcp/clients.js';
import { decodeSourceDocument, decodeUtf8OpenApi } from './source-document.js';
import { parseGcsSpecLocation } from './connectors-custom.js';
import { probeFailureStatus } from './probe.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const SPEC_PATTERN = /^projects\/([^/]+)\/locations\/([^/]+)\/apis\/([^/]+)\/versions\/([^/]+)\/specs\/([^/]+)$/;

export interface ApiHubScope {
  projectId: string;
  apiId?: string;
}

export function parseApiHubSpecName(value: string): {
  projectId: string;
  location: string;
  apiName: string;
  versionId: string;
  specId: string;
} | undefined {
  const match = SPEC_PATTERN.exec(value);
  return match
    ? { projectId: match[1]!, location: match[2]!, apiName: match[3]!, versionId: match[4]!, specId: match[5]! }
    : undefined;
}

function shortName(value: string): string {
  return value.split('/').pop() ?? value;
}

function supportEvidence(spec: ApiHubSpecSummary): { supported: boolean; evidence: string[] } {
  const specTypes = spec.specTypeIds;
  const evidence = [
    `API Hub spec ${shortName(spec.name)} declares type ${specTypes.length > 0 ? specTypes.join(',') : 'unspecified'}`
  ];
  if (specTypes.length > 0 && !specTypes.some((id) => /openapi|oas|swagger/i.test(id))) {
    return {
      supported: false,
      evidence: [...evidence, 'Only OpenAPI-typed API Hub specs are exportable in v1.0.0']
    };
  }
  return { supported: true, evidence };
}

/**
 * API Hub is the GCP consolidation layer: it stores verbatim OpenAPI documents
 * registered manually or ingested from Apigee and API Gateway plugins. The
 * provider walks apis -> versions -> specs in the hub's provisioned location
 * and exports spec bytes via specs:contents. Non-OpenAPI spec types (proto,
 * WSDL, MCP) surface as unsupported candidates for manual review.
 */
export class ApiHubProvider implements SpecProvider {
  public readonly type = 'api-hub' as const;

  public constructor(
    private readonly client: GcpDiscoveryClient,
    private readonly scope: ApiHubScope
  ) {}

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeApiHub(this.scope.projectId);
      return 'available';
    } catch (error) {
      return probeFailureStatus(error);
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const explicit = this.scope.apiId ? parseApiHubSpecName(this.scope.apiId) : undefined;
    if (explicit) {
      if (explicit.projectId !== this.scope.projectId) {
        throw new Error('api-id must belong to the configured project-id API Hub instance');
      }
      const spec = await this.client.getApiHubSpec(this.scope.apiId!);
      return [this.toCandidate(spec)];
    }
    if (this.scope.apiId) return [];

    const specs = await this.client.listApiHubSpecs(this.scope.projectId);
    return specs.map((spec) => this.toCandidate(spec));
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const contents = await this.client.getApiHubSpecContents(candidate.id);
    let decoded;
    const evidence = [`Exported API Hub spec contents for ${shortName(candidate.id)}`];
    if (contents.contents) decoded = decodeSourceDocument(contents.contents);
    else { const gcs = parseGcsSpecLocation(candidate.meta.sourceUri ?? ''); if (!gcs) return { ...decodeSourceDocument(contents.contents), evidence }; decoded = decodeUtf8OpenApi(await this.client.getStorageObjectText(gcs.bucket, gcs.object)); evidence.push('Fetched original spec bytes from registered Cloud Storage source_uri'); }
    return {
      ...decoded,
      evidence
    };
  }

  private toCandidate(spec: ApiHubSpecSummary): SpecCandidate {
    const support = supportEvidence(spec);
    return {
      id: spec.name,
      name: spec.displayName || spec.apiDisplayName || shortName(spec.name),
      providerType: this.type,
      apiId: spec.name,
      projectId: this.scope.projectId,
      tags: spec.attributes,
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        apiName: spec.name.split('/versions/')[0] ?? spec.name,
        versionId: spec.name.split('/versions/')[1]?.split('/')[0] ?? '',
        specId: shortName(spec.name),
        createTime: spec.createTime ?? '', sourceUri: spec.sourceUri ?? ''
      }
    };
  }
}
