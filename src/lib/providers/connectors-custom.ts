import type { ProviderProbeStatus, SourceAuthority } from '../../contracts.js';
import type { CustomConnectorVersionSummary, GcpDiscoveryClient } from '../gcp/clients.js';
import { decodeUtf8OpenApi } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

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
    // Connection schema metadata is retained on the client as metadata-only and is
    // never synthesized into OpenAPI candidates.
    return (await this.client.listCustomConnectorVersions(this.scope.projectId)).map((version) => this.toCandidate(version));
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
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
    let authority: SourceAuthority = 'stored-authoritative';
    if (!specLocation) {
      supported = false;
      authority = 'metadata-only';
      evidence.push('Custom connector version has no specLocation');
    } else if (!gcs) {
      supported = false;
      authority = 'unsupported-format';
      evidence.push('Only gs:// specLocation objects are fetched in v1.0.0; remote URLs are manual review');
    }
    return withAuthority({
      id: version.name,
      name: version.name.split('/customConnectors/')[1]?.split('/')[0] ?? shortName(version.name),
      providerType: this.type,
      sourceType: 'connectors-custom-spec',
      authority,
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
    });
  }
}
