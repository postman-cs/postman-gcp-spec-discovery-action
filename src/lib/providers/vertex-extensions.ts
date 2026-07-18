import type { ProviderProbeStatus } from '../../contracts.js';
import type { GcpDiscoveryClient, VertexExtensionSummary } from '../gcp/clients.js';
import { parseGcsSpecLocation } from './connectors-custom.js';
import { decodeUtf8OpenApi } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const PATTERN = /^projects\/([^/]+)\/locations\/([^/]+)\/extensions\/([^/]+)$/;
export function parseVertexExtensionName(value: string) {
  const match = PATTERN.exec(value);
  return match ? { projectId: match[1]!, location: match[2]!, extensionId: match[3]! } : undefined;
}

export class VertexExtensionsProvider implements SpecProvider {
  public readonly type = 'vertex-extensions' as const;
  public constructor(
    private readonly client: GcpDiscoveryClient,
    private readonly scope: { projectId: string; location?: string; apiId?: string }
  ) {}
  public async probe(): Promise<ProviderProbeStatus> {
    try {
      const locations = await this.locations();
      let failure: unknown;
      for (const location of locations) {
        try { await this.client.probeVertexExtensions(this.scope.projectId, location); return 'available'; }
        catch (error) { failure = error; }
      }
      return probeFailureStatus(failure ?? new Error('Vertex AI returned no locations'));
    } catch (error) {
      return probeFailureStatus(error);
    }
  }
  public async listCandidates(): Promise<SpecCandidate[]> {
    const parsed = this.scope.apiId ? parseVertexExtensionName(this.scope.apiId) : undefined;
    if (this.scope.apiId && !parsed) return [];
    if (parsed && parsed.projectId !== this.scope.projectId) throw new Error('api-id Vertex extension does not belong to configured project-id');
    const location = parsed?.location;
    const extensions = parsed
      ? [await this.findExplicit(this.scope.apiId!, location!)]
      : await this.listAllLocations();
    return extensions.map((extension) => this.toCandidate(extension));
  }
  private async locations(): Promise<string[]> {
    return this.scope.location && this.scope.location !== 'global'
      ? [this.scope.location]
      : this.client.listVertexLocations(this.scope.projectId);
  }
  private async listAllLocations(): Promise<VertexExtensionSummary[]> {
    const extensions: VertexExtensionSummary[] = [];
    for (const location of await this.locations()) {
      try { extensions.push(...await this.client.listVertexExtensions(this.scope.projectId, location)); }
      catch { /* Regional Vertex surfaces are probed fail-soft. */ }
    }
    return extensions;
  }
  private async findExplicit(id: string, location: string): Promise<VertexExtensionSummary> {
    const extensions = await this.client.listVertexExtensions(this.scope.projectId, location);
    return extensions.find((extension) => extension.name === id) ?? { name: id };
  }
  private toCandidate(extension: VertexExtensionSummary): SpecCandidate {
    const count = Number(Boolean(extension.openApiYaml?.trim())) + Number(Boolean(extension.openApiGcsUri));
    let supported = count === 1;
    if (extension.openApiYaml?.trim()) try { decodeUtf8OpenApi(extension.openApiYaml); } catch { supported = false; }
    if (extension.openApiGcsUri && !parseGcsSpecLocation(extension.openApiGcsUri)) supported = false;
    return { id: extension.name, apiId: extension.name, name: extension.displayName || extension.name.split('/').pop()!, providerType: this.type, projectId: this.scope.projectId, tags: {}, supported, evidence: [count === 0 ? 'Vertex extension manifest has no OpenAPI source' : count > 1 ? 'Vertex extension manifest has multiple OpenAPI sources' : 'Vertex extension manifest has one OpenAPI source'], meta: { openApiYaml: extension.openApiYaml ?? '', openApiGcsUri: extension.openApiGcsUri ?? '' } };
  }
  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    let text = candidate.meta.openApiYaml ?? '';
    const evidence = ['Exported original Vertex extension OpenAPI document'];
    if (!text) {
      const gcs = parseGcsSpecLocation(candidate.meta.openApiGcsUri ?? '');
      if (!gcs) throw new Error('Vertex extension has no supported OpenAPI source');
      text = await this.client.getStorageObjectText(gcs.bucket, gcs.object);
      evidence.push('Fetched Vertex extension OpenAPI source from [gs-object]');
    }
    return { ...decodeUtf8OpenApi(text), evidence };
  }
}
