import { TextDecoder } from 'node:util';
import type { ProviderProbeStatus } from '../../contracts.js';
import type { GcpDiscoveryClient } from '../gcp/clients.js';
import { inflateZip } from '../gcp/zip.js';
import { probeFailureStatus } from './probe.js';
import { decodeUtf8OpenApi, type DecodedSourceDocument } from './source-document.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const PATTERN = /^organizations\/([^/]+)\/apis\/([^/]+)\/revisions\/([^/]+)$/;

export function parseApigeeRevisionName(value: string): { org: string; proxyName: string; revision: string } | undefined {
  const match = PATTERN.exec(value);
  return match ? { org: match[1]!, proxyName: match[2]!, revision: match[3]! } : undefined;
}

function documents(bundle: Buffer): Array<{ path: string; decoded: DecodedSourceDocument }> {
  const result: Array<{ path: string; decoded: DecodedSourceDocument }> = [];
  for (const [path, bytes] of inflateZip(bundle)) {
    if (!/^apiproxy\/resources\/(?:oas|openapi)\//i.test(path) && !/^apiproxy\/resources\/.*\.(?:json|ya?ml)$/i.test(path)) continue;
    try { result.push({ path, decoded: decodeUtf8OpenApi(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }); } catch { /* not OpenAPI */ }
  }
  return result;
}

export class ApigeeProvider implements SpecProvider {
  public readonly type = 'apigee' as const;
  public constructor(private readonly client: GcpDiscoveryClient, private readonly scope: { projectId: string; apiId?: string }) {}
  public async probe(): Promise<ProviderProbeStatus> { try { await this.client.probeApigee(this.scope.projectId); return 'available'; } catch (error) { return probeFailureStatus(error); } }
  public async listCandidates(): Promise<SpecCandidate[]> {
    const explicit = this.scope.apiId ? parseApigeeRevisionName(this.scope.apiId) : undefined;
    if (this.scope.apiId && !explicit) return [];
    if (explicit && explicit.org !== this.scope.projectId) throw new Error('api-id Apigee revision does not belong to the configured project-id org');
    const revisions = explicit ? [{ proxyName: explicit.proxyName, revision: explicit.revision }] : await this.latestRevisions();
    return Promise.all(revisions.map(async ({ proxyName, revision }) => {
      const id = `organizations/${this.scope.projectId}/apis/${proxyName}/revisions/${revision}`;
      const count = documents(await this.client.downloadApigeeRevisionBundle(this.scope.projectId, proxyName, revision)).length;
      const evidence = count === 1 ? [`Apigee proxy revision has one OpenAPI source document`] : count === 0 ? ['Apigee proxy revision has no OpenAPI source document'] : [`Apigee proxy revision has ${count} OpenAPI source documents; refusing to merge or guess`];
      return { id, name: proxyName, providerType: this.type, apiId: id, projectId: this.scope.projectId, tags: {}, supported: count === 1, evidence, meta: { proxyName, revision } };
    }));
  }
  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const parsed = parseApigeeRevisionName(candidate.id);
    if (!parsed || parsed.org !== this.scope.projectId) throw new Error('Apigee candidate has an invalid revision resource name');
    const found = documents(await this.client.downloadApigeeRevisionBundle(parsed.org, parsed.proxyName, parsed.revision));
    if (found.length !== 1) throw new Error(found.length ? `Apigee proxy revision has ${found.length} OpenAPI source documents; refusing to merge or guess` : 'Apigee proxy revision has no OpenAPI source document');
    return { ...found[0]!.decoded, evidence: [`Exported original Apigee source ${found[0]!.path}`] };
  }
  private async latestRevisions(): Promise<Array<{ proxyName: string; revision: string }>> {
    const result: Array<{ proxyName: string; revision: string }> = [];
    for (const proxy of await this.client.listApigeeProxies(this.scope.projectId)) {
      const revision = (await this.client.listApigeeRevisions(this.scope.projectId, proxy.name)).filter((value) => /^\d+$/.test(value)).sort((a, b) => Number(b) - Number(a))[0];
      if (revision) result.push({ proxyName: proxy.name, revision });
    }
    return result;
  }
}
