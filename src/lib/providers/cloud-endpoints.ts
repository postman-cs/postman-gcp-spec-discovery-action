import type { ProviderProbeStatus, SourceAuthority } from '../../contracts.js';
import type { EndpointServiceConfig, EndpointSourceFile, GcpDiscoveryClient, ManagedService } from '../gcp/clients.js';
import { resolveProtoSourceSet, type ProtoSourceSetResolution } from '../spec/proto-source-set.js';
import { decodeSourceDocument, decodeUtf8NativeFamily } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

const ENDPOINT_CONFIG_PATTERN = /^services\/([^/]+)\/configs\/([^/]+)$/;
const OPENAPI_FILE_TYPES = new Set(['OPEN_API_JSON', 'OPEN_API_YAML']);
export const CLOUD_ENDPOINTS_PROTOBUF_VARIANT = 'protobuf';

export interface CloudEndpointsScope {
  projectId: string;
  apiId?: string;
}

export function parseEndpointConfigName(value: string): { serviceName: string; configId: string } | undefined {
  const match = ENDPOINT_CONFIG_PATTERN.exec(stripProtobufVariant(value));
  return match ? { serviceName: match[1]!, configId: match[2]! } : undefined;
}

export function parseEndpointProtobufConfigName(
  value: string
): { serviceName: string; configId: string } | undefined {
  if (!value.endsWith(`#${CLOUD_ENDPOINTS_PROTOBUF_VARIANT}`)) return undefined;
  return parseEndpointConfigName(value);
}

function stripProtobufVariant(value: string): string {
  return value.endsWith(`#${CLOUD_ENDPOINTS_PROTOBUF_VARIANT}`)
    ? value.slice(0, -(CLOUD_ENDPOINTS_PROTOBUF_VARIANT.length + 1))
    : value;
}

function isProtobufVariantId(value: string): boolean {
  return value.endsWith(`#${CLOUD_ENDPOINTS_PROTOBUF_VARIANT}`);
}

function allSourceFiles(config: EndpointServiceConfig): EndpointSourceFile[] {
  return config.sourceInfo?.sourceFiles ?? [];
}

function openApiSourceFiles(config: EndpointServiceConfig): EndpointSourceFile[] {
  return allSourceFiles(config).filter((file) => OPENAPI_FILE_TYPES.has(file.fileType ?? ''));
}

function protoSourceFiles(config: EndpointServiceConfig): EndpointSourceFile[] {
  return allSourceFiles(config).filter((file) => file.fileType === 'PROTO_FILE');
}

function hasDescriptorSet(config: EndpointServiceConfig): boolean {
  return allSourceFiles(config).some((file) => file.fileType === 'FILE_DESCRIPTOR_SET_PROTO');
}

function resolveEndpointsProtobuf(config: EndpointServiceConfig): ProtoSourceSetResolution {
  const protoFiles = protoSourceFiles(config);
  return resolveProtoSourceSet(
    protoFiles.map((file) => ({ path: file.filePath, contentsBase64: file.fileContents })),
    {
      descriptorOnly: hasDescriptorSet(config) && protoFiles.length === 0,
      evidencePrefix: [`Cloud Endpoints config ${config.id}`]
    }
  );
}

function openApiSupportEvidence(
  config: EndpointServiceConfig
): { supported: boolean; authority: SourceAuthority; evidence: string[] } {
  const files = openApiSourceFiles(config);
  if (files.length === 1) {
    return {
      supported: true,
      authority: 'stored-authoritative',
      evidence: [`Cloud Endpoints config ${config.id} has one original OpenAPI source`]
    };
  }
  if (files.length === 0) {
    return {
      supported: false,
      authority: 'metadata-only',
      evidence: [
        'Cloud Endpoints config has no original OpenAPI sourceInfo file; normalized Service Config is not reverse-converted'
      ]
    };
  }
  return {
    supported: false,
    authority: 'metadata-only',
    evidence: [`Cloud Endpoints config has ${files.length} OpenAPI source files; refusing to merge or guess`]
  };
}

