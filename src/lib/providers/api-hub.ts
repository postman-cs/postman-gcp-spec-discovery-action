import type { ProviderProbeStatus, SourceAuthority, SourceType } from '../../contracts.js';
import {
  type ApiHubAdditionalSpecContentType,
  type ApiHubSpecSummary,
  type GcpDiscoveryClient
} from '../gcp/clients.js';
import { decodeSourceDocument, decodeUtf8OpenApi } from './source-document.js';
import { parseGcsSpecLocation } from './connectors-custom.js';
import { probeFailureStatus } from './probe.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

const SPEC_PATTERN = /^projects\/([^/]+)\/locations\/([^/]+)\/apis\/([^/]+)\/versions\/([^/]+)\/specs\/([^/]+)$/;
const ADDITIONAL_VARIANT_PATTERN = /^(projects\/[^/]+\/locations\/[^/]+\/apis\/[^/]+\/versions\/[^/]+\/specs\/[^/]+)#(BOOSTED_SPEC_CONTENT|GATEWAY_OPEN_API_SPEC)$/;

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

/**
 * Explicit selector for Google-generated API Hub additional content.
 * Form: `{specResourceName}#BOOSTED_SPEC_CONTENT` or `#GATEWAY_OPEN_API_SPEC`.
 * Never collapses to the stored original `:contents` candidate.
 */
export function parseApiHubAdditionalSpecName(value: string): {
  projectId: string;
  location: string;
  apiName: string;
  versionId: string;
  specId: string;
  specName: string;
  contentType: ApiHubAdditionalSpecContentType;
} | undefined {
  const match = ADDITIONAL_VARIANT_PATTERN.exec(value);
  if (!match) return undefined;
  const specName = match[1]!;
  const contentType = match[2]! as ApiHubAdditionalSpecContentType;
  const parsed = parseApiHubSpecName(specName);
  if (!parsed) return undefined;
  return { ...parsed, specName, contentType };
}

function shortName(value: string): string {
  return value.split('/').pop() ?? value;
}

function additionalSourceType(type: ApiHubAdditionalSpecContentType): SourceType {
  return type === 'BOOSTED_SPEC_CONTENT' ? 'api-hub-boosted-spec' : 'api-hub-gateway-openapi-spec';
}

function supportEvidence(spec: ApiHubSpecSummary): { supported: boolean; authority: SourceAuthority; evidence: string[] } {
  const specTypes = spec.specTypeIds;
  const evidence = [
    `API Hub spec ${shortName(spec.name)} declares type ${specTypes.length > 0 ? specTypes.join(',') : 'unspecified'}`
  ];
  if (specTypes.length > 0 && !specTypes.some((id) => /openapi|oas|swagger/i.test(id))) {
    return {
      supported: false,
      authority: 'unsupported-format',
      evidence: [...evidence, 'Only OpenAPI-typed API Hub specs are exportable in v1.0.0']
    };
  }
  return { supported: true, authority: 'stored-authoritative', evidence };
}

