import type { ProviderProbeStatus, SourceAuthority } from '../../contracts.js';
import type { ApiGatewayApi, ApiGatewayConfig, GcpDiscoveryClient, GcpSourceFile } from '../gcp/clients.js';
import { resolveProtoSourceSet, type ProtoSourceSetResolution } from '../spec/proto-source-set.js';
import { decodeSourceDocument, decodeUtf8NativeFamily } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

const CONFIG_PATTERN = /^projects\/([^/]+)\/locations\/([^/]+)\/apis\/([^/]+)\/configs\/([^/]+)$/;
export const API_GATEWAY_PROTOBUF_VARIANT = 'protobuf';

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
  const match = CONFIG_PATTERN.exec(stripProtobufVariant(value));
  return match
    ? { projectId: match[1]!, location: match[2]!, apiName: match[3]!, configId: match[4]! }
    : undefined;
}

export function parseApiGatewayProtobufConfigName(value: string): {
  projectId: string;
  location: string;
  apiName: string;
  configId: string;
} | undefined {
  if (!value.endsWith(`#${API_GATEWAY_PROTOBUF_VARIANT}`)) return undefined;
  return parseApiGatewayConfigName(value);
}

function stripProtobufVariant(value: string): string {
  return value.endsWith(`#${API_GATEWAY_PROTOBUF_VARIANT}`)
    ? value.slice(0, -(API_GATEWAY_PROTOBUF_VARIANT.length + 1))
    : value;
}

function isProtobufVariantId(value: string): boolean {
  return value.endsWith(`#${API_GATEWAY_PROTOBUF_VARIANT}`);
}

function shortName(value: string): string {
  return value.split('/').pop() ?? value;
}

function flattenGrpcSources(config: ApiGatewayConfig): {
  sources: GcpSourceFile[];
  descriptorOnly: boolean;
} {
  const sources: GcpSourceFile[] = [];
  let hasDescriptor = false;
  for (const service of config.grpcServices) {
    if (service.fileDescriptorSet?.contents) hasDescriptor = true;
    for (const source of service.source) {
      sources.push(source);
    }
  }
  return { sources, descriptorOnly: hasDescriptor && sources.length === 0 };
}

function resolveGatewayProtobuf(
  config: ApiGatewayConfig,
  evidencePrefix: string[]
): ProtoSourceSetResolution {
  const { sources, descriptorOnly } = flattenGrpcSources(config);
  return resolveProtoSourceSet(
    sources.map((source) => ({ path: source.path, contentsBase64: source.contents })),
    { descriptorOnly, evidencePrefix }
  );
}

function openApiSupportEvidence(
  config: ApiGatewayConfig,
  options: { allowInactive?: boolean } = {}
): { supported: boolean; authority: SourceAuthority; evidence: string[] } {
  const evidence = [`API Gateway config ${shortName(config.name)} is ${config.state ?? 'STATE_UNSPECIFIED'}`];
  if (config.state !== 'ACTIVE') {
    if (!options.allowInactive) {
      return {
        supported: false,
        authority: 'metadata-only',
        evidence: [...evidence, 'Only ACTIVE API Gateway configs are exportable']
      };
    }
    evidence.push('Explicit api-id requested inactive/historical API Gateway config export');
  }
  if (config.openapiDocuments.length !== 1) {
    const detail =
      config.openapiDocuments.length === 0
        ? 'API Gateway config has no OpenAPI source document'
        : `API Gateway config has ${config.openapiDocuments.length} OpenAPI source documents; refusing to merge or guess`;
    return { supported: false, authority: 'metadata-only', evidence: [...evidence, detail] };
  }
  return { supported: true, authority: 'stored-authoritative', evidence };
}

