import type { ProviderProbeStatus } from '../../contracts.js';
import type { ApiGatewayApi, ApiGatewayConfig, GcpDiscoveryClient } from '../gcp/clients.js';
import { decodeSourceDocument } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

const CONFIG_PATTERN = /^projects\/([^/]+)\/locations\/([^/]+)\/apis\/([^/]+)\/configs\/([^/]+)$/;

export interface ApiGatewayScope {
  projectId: string;
  location: string;
  apiId?: string;
}

export function parseApiGatewayConfigName(value: string): {
  projectId: string;
  location: string;
  apiName: string;
  configId: string;
} | undefined {
  const match = CONFIG_PATTERN.exec(value);
  return match
    ? { projectId: match[1]!, location: match[2]!, apiName: match[3]!, configId: match[4]! }
    : undefined;
}

function shortName(value: string): string {
  return value.split('/').pop() ?? value;
}

function supportEvidence(config: ApiGatewayConfig): { supported: boolean; evidence: string[] } {
  const evidence = [`API Gateway config ${shortName(config.name)} is ${config.state ?? 'STATE_UNSPECIFIED'}`];
  if (config.state !== 'ACTIVE') {
    return { supported: false, evidence: [...evidence, 'Only ACTIVE API Gateway configs are exportable'] };
  }
  if (config.openapiDocuments.length !== 1) {
    const detail = config.openapiDocuments.length === 0
      ? 'API Gateway config has no OpenAPI source document'
      : `API Gateway config has ${config.openapiDocuments.length} OpenAPI source documents; refusing to merge or guess`;
    return { supported: false, evidence: [...evidence, detail] };
  }
  if (config.grpcServices.length > 0) {
    return { supported: false, evidence: [...evidence, 'gRPC API Gateway configs are not converted in v1.0.0'] };
  }
  return { supported: true, evidence };
}

export class ApiGatewayProvider implements SpecProvider {
  public readonly type = 'api-gateway' as const;

  public constructor(
    private readonly client: GcpDiscoveryClient,
    private readonly scope: ApiGatewayScope
  ) {}

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeApiGateway(this.scope.projectId, this.scope.location);
      return 'available';
    } catch (error) {
      return probeFailureStatus(error);
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const explicit = this.scope.apiId ? parseApiGatewayConfigName(this.scope.apiId) : undefined;
    if (explicit) {
      if (explicit.projectId !== this.scope.projectId || explicit.location !== this.scope.location) {
        throw new Error('api-id must belong to the configured project-id and global location');
      }
      // The API returns config.name with the numeric project number; keep the
      // caller's project-id form so the explicit api-id match in the runtime holds.
      const candidate = this.toCandidate(await this.client.getApiGatewayConfig(this.scope.apiId!), undefined);
      return [{ ...candidate, apiId: this.scope.apiId! }];
    }
    if (this.scope.apiId) return [];

    const candidates: SpecCandidate[] = [];
    const apis = await this.client.listApiGatewayApis(this.scope.projectId, this.scope.location);
    for (const api of apis) {
      if (!api.name) continue;
      const configs = await this.client.listApiGatewayConfigs(api.name);
      for (const summary of configs) {
        if (!summary.name) continue;
        const full = await this.client.getApiGatewayConfig(summary.name);
        candidates.push(this.toCandidate(full, api));
      }
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const config = await this.client.getApiGatewayConfig(candidate.id);
    const support = supportEvidence(config);
    if (!support.supported) throw new Error(support.evidence.at(-1));
    const decoded = decodeSourceDocument(config.openapiDocuments[0]?.document?.contents);
    return {
      ...decoded,
      evidence: [`Exported original API Gateway source ${config.openapiDocuments[0]?.document?.path ?? 'openapi source'}`]
    };
  }

  private toCandidate(config: ApiGatewayConfig, api: ApiGatewayApi | undefined): SpecCandidate {
    const support = supportEvidence(config);
    const apiName = config.name.split('/configs/')[0] ?? config.name;
    return {
      id: config.name,
      name: config.displayName || api?.displayName || shortName(apiName),
      providerType: this.type,
      apiId: config.name,
      projectId: this.scope.projectId,
      tags: { ...(api?.labels ?? {}), ...config.labels },
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        apiName,
        configId: shortName(config.name),
        createTime: config.createTime ?? '',
        updateTime: config.updateTime ?? ''
      }
    };
  }
}
