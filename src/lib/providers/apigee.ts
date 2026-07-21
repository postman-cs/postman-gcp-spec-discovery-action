import { TextDecoder } from 'node:util';

import type { ProviderProbeStatus } from '../../contracts.js';
import type { ApigeeArchiveDeploymentSummary, GcpDiscoveryClient } from '../gcp/clients.js';
import { inflateZip } from '../gcp/zip.js';
import { probeFailureStatus } from './probe.js';
import { decodeUtf8NativeFamily, decodeUtf8OpenApi, type DecodedSourceDocument } from './source-document.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

const REVISION_PATTERN = /^organizations\/([^/]+)\/apis\/([^/]+)\/revisions\/([^/]+)$/;
const ARCHIVE_PATTERN = /^organizations\/([^/]+)\/environments\/([^/]+)\/archiveDeployments\/([^/]+)$/;

/** Documented OpenAPI resource seams on proxy revision bundles. */
const PROXY_OPENAPI_PATH = /^apiproxy\/resources\/(?:oas|openapi)\//i;
/** Documented WSDL resource seam on proxy revision bundles. */
const PROXY_WSDL_PATH = /^apiproxy\/resources\/wsdl\//i;

export function parseApigeeRevisionName(value: string): { org: string; proxyName: string; revision: string } | undefined {
  const match = REVISION_PATTERN.exec(value);
  return match ? { org: match[1]!, proxyName: match[2]!, revision: match[3]! } : undefined;
}

export function parseApigeeArchiveDeploymentName(value: string): {
  org: string;
  environment: string;
  archiveDeploymentId: string;
} | undefined {
  const match = ARCHIVE_PATTERN.exec(value);
  return match ? { org: match[1]!, environment: match[2]!, archiveDeploymentId: match[3]! } : undefined;
}

function isUnsafeZipEntryName(name: string): boolean {
  if (!name || name.includes('\0')) return true;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split('/').some((segment) => segment === '..');
}