function protobufSupportEvidence(
  config: ApiGatewayConfig,
  options: { allowInactive?: boolean } = {}
): { supported: boolean; authority: SourceAuthority; evidence: string[]; originalPath?: string } {
  const evidence = [`API Gateway config ${shortName(config.name)} is ${config.state ?? 'STATE_UNSPECIFIED'}`];
  if (config.state !== 'ACTIVE') {
    if (!options.allowInactive) {
      return {
        supported: false,
        authority: 'metadata-only',
        evidence: [...evidence, 'Only ACTIVE API Gateway configs are exportable']
      };
    }
    evidence.push('Explicit api-id requested inactive/historical API Gateway config export');
  }
  if (config.managedServiceConfigs.length > 0) {
    evidence.push(
      `API Gateway managedServiceConfigs (${config.managedServiceConfigs.length}) are non-exportable service configs`
    );
  }
  const resolved = resolveGatewayProtobuf(config, evidence);
  if (resolved.status === 'exportable') {
    return {
      supported: true,
      authority: 'stored-authoritative',
      evidence: resolved.export.evidence,
      originalPath: resolved.export.originalPath
    };
  }
  return {
    supported: false,
    authority: resolved.authority,
    evidence: resolved.evidence
  };
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
    const explicitRaw = this.scope.apiId;
    const explicit = explicitRaw ? parseApiGatewayConfigName(explicitRaw) : undefined;
    if (explicitRaw && explicit) {
      if (explicit.projectId !== this.scope.projectId || explicit.location !== this.scope.location) {
        throw new Error('api-id must belong to the configured project-id and global location');
      }
      const full = await this.client.getApiGatewayConfig(stripProtobufVariant(explicitRaw));
      const wantProtobuf = isProtobufVariantId(explicitRaw);
      const candidates = this.toCandidates(full, undefined, {
        allowInactive: true,
        preferProtobufOnly: wantProtobuf
      });
      if (wantProtobuf) {
        const protobuf = candidates.find((candidate) => candidate.meta.exportFamily === 'protobuf');
        return protobuf
          ? [{ ...protobuf, apiId: explicitRaw }]
          : candidates.map((candidate) => ({ ...candidate, apiId: explicitRaw }));
      }
      // Explicit base config id: preserve OpenAPI precedence; still surface protobuf variant when present.
      return candidates.map((candidate) =>
        candidate.meta.exportFamily === 'protobuf'
          ? candidate
          : { ...candidate, apiId: stripProtobufVariant(explicitRaw) }
      );
    }
    if (this.scope.apiId) return [];

    const candidates: SpecCandidate[] = [];
    const apis = await this.client.listApiGatewayApis(this.scope.projectId, this.scope.location);
    for (const api of apis) {
      if (!api.name) continue;
      const configs = await this.client.listApiGatewayConfigs(api.name);
      for (const summary of configs) {
        if (!summary.name) continue;
        try {
          const full = await this.client.getApiGatewayConfig(summary.name);
          candidates.push(...this.toCandidates(full, api, { allowInactive: false }));
        } catch {
          const candidate = this.toOpenApiCandidate(summary, api, {
            allowInactive: false,
            supportedOverride: {
              supported: false,
              authority: 'metadata-only',
              evidence: [
                `API Gateway config ${shortName(summary.name)} is ${summary.state ?? 'STATE_UNSPECIFIED'}`,
                'API Gateway FULL source export is unavailable; retained for manual review'
              ]
            }
          });
          candidates.push(candidate);
        }
      }
    }
    return candidates;
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const configName =
      candidate.meta.configName ||
      (candidate.apiId ? stripProtobufVariant(candidate.apiId) : undefined) ||
      stripProtobufVariant(candidate.id);
    const config = await this.client.getApiGatewayConfig(configName);
    const allowInactive =
      candidate.meta.allowInactiveExport === 'true' ||
      Boolean(this.scope.apiId && parseApiGatewayConfigName(this.scope.apiId));

    if (candidate.meta.exportFamily === 'protobuf' || isProtobufVariantId(candidate.id)) {
      const support = protobufSupportEvidence(config, { allowInactive });
      if (!support.supported) throw new Error(support.evidence.at(-1));
      const resolved = resolveGatewayProtobuf(config, []);
      if (resolved.status !== 'exportable') throw new Error(resolved.evidence.at(-1));
      const decoded = decodeUtf8NativeFamily(resolved.export.content, 'protobuf');
      return {
        ...decoded,
        evidence: [
          `Exported original API Gateway protobuf source ${resolved.export.originalPath}`,
          ...resolved.export.evidence.filter((line) => !line.startsWith('Selected sole'))
        ]
      };
    }

    const support = openApiSupportEvidence(config, { allowInactive });
    if (!support.supported) throw new Error(support.evidence.at(-1));
    const decoded = decodeSourceDocument(config.openapiDocuments[0]?.document?.contents);
    return {
      ...decoded,
      evidence: [`Exported original API Gateway source ${config.openapiDocuments[0]?.document?.path ?? 'openapi source'}`]
    };
  }

  private toCandidates(
    config: ApiGatewayConfig,
    api: ApiGatewayApi | undefined,
    options: { allowInactive: boolean; preferProtobufOnly?: boolean }
  ): SpecCandidate[] {
    const hasOpenApi = config.openapiDocuments.length > 0;
    const hasGrpc = config.grpcServices.length > 0;
    const results: SpecCandidate[] = [];

    if (!options.preferProtobufOnly && (hasOpenApi || !hasGrpc)) {
      results.push(this.toOpenApiCandidate(config, api, { allowInactive: options.allowInactive }));
    }

    if (hasGrpc) {
      results.push(
        this.toProtobufCandidate(config, api, {
          allowInactive: options.allowInactive,
          // Distinct ID only when OpenAPI candidate also exists (no silent overwrite).
          distinctId: hasOpenApi && !options.preferProtobufOnly
        })
      );
    }

    if (results.length === 0) {
      results.push(this.toOpenApiCandidate(config, api, { allowInactive: options.allowInactive }));
    }
    return results;
  }

  private toOpenApiCandidate(
    config: ApiGatewayConfig,
    api: ApiGatewayApi | undefined,
    options: {
      allowInactive: boolean;
      supportedOverride?: { supported: boolean; authority: SourceAuthority; evidence: string[] };
    }
  ): SpecCandidate {
    const support = options.supportedOverride ?? openApiSupportEvidence(config, options);
    const apiName = config.name.split('/configs/')[0] ?? config.name;
    return withAuthority({
      id: config.name,
      name: config.displayName || api?.displayName || shortName(apiName),
      providerType: this.type,
      sourceType: 'api-gateway-config',
      authority: support.authority,
      apiId: config.name,
      projectId: this.scope.projectId,
      tags: { ...(api?.labels ?? {}), ...config.labels },
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        apiName,
        configId: shortName(config.name),
        configName: config.name,
        createTime: config.createTime ?? '',
        updateTime: config.updateTime ?? '',
        state: config.state ?? '',
        exportFamily: 'openapi',
        allowInactiveExport: options.allowInactive && config.state !== 'ACTIVE' && support.supported ? 'true' : 'false'
      }
    });
  }

  private toProtobufCandidate(
    config: ApiGatewayConfig,
    api: ApiGatewayApi | undefined,
    options: { allowInactive: boolean; distinctId: boolean }
  ): SpecCandidate {
    const support = protobufSupportEvidence(config, options);
    const apiName = config.name.split('/configs/')[0] ?? config.name;
    const id = options.distinctId ? `${config.name}#${API_GATEWAY_PROTOBUF_VARIANT}` : config.name;
    return withAuthority({
      id,
      name: `${config.displayName || api?.displayName || shortName(apiName)} (protobuf)`,
      providerType: this.type,
      sourceType: 'api-gateway-config',
      authority: support.authority,
      apiId: id,
      projectId: this.scope.projectId,
      tags: { ...(api?.labels ?? {}), ...config.labels },
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        apiName,
        configId: shortName(config.name),
        configName: config.name,
        createTime: config.createTime ?? '',
        updateTime: config.updateTime ?? '',
        state: config.state ?? '',
        exportFamily: 'protobuf',
        originalProtoPath: support.originalPath ?? '',
        allowInactiveExport: options.allowInactive && config.state !== 'ACTIVE' && support.supported ? 'true' : 'false'
      }
    });
  }
}