function protobufSupportEvidence(config: EndpointServiceConfig): {
  supported: boolean;
  authority: SourceAuthority;
  evidence: string[];
  originalPath?: string;
} {
  const resolved = resolveEndpointsProtobuf(config);
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
    const explicitRaw = this.scope.apiId;
    const explicit = explicitRaw ? parseEndpointConfigName(explicitRaw) : undefined;
    if (explicitRaw && explicit) {
      const full = await this.client.getEndpointConfig(explicit.serviceName, explicit.configId);
      if (full.producerProjectId !== this.scope.projectId) {
        throw new Error('api-id Cloud Endpoints config does not belong to the configured project-id');
      }
      const service = { serviceName: explicit.serviceName, producerProjectId: full.producerProjectId };
      const wantProtobuf = isProtobufVariantId(explicitRaw);
      const candidates = this.toCandidates(full, service, { preferProtobufOnly: wantProtobuf });
      if (wantProtobuf) {
        const protobuf = candidates.find((candidate) => candidate.meta.exportFamily === 'protobuf');
        return protobuf ? [{ ...protobuf, apiId: explicitRaw }] : candidates;
      }
      return candidates;
    }
    if (this.scope.apiId) return [];

    const candidates: SpecCandidate[] = [];
    for (const service of await this.client.listManagedServices(this.scope.projectId)) {
      // API Gateway provisions a hidden managed service per gateway API
      // (<api>-<hash>.apigateway.<project>.cloud.goog). Those are the gateway's
      // implementation detail and already surface as api-gateway candidates,
      // so listing them here would only duplicate every gateway API.
      if (service.serviceName.endsWith(`.apigateway.${this.scope.projectId}.cloud.goog`)) continue;
      const newest = (await this.client.listEndpointConfigs(service.serviceName))[0];
      if (!newest?.id) continue;
      const full = await this.client.getEndpointConfig(service.serviceName, newest.id);
      if (full.producerProjectId && full.producerProjectId !== this.scope.projectId) continue;
      candidates.push(...this.toCandidates(full, service));
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

    if (candidate.meta.exportFamily === 'protobuf' || isProtobufVariantId(candidate.id)) {
      const support = protobufSupportEvidence(config);
      if (!support.supported) throw new Error(support.evidence.at(-1));
      const resolved = resolveEndpointsProtobuf(config);
      if (resolved.status !== 'exportable') throw new Error(resolved.evidence.at(-1));
      const decoded = decodeUtf8NativeFamily(resolved.export.content, 'protobuf');
      const multiFile = resolved.export.members.length > 1;
      return {
        content: resolved.export.content,
        format: 'protobuf',
        filename: multiFile ? resolved.export.rootPath : decoded.filename,
        completeness: 'full',
        rootPath: resolved.export.rootPath,
        artifacts: multiFile
          ? resolved.export.members.map((member) => ({
              path: member.normalizedPath,
              role: member.role,
              content: member.content,
              originalPath: member.originalPath
            }))
          : undefined,
        evidence: [
          `Exported original Cloud Endpoints protobuf source ${resolved.export.originalPath}`,
          ...support.evidence.filter((line) => line.includes('ignored non-imported'))
        ]
      };
    }

    const support = openApiSupportEvidence(config);
    if (!support.supported) throw new Error(support.evidence.at(-1));
    const source = openApiSourceFiles(config)[0]!;
    const decoded = decodeSourceDocument(source.fileContents);
    return {
      ...decoded,
      evidence: [`Exported original Cloud Endpoints source ${source.filePath ?? 'OpenAPI source'}`]
    };
  }

  private toCandidates(
    config: EndpointServiceConfig,
    service: ManagedService,
    options: { preferProtobufOnly?: boolean } = {}
  ): SpecCandidate[] {
    const openapiFiles = openApiSourceFiles(config);
    const protoFiles = protoSourceFiles(config);
    const descriptor = hasDescriptorSet(config);
    const results: SpecCandidate[] = [];

    if (!options.preferProtobufOnly) {
      if (openapiFiles.length > 0 || (protoFiles.length === 0 && !descriptor)) {
        results.push(this.toOpenApiCandidate(config, service));
      }
    }

    if (protoFiles.length > 0 || descriptor) {
      results.push(
        this.toProtobufCandidate(config, service, {
          distinctId: results.length > 0 && !options.preferProtobufOnly
        })
      );
    }

    if (results.length === 0) {
      results.push(this.toOpenApiCandidate(config, service));
    }
    return results;
  }

  private toOpenApiCandidate(config: EndpointServiceConfig, service: ManagedService): SpecCandidate {
    const support = openApiSupportEvidence(config);
    const id = `services/${service.serviceName}/configs/${config.id}`;
    return withAuthority({
      id,
      name: config.title || config.name || service.serviceName,
      providerType: this.type,
      sourceType: 'cloud-endpoints-config',
      authority: support.authority,
      apiId: id,
      projectId: this.scope.projectId,
      tags: {},
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        serviceName: service.serviceName,
        configId: config.id,
        exportFamily: 'openapi'
      }
    });
  }

  private toProtobufCandidate(
    config: EndpointServiceConfig,
    service: ManagedService,
    options: { distinctId: boolean }
  ): SpecCandidate {
    const support = protobufSupportEvidence(config);
    const baseId = `services/${service.serviceName}/configs/${config.id}`;
    const id = options.distinctId ? `${baseId}#${CLOUD_ENDPOINTS_PROTOBUF_VARIANT}` : baseId;
    return withAuthority({
      id,
      name: `${config.title || config.name || service.serviceName} (protobuf)`,
      providerType: this.type,
      sourceType: 'cloud-endpoints-config',
      authority: support.authority,
      apiId: id,
      projectId: this.scope.projectId,
      tags: {},
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        serviceName: service.serviceName,
        configId: config.id,
        exportFamily: 'protobuf',
        originalProtoPath: support.originalPath ?? ''
      }
    });
  }
}