function decodeUtf8Text(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Auto-resolve only documented contract locations:
 * - apiproxy/resources/oas|openapi → OpenAPI
 * - apiproxy/resources/wsdl → WSDL
 * Unrelated resource JSON that merely parses as OpenAPI is not authoritative.
 */
function proxyDocuments(bundle: Buffer): Array<{ path: string; decoded: DecodedSourceDocument }> {
  const result: Array<{ path: string; decoded: DecodedSourceDocument }> = [];
  for (const [path, bytes] of inflateZip(bundle)) {
    if (PROXY_OPENAPI_PATH.test(path)) {
      try {
        result.push({ path, decoded: decodeUtf8OpenApi(decodeUtf8Text(bytes)) });
      } catch {
        /* not OpenAPI */
      }
      continue;
    }
    if (PROXY_WSDL_PATH.test(path)) {
      try {
        result.push({ path, decoded: decodeUtf8NativeFamily(decodeUtf8Text(bytes), 'wsdl') });
      } catch {
        /* not WSDL */
      }
    }
  }
  return result;
}

function archiveDocuments(bundle: Buffer): Array<{ path: string; decoded: DecodedSourceDocument }> {
  const result: Array<{ path: string; decoded: DecodedSourceDocument }> = [];
  for (const [path, bytes] of inflateZip(bundle)) {
    if (isUnsafeZipEntryName(path)) {
      throw new Error('Apigee archive deployment zip contains an unsafe entry name');
    }
    if (path.endsWith('/') || !/\.(?:json|ya?ml)$/i.test(path)) continue;
    try {
      result.push({ path, decoded: decodeUtf8OpenApi(decodeUtf8Text(bytes)) });
    } catch {
      /* not OpenAPI */
    }
  }
  return result;
}

function documentCountEvidence(kind: 'proxy revision' | 'archive deployment', count: number): string[] {
  if (count === 1) return [`Apigee ${kind} has one contract source document`];
  if (count === 0) return [`Apigee ${kind} has no contract source document`];
  return [`Apigee ${kind} has ${count} contract source documents; refusing to merge or guess`];
}

export class ApigeeProvider implements SpecProvider {
  public readonly type = 'apigee' as const;

  public constructor(
    private readonly client: GcpDiscoveryClient,
    private readonly scope: { projectId: string; apiId?: string }
  ) {}

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeApigee(this.scope.projectId);
      return 'available';
    } catch (error) {
      return probeFailureStatus(error);
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const archiveExplicit = this.scope.apiId ? parseApigeeArchiveDeploymentName(this.scope.apiId) : undefined;
    const revisionExplicit = this.scope.apiId ? parseApigeeRevisionName(this.scope.apiId) : undefined;
    if (this.scope.apiId && !archiveExplicit && !revisionExplicit) return [];

    if (archiveExplicit) {
      if (archiveExplicit.org !== this.scope.projectId) {
        throw new Error('api-id Apigee archive deployment does not belong to the configured project-id org');
      }
      return [
        await this.toArchiveCandidate({
          name: this.scope.apiId!,
          labels: {},
          createdAt: undefined,
          updatedAt: undefined
        })
      ];
    }

    const revisions = revisionExplicit
      ? [{ proxyName: revisionExplicit.proxyName, revision: revisionExplicit.revision, labels: {} as Record<string, string> }]
      : await this.latestRevisions();
    if (revisionExplicit && revisionExplicit.org !== this.scope.projectId) {
      throw new Error('api-id Apigee revision does not belong to the configured project-id org');
    }

    const proxyCandidates = await Promise.all(
      revisions.map(async ({ proxyName, revision, labels }) => {
        const id = `organizations/${this.scope.projectId}/apis/${proxyName}/revisions/${revision}`;
        const count = proxyDocuments(await this.client.downloadApigeeRevisionBundle(this.scope.projectId, proxyName, revision)).length;
        const evidence = documentCountEvidence('proxy revision', count);
        return withAuthority({
          id,
          name: proxyName,
          providerType: this.type,
          sourceType: 'apigee-proxy' as const,
          authority: count === 1 ? 'stored-authoritative' : 'metadata-only',
          apiId: id,
          projectId: this.scope.projectId,
          tags: labels,
          supported: count === 1,
          evidence,
          meta: { proxyName, revision }
        });
      })
    );

    if (revisionExplicit) return proxyCandidates;
    return [...proxyCandidates, ...(await this.listArchiveCandidates())];
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const archive = parseApigeeArchiveDeploymentName(candidate.id);
    if (archive) {
      if (archive.org !== this.scope.projectId) throw new Error('Apigee archive candidate has an invalid resource name');
      const found = archiveDocuments(await this.downloadArchiveZip(candidate.id));
      if (found.length !== 1) {
        throw new Error(
          found.length
            ? `Apigee archive deployment has ${found.length} OpenAPI source documents; refusing to merge or guess`
            : 'Apigee archive deployment has no OpenAPI source document'
        );
      }
      return { ...found[0]!.decoded, evidence: [`Exported original Apigee archive deployment source ${found[0]!.path}`] };
    }

    const parsed = parseApigeeRevisionName(candidate.id);
    if (!parsed || parsed.org !== this.scope.projectId) throw new Error('Apigee candidate has an invalid revision resource name');
    const found = proxyDocuments(await this.client.downloadApigeeRevisionBundle(parsed.org, parsed.proxyName, parsed.revision));
    if (found.length !== 1) {
      throw new Error(
        found.length
          ? `Apigee proxy revision has ${found.length} contract source documents; refusing to merge or guess`
          : 'Apigee proxy revision has no contract source document'
      );
    }
    return { ...found[0]!.decoded, evidence: [`Exported original Apigee source ${found[0]!.path}`] };
  }

  private async latestRevisions(): Promise<Array<{ proxyName: string; revision: string; labels: Record<string, string> }>> {
    const result: Array<{ proxyName: string; revision: string; labels: Record<string, string> }> = [];
    for (const proxy of await this.client.listApigeeProxies(this.scope.projectId)) {
      const revision = (await this.client.listApigeeRevisions(this.scope.projectId, proxy.name))
        .filter((value) => /^\d+$/.test(value))
        .sort((a, b) => Number(b) - Number(a))[0];
      if (revision) result.push({ proxyName: proxy.name, revision, labels: proxy.labels ?? {} });
    }
    return result;
  }

  private async listArchiveCandidates(): Promise<SpecCandidate[]> {
    const candidates: SpecCandidate[] = [];
    let environments: string[];
    try {
      environments = await this.client.listApigeeEnvironments(this.scope.projectId);
    } catch {
      return [];
    }
    for (const environment of environments) {
      let deployments: ApigeeArchiveDeploymentSummary[];
      try {
        deployments = await this.client.listApigeeArchiveDeployments(this.scope.projectId, environment);
      } catch {
        continue;
      }
      for (const deployment of deployments) {
        if (!deployment.name) continue;
        candidates.push(await this.toArchiveCandidate(deployment));
      }
    }
    return candidates;
  }

  private async toArchiveCandidate(deployment: ApigeeArchiveDeploymentSummary): Promise<SpecCandidate> {
    let count: number;
    let evidence: string[];
    try {
      count = archiveDocuments(await this.downloadArchiveZip(deployment.name)).length;
      evidence =
        count === 1
          ? ['Apigee archive deployment has one OpenAPI source document']
          : count === 0
            ? ['Apigee archive deployment has no OpenAPI source document']
            : [`Apigee archive deployment has ${count} OpenAPI source documents; refusing to merge or guess`];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      evidence = [`Apigee archive deployment OpenAPI inspection failed: ${detail}`];
      count = 0;
    }
    const short = deployment.name.split('/').pop() ?? deployment.name;
    return withAuthority({
      id: deployment.name,
      name: short,
      providerType: this.type,
      sourceType: 'apigee-archive-deployment',
      authority: count === 1 ? 'stored-authoritative' : 'metadata-only',
      apiId: deployment.name,
      projectId: this.scope.projectId,
      tags: deployment.labels,
      supported: count === 1,
      evidence,
      meta: {
        environment: deployment.name.split('/environments/')[1]?.split('/')[0] ?? '',
        archiveDeploymentId: short,
        createdAt: deployment.createdAt ?? '',
        updatedAt: deployment.updatedAt ?? ''
      }
    });
  }

  private async downloadArchiveZip(archiveDeploymentName: string): Promise<Buffer> {
    const downloadUri = await this.client.generateApigeeArchiveDeploymentDownloadUrl(archiveDeploymentName);
    return this.client.downloadTrustedGcsSignedUrl(downloadUri);
  }
}
