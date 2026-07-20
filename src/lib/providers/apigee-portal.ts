import type { ProviderProbeStatus, SourceAuthority } from '../../contracts.js';
import type { ApigeePortalApidoc, GcpDiscoveryClient } from '../gcp/clients.js';
import { decodeUtf8OpenApi } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

const PATTERN = /^organizations\/([^/]+)\/sites\/([^/]+)\/apidocs\/([^/]+)$/;

export function parseApigeePortalApidocName(value: string) {
  const m = PATTERN.exec(value);
  return m ? { org: m[1]!, siteId: m[2]!, apidocId: m[3]! } : undefined;
}

export class ApigeePortalProvider implements SpecProvider {
  public readonly type = 'apigee-portal' as const;
  public constructor(private readonly client: GcpDiscoveryClient, private readonly scope: { projectId: string; apiId?: string }) {}
  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeApigeePortal(this.scope.projectId);
      return 'available';
    } catch (error) {
      return probeFailureStatus(error);
    }
  }
  public async listCandidates(): Promise<SpecCandidate[]> {
    const explicit = this.scope.apiId ? parseApigeePortalApidocName(this.scope.apiId) : undefined;
    if (this.scope.apiId && !explicit) return [];
    if (explicit?.org !== undefined && explicit.org !== this.scope.projectId) {
      throw new Error('api-id Apigee portal document does not belong to the configured project-id org');
    }
    const docs: Array<{ siteId: string; doc: ApigeePortalApidoc }> = [];
    if (explicit) docs.push({ siteId: explicit.siteId, doc: { id: explicit.apidocId } });
    else {
      for (const site of await this.client.listApigeePortalSites(this.scope.projectId)) {
        for (const doc of await this.client.listApigeePortalApidocs(this.scope.projectId, site.id)) {
          docs.push({ siteId: site.id, doc });
        }
      }
    }
    return Promise.all(docs.map(async ({ siteId, doc }) => {
      const id = `organizations/${this.scope.projectId}/sites/${siteId}/apidocs/${doc.id}`;
      const found = await this.client.getApigeePortalDocumentation(this.scope.projectId, siteId, doc.id);
      let supported = false;
      let authority: SourceAuthority = found.type === 'oasDocumentation' ? 'metadata-only' : 'unsupported-format';
      if (found.type === 'oasDocumentation' && found.contents?.trim()) {
        try {
          decodeUtf8OpenApi(found.contents);
          supported = true;
          authority = 'stored-authoritative';
        } catch {
          supported = false;
          authority = 'metadata-only';
        }
      }
      return withAuthority({
        id,
        apiId: id,
        name: doc.title || doc.id,
        providerType: this.type,
        sourceType: 'apigee-portal-doc',
        authority,
        projectId: this.scope.projectId,
        tags: {},
        supported,
        evidence: [`Apigee portal documentation type: ${found.type}`],
        meta: { siteId, apidocId: doc.id, documentationType: found.type }
      });
    }));
  }
  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const p = parseApigeePortalApidocName(candidate.id);
    if (!p || p.org !== this.scope.projectId) throw new Error('Invalid Apigee portal document resource name');
    const doc = await this.client.getApigeePortalDocumentation(p.org, p.siteId, p.apidocId);
    if (doc.type !== 'oasDocumentation' || !doc.contents?.trim()) {
      throw new Error(`Apigee portal documentation type ${doc.type} is unsupported`);
    }
    return { ...decodeUtf8OpenApi(doc.contents), evidence: ['Exported original Apigee portal OpenAPI documentation'] };
  }
}