/**
 * API Hub is the GCP consolidation layer: it stores verbatim OpenAPI documents
 * registered manually or ingested from Apigee and API Gateway plugins. The
 * provider walks apis -> versions -> specs in the hub's provisioned location
 * and exports spec bytes via specs:contents. Additional Google-generated
 * representations (boosted / gateway OpenAPI) are emitted as distinct
 * google-generated candidates and never replace original bytes.
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
    const additional = this.scope.apiId ? parseApiHubAdditionalSpecName(this.scope.apiId) : undefined;
    if (additional) {
      if (additional.projectId !== this.scope.projectId) {
        throw new Error('api-id must belong to the configured project-id API Hub instance');
      }
      const spec = await this.client.getApiHubSpec(additional.specName);
      return this.candidatesForAdditionalVariant(spec, additional.contentType);
    }
    const explicit = this.scope.apiId ? parseApiHubSpecName(this.scope.apiId) : undefined;
    if (explicit) {
      if (explicit.projectId !== this.scope.projectId) {
        throw new Error('api-id must belong to the configured project-id API Hub instance');
      }
      const spec = await this.client.getApiHubSpec(this.scope.apiId!);
      // Explicit original selector: only the stored authoritative candidate.
      return [this.toOriginalCandidate(spec)];
    }
    if (this.scope.apiId) return [];

    const specs = await this.client.listApiHubSpecs(this.scope.projectId);
    const candidates: SpecCandidate[] = [];
    for (const spec of specs) {
      candidates.push(...(await this.candidatesForSpec(spec)));
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const contentType = candidate.meta.specContentType;
    const specName = candidate.meta.specName || candidate.id.split('#')[0]!;
    if (contentType === 'BOOSTED_SPEC_CONTENT' || contentType === 'GATEWAY_OPEN_API_SPEC') {
      const contents = await this.client.fetchApiHubAdditionalSpecContent(specName, contentType);
      if (!contents.contents) throw new Error(`API Hub additional ${contentType} is absent`);
      return {
        ...decodeSourceDocument(contents.contents),
        evidence: [
          `Exported API Hub additional ${contentType} for ${shortName(specName)}`,
          'Google-generated additional content never replaces original stored :contents bytes'
        ]
      };
    }

    const contents = await this.client.getApiHubSpecContents(specName);
    let decoded;
    const evidence = [`Exported API Hub spec contents for ${shortName(specName)}`];
    if (contents.contents) {
      decoded = decodeSourceDocument(contents.contents);
    } else {
      const gcs = parseGcsSpecLocation(candidate.meta.sourceUri ?? '');
      if (!gcs) {
        throw new Error('API Hub spec contents are absent and sourceUri is not a trusted gs:// object reference');
      }
      decoded = decodeUtf8OpenApi(await this.client.getStorageObjectText(gcs.bucket, gcs.object));
      evidence.push('Fetched original spec bytes from registered Cloud Storage source_uri');
    }
    return { ...decoded, evidence };
  }

  private async candidatesForSpec(spec: ApiHubSpecSummary): Promise<SpecCandidate[]> {
    const original = this.toOriginalCandidate(spec);
    const result: SpecCandidate[] = [original];
    if (!original.supported) return result;

    const types = spec.additionalSpecContentTypes ?? [];
    for (const type of types) {
      result.push(...(await this.candidatesForAdditionalVariant(spec, type, { includeOriginalBytesGuard: true })));
    }
    return result;
  }

  /**
   * Build only the additional-content candidate for an explicit `#VARIANT` selector.
   * Never returns the stored original, so generated content cannot overwrite it.
   */
  private async candidatesForAdditionalVariant(
    spec: ApiHubSpecSummary,
    type: ApiHubAdditionalSpecContentType,
    options: { includeOriginalBytesGuard?: boolean } = {}
  ): Promise<SpecCandidate[]> {
    const originalSupport = supportEvidence(spec);
    if (!originalSupport.supported) {
      return [
        this.toAdditionalCandidate(spec, type, {
          supported: false,
          authority: 'unsupported-format',
          evidence: [...originalSupport.evidence, `API Hub additional ${type} requires an OpenAPI-typed base spec`]
        })
      ];
    }

    let originalContents: string | undefined;
    if (options.includeOriginalBytesGuard) {
      try {
        originalContents = (await this.client.getApiHubSpecContents(spec.name)).contents;
      } catch {
        originalContents = undefined;
      }
    }

    try {
      const fetched = await this.client.fetchApiHubAdditionalSpecContent(spec.name, type);
      if (!fetched.contents) {
        return [
          this.toAdditionalCandidate(spec, type, {
            supported: false,
            authority: 'metadata-only',
            evidence: [`API Hub additional ${type} is absent`]
          })
        ];
      }
      try {
        decodeSourceDocument(fetched.contents);
      } catch {
        return [
          this.toAdditionalCandidate(spec, type, {
            supported: false,
            authority: 'unsupported-format',
            evidence: [`API Hub additional ${type} is not valid OpenAPI`]
          })
        ];
      }
      if (originalContents !== undefined && fetched.contents === originalContents) {
        // Duplicate of stored original — ignore rather than emit a second identical candidate.
        return [];
      }
      return [
        this.toAdditionalCandidate(spec, type, {
          supported: true,
          authority: 'google-generated',
          evidence: [
            `API Hub ${type} is a Google-generated OpenAPI representation`,
            'Stored original :contents remains authoritative and ranks first'
          ]
        })
      ];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return [
        this.toAdditionalCandidate(spec, type, {
          supported: false,
          authority: 'metadata-only',
          evidence: [`API Hub additional ${type} fetch failed: ${detail}`]
        })
      ];
    }
  }

  private toOriginalCandidate(spec: ApiHubSpecSummary): SpecCandidate {
    const support = supportEvidence(spec);
    return withAuthority({
      id: spec.name,
      name: spec.displayName || spec.apiDisplayName || shortName(spec.name),
      providerType: this.type,
      sourceType: 'api-hub-spec',
      authority: support.authority,
      apiId: spec.name,
      projectId: this.scope.projectId,
      tags: spec.attributes,
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        apiName: spec.name.split('/versions/')[0] ?? spec.name,
        versionId: spec.name.split('/versions/')[1]?.split('/')[0] ?? '',
        specId: shortName(spec.name),
        createTime: spec.createTime ?? '',
        sourceUri: spec.sourceUri ?? '',
        specName: spec.name
      }
    });
  }

  private toAdditionalCandidate(
    spec: ApiHubSpecSummary,
    type: ApiHubAdditionalSpecContentType,
    support: { supported: boolean; authority: SourceAuthority; evidence: string[] }
  ): SpecCandidate {
    return withAuthority({
      id: `${spec.name}#${type}`,
      name: `${spec.displayName || spec.apiDisplayName || shortName(spec.name)} (${type})`,
      providerType: this.type,
      sourceType: additionalSourceType(type),
      authority: support.authority,
      apiId: `${spec.name}#${type}`,
      projectId: this.scope.projectId,
      tags: spec.attributes,
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        apiName: spec.name.split('/versions/')[0] ?? spec.name,
        versionId: spec.name.split('/versions/')[1]?.split('/')[0] ?? '',
        specId: shortName(spec.name),
        createTime: spec.createTime ?? '',
        sourceUri: spec.sourceUri ?? '',
        specName: spec.name,
        specContentType: type
      }
    });
  }
}
