import type { ProviderProbeStatus } from '../../contracts.js';
import type { EndpointServiceConfig, GcpDiscoveryClient, ManagedService } from '../gcp/clients.js';
import { decodeSourceDocument } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const ENDPOINT_CONFIG_PATTERN = /^services\/([^/]+)\/configs\/([^/]+)$/;
const OPENAPI_FILE_TYPES = new Set(['OPEN_API_JSON', 'OPEN_API_YAML']);

export interface CloudEndpointsScope {
  projectId: string;
  apiId?: string;
}

export function parseEndpointConfigName(value: string): { serviceName: string; configId: string } | undefined {
  const match = ENDPOINT_CONFIG_PATTERN.exec(value);
  return match ? { serviceName: match[1]!, configId: match[2]! } : undefined;
}

function sourceFiles(config: EndpointServiceConfig) {
  return (config.sourceInfo?.sourceFiles ?? []).filter((file) => OPENAPI_FILE_TYPES.has(file.fileType ?? ''));
}

function supportEvidence(config: EndpointServiceConfig): { supported: boolean; evidence: string[] } {
  const files = sourceFiles(config);
  if (files.length === 1) return { supported: true, evidence: [`Cloud Endpoints config ${config.id} has one original OpenAPI source`] };
  if (files.length === 0) {
    return { supported: false, evidence: ['Cloud Endpoints config has no original OpenAPI sourceInfo file; normalized Service Config is not reverse-converted'] };
  }
  return {
    supported: false,
    evidence: [`Cloud Endpoints config has ${files.length} OpenAPI source files; refusing to merge or guess`]
  };
}

export class CloudEndpointsProvider implements SpecProvider {
  public readonly type = 'cloud-endpoints' as const;

  public constructor(
    private readonly client: GcpDiscoveryClient,
    private readonly scope: CloudEndpointsScope
  ) {}

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeCloudEndpoints(this.scope.projectId);
      return 'available';
    } catch (error) {
      return probeFailureStatus(error);
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const explicit = this.scope.apiId ? parseEndpointConfigName(this.scope.apiId) : undefined;
    if (explicit) {
      const full = await this.client.getEndpointConfig(explicit.serviceName, explicit.configId);
      if (full.producerProjectId !== this.scope.projectId) {
        throw new Error('api-id Cloud Endpoints config does not belong to the configured project-id');
      }
      return [this.toCandidate(full, { serviceName: explicit.serviceName, producerProjectId: full.producerProjectId })];
    }
    if (this.scope.apiId) return [];

    const candidates: SpecCandidate[] = [];
    for (const service of await this.client.listManagedServices(this.scope.projectId)) {
      const newest = (await this.client.listEndpointConfigs(service.serviceName))[0];
      if (!newest?.id) continue;
      const full = await this.client.getEndpointConfig(service.serviceName, newest.id);
      if (full.producerProjectId && full.producerProjectId !== this.scope.projectId) continue;
      candidates.push(this.toCandidate(full, service));
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const parsed = parseEndpointConfigName(candidate.id);
    if (!parsed) throw new Error('Cloud Endpoints candidate has an invalid config resource name');
    const config = await this.client.getEndpointConfig(parsed.serviceName, parsed.configId);
    if (config.producerProjectId !== this.scope.projectId) {
      throw new Error('Cloud Endpoints config belongs to a different project');
    }
    const support = supportEvidence(config);
    if (!support.supported) throw new Error(support.evidence.at(-1));
    const source = sourceFiles(config)[0]!;
    const decoded = decodeSourceDocument(source.fileContents);
    return {
      ...decoded,
      evidence: [`Exported original Cloud Endpoints source ${source.filePath ?? 'OpenAPI source'}`]
    };
  }

  private toCandidate(config: EndpointServiceConfig, service: ManagedService): SpecCandidate {
    const support = supportEvidence(config);
    const id = `services/${service.serviceName}/configs/${config.id}`;
    return {
      id,
      name: config.title || config.name || service.serviceName,
      providerType: this.type,
      apiId: id,
      projectId: this.scope.projectId,
      tags: {},
      supported: support.supported,
      evidence: support.evidence,
      meta: { serviceName: service.serviceName, configId: config.id }
    };
  }
}
