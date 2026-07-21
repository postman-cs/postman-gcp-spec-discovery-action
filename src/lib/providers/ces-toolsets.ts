import type { ProviderProbeStatus, SourceAuthority } from '../../contracts.js';
import type { CesToolsetSummary, GcpDiscoveryClient } from '../gcp/clients.js';
import { decodeUtf8OpenApi } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

const PATTERN = /^projects\/([^/]+)\/locations\/global\/apps\/[^/]+\/(?:tools\/[^/]+|toolsets\/[^/]+(?:\/tools\/[^/]+)?)$/;

export class CesToolsetsProvider implements SpecProvider {
  public readonly type = 'ces-toolsets' as const;
  public constructor(private readonly client: GcpDiscoveryClient, private readonly scope: { projectId: string; apiId?: string }) {}
  public async probe(): Promise<ProviderProbeStatus> {
    try { await this.client.probeCes(this.scope.projectId); return 'available'; }
    catch (error) { return probeFailureStatus(error); }
  }
  public async listCandidates(): Promise<SpecCandidate[]> {
    const parsed = this.scope.apiId ? PATTERN.exec(this.scope.apiId) : undefined;
    if (this.scope.apiId && !parsed) return [];
    if (parsed?.[1] !== undefined && parsed[1] !== this.scope.projectId) throw new Error('api-id CES resource does not belong to configured project-id');
    let toolsets = await this.client.listCesToolsets(this.scope.projectId);
    if (this.scope.apiId) toolsets = toolsets.filter((toolset) => toolset.name === this.scope.apiId);
    return toolsets.map((toolset) => this.toCandidate(toolset));
  }
  private toCandidate(toolset: CesToolsetSummary): SpecCandidate {
    const schema = toolset.openApiSchema ?? '';
    const hasSchema = Boolean(schema.trim());
    const toolsetScopedTool = /\/toolsets\/[^/]+\/tools\/[^/]+$/.test(toolset.name);
    const standaloneTool = /\/apps\/[^/]+\/tools\/[^/]+$/.test(toolset.name);
    const resourceKind = toolsetScopedTool ? 'toolset-scoped tool' : standaloneTool ? 'tool' : 'toolset';
    let supported = hasSchema;
    let authority: SourceAuthority = hasSchema ? 'stored-authoritative' : 'metadata-only';
    if (hasSchema) {
      try { decodeUtf8OpenApi(schema); } catch { supported = false; authority = 'metadata-only'; }
    }
    return withAuthority({
      id: toolset.name,
      apiId: toolset.name,
      name: toolset.displayName || toolset.name.split('/').pop()!,
      providerType: this.type,
      sourceType: standaloneTool ? 'ces-tool-schema' : 'ces-toolset-schema',
      authority,
      projectId: this.scope.projectId,
      tags: {},
      supported,
      evidence: [hasSchema ? `CES ${resourceKind} stores an OpenAPI schema` : `CES ${resourceKind} has no OpenAPI schema`],
      meta: { openApiSchema: schema, resourceKind }
    });
  }
  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    return { ...decodeUtf8OpenApi(candidate.meta.openApiSchema ?? ''), evidence: [`Exported original CES ${candidate.meta.resourceKind ?? 'toolset'} OpenAPI schema`] };
  }
}
