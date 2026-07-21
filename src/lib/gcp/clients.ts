import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { GoogleAuth } from 'google-auth-library';

import { decodeBoundedBase64Utf8 } from '../providers/source-document.js';

export interface GcpClientOptions {
  requestTimeoutMs: number;
  maxAttempts: number;
}

export interface GcpRequestOptions {
  url: string;
  method: 'GET' | 'POST';
  timeout: number;
  retry: false;
  responseType?: 'arraybuffer';
  data?: unknown;
}

export interface GcpAuthenticatedRequester {
  request<T>(options: GcpRequestOptions): Promise<{
    data: T;
    status?: number;
    /** Gaxios Headers, Fetch Headers, or a plain record — normalized by headerValue(). */
    headers?: unknown;
  }>;
}

/** Strip query/fragment before including a URL in error text. */
export function safeUrlForErrors(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/**
 * Trusted hosts for Apigee archiveDeployments:generateDownloadUrl signed URLs.
 * Exact path-style hosts plus single-label virtual-hosted `*.storage.googleapis.com`.
 */
export function isTrustedGcsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'storage.googleapis.com' || host === 'storage.cloud.google.com') return true;
  const suffix = '.storage.googleapis.com';
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, -suffix.length);
  return prefix.length > 0 && !prefix.includes('.');
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (key: string) => string | null }).get(name)
      ?? (headers as { get: (key: string) => string | null }).get(wanted);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) return value[0];
  }
  return undefined;
}

/** API Hub fetchAdditionalSpecContent query enum (official wire values). */
export type ApiHubAdditionalSpecContentType = 'BOOSTED_SPEC_CONTENT' | 'GATEWAY_OPEN_API_SPEC';

export const API_HUB_ADDITIONAL_SPEC_CONTENT_TYPES: readonly ApiHubAdditionalSpecContentType[] = [
  'BOOSTED_SPEC_CONTENT',
  'GATEWAY_OPEN_API_SPEC'
] as const;

function parseApiHubAdditionalContentTypes(value: unknown): ApiHubAdditionalSpecContentType[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ApiHubAdditionalSpecContentType>();
  for (const entry of value) {
    const type = (entry as { specContentType?: unknown } | null)?.specContentType;
    if (type === 'BOOSTED_SPEC_CONTENT' || type === 'GATEWAY_OPEN_API_SPEC') seen.add(type);
  }
  return [...seen];
}

export interface ApiGatewayApi {
  name: string;
  displayName?: string;
  labels: Record<string, string>;
  state?: string;
}

export interface GcpSourceFile {
  path?: string;
  /** Base64-encoded file bytes (API Gateway File.contents). */
  contents?: string;
}

/**
 * API Gateway GrpcServiceDefinition from FULL ApiConfig.
 * `fileDescriptorSet` is input-only / non-exportable; `source[]` holds uncompiled .proto files.
 */
export interface ApiGatewayGrpcServiceDefinition {
  fileDescriptorSet?: GcpSourceFile;
  source: GcpSourceFile[];
}

export interface ApiGatewayConfig {
  name: string;
  displayName?: string;
  labels: Record<string, string>;
  state?: string;
  createTime?: string;
  updateTime?: string;
  openapiDocuments: Array<{ document?: GcpSourceFile }>;
  grpcServices: ApiGatewayGrpcServiceDefinition[];
  /** google.api.Service YAML/JSON configs — managed/generated; not exportable as bootstrap specs. */
  managedServiceConfigs: GcpSourceFile[];
}

export interface ManagedService {
  serviceName: string;
  producerProjectId?: string;
}

/**
 * Service Management ConfigFile.FileType values observed on FULL sourceInfo.sourceFiles.
 * Descriptor sets and service-config YAML remain non-exportable.
 */
export type EndpointSourceFileType =
  | 'FILE_TYPE_UNSPECIFIED'
  | 'SERVICE_CONFIG_YAML'
  | 'OPEN_API_JSON'
  | 'OPEN_API_YAML'
  | 'FILE_DESCRIPTOR_SET_PROTO'
  | 'PROTO_FILE'
  | string;

/**
 * Service Management ConfigFile as returned inside sourceInfo.sourceFiles (FULL view).
 * Wire may include `@type` when packed as google.protobuf.Any.
 */
export interface EndpointSourceFile {
  '@type'?: string;
  filePath?: string;
  /** Base64-encoded file bytes (ConfigFile.file_contents). */
  fileContents?: string;
  fileType?: EndpointSourceFileType;
}

export interface EndpointServiceConfig {
  id: string;
  name?: string;
  title?: string;
  producerProjectId?: string;
  sourceInfo?: { sourceFiles?: EndpointSourceFile[] };
}

export interface ApiHubSpecSummary {
  name: string;
  displayName?: string;
  apiDisplayName?: string;
  specTypeIds: string[];
  attributes: Record<string, string>;
  createTime?: string;
  sourceUri?: string;
  /** Distinct additional content types advertised on Spec.additionalSpecContents[].specContentType. */
  additionalSpecContentTypes: ApiHubAdditionalSpecContentType[];
}

export interface ApigeeRegistrySpecSummary {
  name: string;
  filename?: string;
  description?: string;
  mimeType?: string;
  sizeBytes?: number;
  labels: Record<string, string>;
  createTime?: string;
}

export interface ApigeeArchiveDeploymentSummary {
  name: string;
  labels: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApigeePortalSite { id: string; name?: string; }
export interface ApigeePortalApidoc { id: string; title?: string; specId?: string; apiProductName?: string; }

/** Exact wire union arms from ApiDocDocumentation (note capital A in asyncApi). */
export type ApigeePortalDocumentationType =
  | 'oasDocumentation'
  | 'graphqlDocumentation'
  | 'asyncApiDocumentation'
  | 'missing'
  | 'malformed';

export type ApigeePortalDocumentationFamily = 'openapi' | 'graphql' | 'asyncapi';

export interface ApigeePortalDocumentation {
  type: ApigeePortalDocumentationType;
  /** Decoded UTF-8 source text after bounded strict base64 decode of DocumentationFile.contents. */
  contents?: string;
  family?: ApigeePortalDocumentationFamily;
}

function documentationFileContents(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const contents = (value as { contents?: unknown }).contents;
  return typeof contents === 'string' ? contents : undefined;
}

/**
 * Map ApiDocDocumentationResponse / ApiDocDocumentation wire union arms to decoded UTF-8.
 * Paths: oasDocumentation.spec.contents, graphqlDocumentation.schema.contents,
 * asyncApiDocumentation.spec.contents (base64 DocumentationFile.contents).
 */
export function parseApigeePortalDocumentationBody(body: Record<string, unknown>): ApigeePortalDocumentation {
  const data =
    body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body;

  const arms: Array<{
    type: 'oasDocumentation' | 'graphqlDocumentation' | 'asyncApiDocumentation';
    family: ApigeePortalDocumentationFamily;
    base64: string | undefined;
    present: boolean;
  }> = [
    {
      type: 'oasDocumentation',
      family: 'openapi',
      present: data.oasDocumentation !== undefined && data.oasDocumentation !== null,
      base64: documentationFileContents(
        data.oasDocumentation && typeof data.oasDocumentation === 'object'
          ? (data.oasDocumentation as { spec?: unknown }).spec
          : undefined
      )
    },
    {
      type: 'graphqlDocumentation',
      family: 'graphql',
      present: data.graphqlDocumentation !== undefined && data.graphqlDocumentation !== null,
      base64: documentationFileContents(
        data.graphqlDocumentation && typeof data.graphqlDocumentation === 'object'
          ? (data.graphqlDocumentation as { schema?: unknown }).schema
          : undefined
      )
    },
    {
      type: 'asyncApiDocumentation',
      family: 'asyncapi',
      present: data.asyncApiDocumentation !== undefined && data.asyncApiDocumentation !== null,
      base64: documentationFileContents(
        data.asyncApiDocumentation && typeof data.asyncApiDocumentation === 'object'
          ? (data.asyncApiDocumentation as { spec?: unknown }).spec
          : undefined
      )
    }
  ];

  const present = arms.filter((arm) => arm.present);
  if (present.length === 0) return { type: 'missing' };
  if (present.length > 1) return { type: 'malformed' };

  const arm = present[0]!;
  if (arm.base64 === undefined) return { type: 'malformed' };
  try {
    return {
      type: arm.type,
      family: arm.family,
      contents: decodeBoundedBase64Utf8(arm.base64)
    };
  } catch {
    return { type: 'malformed' };
  }
}

export interface VertexExtensionSummary { name: string; displayName?: string; openApiYaml?: string; openApiGcsUri?: string; }
export interface AgentEngineSummary { name: string; displayName?: string; classMethods: Array<Record<string, unknown>>; }
export interface DialogflowAgentSummary { name: string; displayName?: string; }
export interface DialogflowToolSummary { name: string; displayName?: string; textSchema?: string; }
export interface CesToolsetSummary { name: string; displayName?: string; openApiSchema?: string; }
interface CesRetrieveToolsResponse {
  tools?: Array<{ name?: string; displayName?: string; openApiTool?: { openApiSchema?: string } }>;
}

export interface AppIntegrationApiTrigger {
  integrationResource: string;
  location: string;
  triggerIds: string[];
  updateTime?: string;
  /** ACTIVE integration version resource name; one trigger group per ACTIVE version. */
  versionName?: string;
}

export interface CustomConnectorVersionSummary {
  name: string;
  specLocation?: string;
  labels: Record<string, string>;
  updateTime?: string;
}

export interface ConnectorConnectionSummary { name: string; description?: string; serviceAccount?: string; }

/** Documented ConnectionSchemaMetadata singleton (metadata-only; not an OpenAPI source). */
export interface ConnectorSchemaMetadata {
  entities?: string[];
  actions?: string[];
  name?: string;
  state?: string;
  updateTime?: string;
  refreshTime?: string;
  errorMessage?: string;
}

export interface GcpDiscoveryClient {
  preflightProject(projectId: string): Promise<void>;
  probeApiGateway(projectId: string, location: string): Promise<void>;
  listApiGatewayApis(projectId: string, location: string): Promise<ApiGatewayApi[]>;
  listApiGatewayConfigs(apiName: string): Promise<ApiGatewayConfig[]>;
  getApiGatewayConfig(configName: string): Promise<ApiGatewayConfig>;
  probeCloudEndpoints(projectId: string): Promise<void>;
  listManagedServices(projectId: string): Promise<ManagedService[]>;
  listEndpointConfigs(serviceName: string): Promise<EndpointServiceConfig[]>;
  getEndpointConfig(serviceName: string, configId: string): Promise<EndpointServiceConfig>;
  probeApigee(org: string): Promise<void>;
  listApigeeProxies(org: string): Promise<Array<{ name: string; apiProxyType?: string; labels: Record<string, string> }>>;
  listApigeeRevisions(org: string, proxyName: string): Promise<string[]>;
  downloadApigeeRevisionBundle(org: string, proxyName: string, revision: string): Promise<Buffer>;
  listApigeeEnvironments(org: string): Promise<string[]>;
  listApigeeArchiveDeployments(org: string, environment: string): Promise<ApigeeArchiveDeploymentSummary[]>;
  generateApigeeArchiveDeploymentDownloadUrl(archiveDeploymentName: string): Promise<string>;
  downloadTrustedGcsSignedUrl(downloadUri: string): Promise<Buffer>;
  probeApiHub(projectId: string): Promise<void>;
  listApiHubSpecs(projectId: string): Promise<ApiHubSpecSummary[]>;
  getApiHubSpec(specName: string): Promise<ApiHubSpecSummary>;
  getApiHubSpecContents(specName: string): Promise<{ contents?: string; mimeType?: string }>;
  fetchApiHubAdditionalSpecContent(
    specName: string,
    specContentType: ApiHubAdditionalSpecContentType
  ): Promise<{ contents?: string; mimeType?: string }>;
  probeApigeeRegistry(projectId: string): Promise<void>;
  listApigeeRegistrySpecs(projectId: string): Promise<ApigeeRegistrySpecSummary[]>;
  getApigeeRegistrySpec(specName: string): Promise<ApigeeRegistrySpecSummary>;
  getApigeeRegistrySpecContents(specName: string): Promise<{ bytes: Buffer; mimeType?: string }>;
  probeApigeePortal(org: string): Promise<void>;
  listApigeePortalSites(org: string): Promise<ApigeePortalSite[]>;
  listApigeePortalApidocs(org: string, siteId: string): Promise<ApigeePortalApidoc[]>;
  getApigeePortalDocumentation(org: string, siteId: string, apidocId: string): Promise<ApigeePortalDocumentation>;
  probeVertexExtensions(projectId: string, location: string): Promise<void>;
  listVertexLocations(projectId: string): Promise<string[]>;
  listVertexExtensions(projectId: string, location: string): Promise<VertexExtensionSummary[]>;
  probeAgentEngines(projectId: string, location: string): Promise<void>;
  listAgentEngines(projectId: string, location: string): Promise<AgentEngineSummary[]>;
  probeDialogflow(projectId: string): Promise<void>;
  listDialogflowAgents(projectId: string): Promise<DialogflowAgentSummary[]>;
  listDialogflowTools(agentName: string): Promise<DialogflowToolSummary[]>;
  probeCes(projectId: string): Promise<void>;
  listCesToolsets(projectId: string): Promise<CesToolsetSummary[]>;
  probeAppIntegration(projectId: string): Promise<void>;
  listAppIntegrationApiTriggers(projectId: string): Promise<AppIntegrationApiTrigger[]>;
  generateAppIntegrationOpenApiSpec(location: string, integrationResource: string, triggerIds: string[]): Promise<string>;
  probeConnectors(projectId: string): Promise<void>;
  listCustomConnectorVersions(projectId: string): Promise<CustomConnectorVersionSummary[]>;
  listConnectorConnections(projectId: string): Promise<ConnectorConnectionSummary[]>;
  getConnectorSchemaMetadata(connectionName: string): Promise<ConnectorSchemaMetadata | undefined>;
  getStorageObjectText(bucket: string, object: string): Promise<string>;
}

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_LIST_PAGES = 100;
/** Matches source-document OpenAPI byte bound for authenticated GCS reads. */
const MAX_STORAGE_OBJECT_BYTES = 10 * 1024 * 1024;

const CRC32C_TABLE = (() => {
  const polynomial = 0x82f63b78;
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? polynomial ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

function crc32cBase64(bytes: Buffer): string {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    crc = CRC32C_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  const value = Buffer.alloc(4);
  value.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return value.toString('base64');
}

export function createGcpAuth(): GoogleAuth {
  return new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
}

function errorStatus(error: unknown): number | undefined {
  const record = (error ?? {}) as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  const candidate = Number(record.response?.status ?? record.status ?? record.code);
  return Number.isInteger(candidate) && candidate >= 100 && candidate <= 599 ? candidate : undefined;
}

function isTransient(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|temporar(?:y|ily)|connection reset|socket hang up/i.test(message);
}

function resourceUrl(origin: string, resourceName: string, apiVersion = 'v1'): URL {
  const encoded = resourceName.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return new URL(`${apiVersion}/${encoded}`, origin);
}

/**
 * API Hub resource names can arrive from explicit selectors with percent-encoded
 * IDs. Preserve valid escapes while encoding all other segment text, so `%2F`
 * remains `%2F` rather than double-encoding to `%252F`. Malformed or literal
 * percent characters remain ordinary segment text.
 */
function apiHubResourceUrl(resourceName: string): URL {
  const encoded = resourceName.split('/').map((segment) => (
    segment.replace(/%[0-9A-Fa-f]{2}|[^%]+|%/g, (part) => (
      /^%[0-9A-Fa-f]{2}$/.test(part) ? part.toUpperCase() : encodeURIComponent(part)
    ))
  )).join('/');
  return new URL(`v1/${encoded}`, 'https://apihub.googleapis.com/');
}

function normalizeLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

/**
 * API Hub attributes are not GCP labels: the wire shape is
 * `map<string, AttributeValues>` keyed by the full attribute resource name
 * (`projects/.../locations/.../attributes/<attr-id>`), where each value is an
 * object carrying `stringValues`, `uriValues`, or `enumValues`. Flatten each
 * entry to `<attr-id> -> first scalar value` so a user-defined string attribute
 * named `postman-repo` lands in candidate tags and the repository-association
 * matcher works exactly as it does for real labels. Non-scalar shapes are skipped.
 */
function flattenApiHubAttributes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const flattened: Record<string, string> = {};
  for (const [attributeName, attributeValue] of Object.entries(value as Record<string, unknown>)) {
    const attributeId = attributeName.split('/').pop();
    if (!attributeId) continue;
    const values = attributeValue as {
      stringValues?: { values?: unknown[] };
      uriValues?: { values?: unknown[] };
      enumValues?: { values?: Array<{ id?: unknown }> };
    } | null;
    if (!values || typeof values !== 'object') continue;
    const scalar =
      values.stringValues?.values?.find((entry): entry is string => typeof entry === 'string') ??
      values.uriValues?.values?.find((entry): entry is string => typeof entry === 'string') ??
      values.enumValues?.values?.map((entry) => entry.id).find((id): id is string => typeof id === 'string');
    if (typeof scalar === 'string' && scalar.length > 0) flattened[attributeId] = scalar;
  }
  return flattened;
}

export class GcpSdkClient implements GcpDiscoveryClient {
  // Lazy: ADC lookup must not start until the first authenticated request.
  // Repo-spec and IaC-local resolutions never touch GCP, and an eagerly
  // started auth.getClient() rejects unhandled on runners without ADC.
  private requesterPromise: Promise<GcpAuthenticatedRequester> | undefined;
  private readonly createRequester: () => Promise<GcpAuthenticatedRequester>;
  private readonly options: GcpClientOptions;

  public constructor(
    auth: GoogleAuth,
    options: GcpClientOptions,
    requester?: GcpAuthenticatedRequester
  ) {
    this.createRequester = requester
      ? () => Promise.resolve(requester)
      : async () => (await auth.getClient()) as unknown as GcpAuthenticatedRequester;
    this.options = options;
  }

  private requester(): Promise<GcpAuthenticatedRequester> {
    this.requesterPromise ??= this.createRequester();
    return this.requesterPromise;
  }

  public async preflightProject(projectId: string): Promise<void> {
    const url = new URL(`v3/projects/${encodeURIComponent(projectId)}`, 'https://cloudresourcemanager.googleapis.com/');
    const body = await this.getJson<{ projectId?: string; state?: string }>(url, 'Google Cloud project preflight');
    if (body.projectId !== projectId) {
      throw new Error('Google Cloud project preflight returned a different project');
    }
    if (body.state && body.state !== 'ACTIVE') {
      throw new Error('Google Cloud project is not active');
    }
  }

  public async probeApiGateway(projectId: string, location: string): Promise<void> {
    const parent = `projects/${projectId}/locations/${location}`;
    const url = resourceUrl('https://apigateway.googleapis.com/', `${parent}/apis`);
    url.searchParams.set('pageSize', '1');
    await this.getJson(url, 'API Gateway probe');
  }

  public async listApiGatewayApis(projectId: string, location: string): Promise<ApiGatewayApi[]> {
    const parent = `projects/${projectId}/locations/${location}`;
    return this.collectPages(
      () => resourceUrl('https://apigateway.googleapis.com/', `${parent}/apis`),
      'API Gateway API list',
      (body: { apis?: unknown[]; nextPageToken?: string }) => ({
        items: (body.apis ?? []).map((item) => this.toGatewayApi(item)),
        nextPageToken: body.nextPageToken
      })
    );
  }

  public async listApiGatewayConfigs(apiName: string): Promise<ApiGatewayConfig[]> {
    return this.collectPages(
      () => resourceUrl('https://apigateway.googleapis.com/', `${apiName}/configs`),
      'API Gateway config list',
      (body: { apiConfigs?: unknown[]; nextPageToken?: string }) => ({
        items: (body.apiConfigs ?? []).map((item) => this.toGatewayConfig(item)),
        nextPageToken: body.nextPageToken
      })
    );
  }

  public async getApiGatewayConfig(configName: string): Promise<ApiGatewayConfig> {
    const url = resourceUrl('https://apigateway.googleapis.com/', configName);
    url.searchParams.set('view', 'FULL');
    return this.toGatewayConfig(await this.getJson(url, 'API Gateway config export'));
  }

  public async probeCloudEndpoints(projectId: string): Promise<void> {
    const url = new URL('v1/services', 'https://servicemanagement.googleapis.com/');
    url.searchParams.set('producerProjectId', projectId);
    url.searchParams.set('pageSize', '1');
    await this.getJson(url, 'Cloud Endpoints probe');
  }

  public async listManagedServices(projectId: string): Promise<ManagedService[]> {
    return this.collectPages(
      () => {
        const url = new URL('v1/services', 'https://servicemanagement.googleapis.com/');
        url.searchParams.set('producerProjectId', projectId);
        return url;
      },
      'Cloud Endpoints service list',
      (body: { services?: unknown[]; nextPageToken?: string }) => ({
        items: (body.services ?? [])
          .map((item) => this.toManagedService(item))
          .filter((item) => item.serviceName && item.producerProjectId === projectId),
        nextPageToken: body.nextPageToken
      })
    );
  }

  public async listEndpointConfigs(serviceName: string): Promise<EndpointServiceConfig[]> {
    return this.collectPages(
      () => resourceUrl('https://servicemanagement.googleapis.com/', `services/${serviceName}/configs`),
      'Cloud Endpoints config list',
      (body: { serviceConfigs?: unknown[]; nextPageToken?: string }) => ({
        items: (body.serviceConfigs ?? []).map((item) => this.toEndpointConfig(item)),
        nextPageToken: body.nextPageToken
      }),
      100
    );
  }

  public async getEndpointConfig(serviceName: string, configId: string): Promise<EndpointServiceConfig> {
    const url = resourceUrl(
      'https://servicemanagement.googleapis.com/',
      `services/${serviceName}/configs/${configId}`
    );
    url.searchParams.set('view', 'FULL');
    return this.toEndpointConfig(await this.getJson(url, 'Cloud Endpoints config export'));
  }

  public async probeApigee(org: string): Promise<void> {
    await this.getJson(this.apigeeUrl(org), 'Apigee probe');
  }

  public async listApigeeProxies(org: string): Promise<Array<{ name: string; apiProxyType?: string; labels: Record<string, string> }>> {
    const url = this.apigeeUrl(org);
    url.searchParams.set('includeMetaData', 'true');
    const body = await this.getJson<{ proxies?: Array<string | { name?: string; apiProxyType?: string; labels?: unknown }> } | string[]>(url, 'Apigee proxy list');
    const values = Array.isArray(body) ? body : body.proxies ?? [];
    return values
      .map((value) => typeof value === 'string'
        ? { name: value, labels: {} }
        : { name: value.name ?? '', apiProxyType: value.apiProxyType, labels: normalizeLabels(value.labels) })
      .filter((value) => value.name);
  }

  public async listApigeeRevisions(org: string, proxyName: string): Promise<string[]> {
    const body = await this.getJson<string[]>(this.apigeeUrl(org, proxyName, 'revisions'), 'Apigee revision list');
    return Array.isArray(body) ? body.map(String) : [];
  }

  public async downloadApigeeRevisionBundle(org: string, proxyName: string, revision: string): Promise<Buffer> {
    const url = this.apigeeUrl(org, proxyName, 'revisions', revision);
    url.searchParams.set('format', 'bundle');
    return this.getBinary(url, 'Apigee revision bundle download');
  }

  public async listApigeeEnvironments(org: string): Promise<string[]> {
    const body = await this.getJson<string[]>(resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/environments`), 'Apigee environment list');
    return Array.isArray(body) ? body.map(String) : [];
  }

  public async listApigeeArchiveDeployments(org: string, environment: string): Promise<ApigeeArchiveDeploymentSummary[]> {
    return this.collectPages(
      () => resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/environments/${environment}/archiveDeployments`),
      'Apigee archive deployment list',
      (body: { archiveDeployments?: unknown[]; nextPageToken?: string }) => ({
        items: (body.archiveDeployments ?? []).map((item) => this.toApigeeArchiveDeployment(item)).filter((item) => item.name),
        nextPageToken: body.nextPageToken
      }),
      25
    );
  }

  public async generateApigeeArchiveDeploymentDownloadUrl(archiveDeploymentName: string): Promise<string> {
    const url = resourceUrl('https://apigee.googleapis.com/', archiveDeploymentName);
    url.pathname = `${url.pathname}:generateDownloadUrl`;
    const body = await this.postJson<{ downloadUri?: string }>(url, 'Apigee archive deployment download URL', {});
    if (typeof body.downloadUri !== 'string' || body.downloadUri.trim().length === 0) {
      throw new Error('Apigee archive deployment download URL response omitted downloadUri');
    }
    return body.downloadUri;
  }

  public async downloadTrustedGcsSignedUrl(downloadUri: string): Promise<Buffer> {
    let parsed: URL;
    try {
      parsed = new URL(downloadUri);
    } catch (error) {
      throw new Error('Apigee archive download URI is not a valid URL', { cause: error });
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`Apigee archive download URI must use HTTPS (${safeUrlForErrors(parsed)})`);
    }
    if (!isTrustedGcsHost(parsed.hostname)) {
      throw new Error(`Apigee archive download URI host is not a trusted GCS endpoint (${safeUrlForErrors(parsed)})`);
    }
    // URL fragments are never part of a signed-object request and must not be
    // retained if a malformed control-plane response includes one.
    parsed.hash = '';
    const response = await fetch(parsed, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.requestTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Apigee archive download failed with HTTP ${response.status} (${safeUrlForErrors(parsed)})`);
    }
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader !== null) {
      const declared = Number(lengthHeader);
      if (!Number.isFinite(declared) || declared < 0 || declared > MAX_STORAGE_OBJECT_BYTES) {
        throw new Error(`Apigee archive download exceeds ${MAX_STORAGE_OBJECT_BYTES} bytes (${safeUrlForErrors(parsed)})`);
      }
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_STORAGE_OBJECT_BYTES) {
      throw new Error(`Apigee archive download exceeds ${MAX_STORAGE_OBJECT_BYTES} bytes (${safeUrlForErrors(parsed)})`);
    }
    return bytes;
  }

  private apigeeUrl(org: string, ...segments: string[]): URL {
    return resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/apis/${segments.join('/')}`.replace(/\/$/, ''));
  }

  public async probeApiHub(projectId: string): Promise<void> {
    await this.getJson(this.locationsUrl('https://apihub.googleapis.com/', projectId), 'API Hub probe');
  }

  public async listApiHubSpecs(projectId: string): Promise<ApiHubSpecSummary[]> {
    const specs: ApiHubSpecSummary[] = [];
    for (const location of await this.listLocations('https://apihub.googleapis.com/', projectId, 'API Hub location list')) {
      let apis: Array<{ name?: string; displayName?: string }>;
      try {
        apis = await this.collectPages(
          () => resourceUrl('https://apihub.googleapis.com/', `projects/${projectId}/locations/${location}/apis`),
          'API Hub api list',
          (body: { apis?: Array<{ name?: string; displayName?: string }>; nextPageToken?: string }) => ({
            items: body.apis ?? [],
            nextPageToken: body.nextPageToken
          })
        );
      } catch {
        // The hub is provisioned in at most a few locations; unprovisioned
        // locations answer FAILED_PRECONDITION/NOT_FOUND and are skipped.
        continue;
      }
      for (const api of apis) {
        if (!api.name) continue;
        const versions = await this.collectPages(
          () => resourceUrl('https://apihub.googleapis.com/', `${api.name}/versions`),
          'API Hub version list',
          (body: { versions?: Array<{ name?: string }>; nextPageToken?: string }) => ({
            items: body.versions ?? [],
            nextPageToken: body.nextPageToken
          })
        );
        for (const version of versions) {
          if (!version.name) continue;
          const raw = await this.collectPages(
            () => resourceUrl('https://apihub.googleapis.com/', `${version.name}/specs`),
            'API Hub spec list',
            (body: { specs?: unknown[]; nextPageToken?: string }) => ({
              items: body.specs ?? [],
              nextPageToken: body.nextPageToken
            })
          );
          specs.push(...raw.map((item) => this.toApiHubSpec(item, api.displayName)));
        }
      }
    }
    return specs;
  }

  public async getApiHubSpec(specName: string): Promise<ApiHubSpecSummary> {
    const url = apiHubResourceUrl(specName);
    return this.toApiHubSpec(await this.getJson(url, 'API Hub spec get'), undefined);
  }

  public async getApiHubSpecContents(specName: string): Promise<{ contents?: string; mimeType?: string }> {
    const url = apiHubResourceUrl(specName);
    // Appending through href retains encoded path separators; assigning pathname
    // would decode `%2F` before serializing the custom method suffix.
    url.href = `${url.href}:contents`;
    const body = await this.getJson<{ contents?: string; mimeType?: string }>(url, 'API Hub spec contents');
    return { contents: body.contents, mimeType: body.mimeType };
  }

  public async fetchApiHubAdditionalSpecContent(
    specName: string,
    specContentType: ApiHubAdditionalSpecContentType
  ): Promise<{ contents?: string; mimeType?: string }> {
    const url = apiHubResourceUrl(specName);
    url.href = `${url.href}:fetchAdditionalSpecContent`;
    url.searchParams.set('specContentType', specContentType);
    const body = await this.getJson<{
      additionalSpecContent?: { specContents?: { contents?: string; mimeType?: string } };
    }>(url, 'API Hub additional spec content');
    return {
      contents: body.additionalSpecContent?.specContents?.contents,
      mimeType: body.additionalSpecContent?.specContents?.mimeType
    };
  }

  public async probeApigeeRegistry(projectId: string): Promise<void> {
    const url = this.locationsUrl('https://apigeeregistry.googleapis.com/', projectId);
    url.searchParams.set('pageSize', '1');
    await this.getJson(url, 'Apigee Registry probe');
  }

  public async listApigeeRegistrySpecs(projectId: string): Promise<ApigeeRegistrySpecSummary[]> {
    const specs: ApigeeRegistrySpecSummary[] = [];
    for (const location of await this.listLocations('https://apigeeregistry.googleapis.com/', projectId, 'Apigee Registry location list')) {
      let apis: Array<{ name?: string }>;
      try {
        apis = await this.collectPages(
          () => resourceUrl('https://apigeeregistry.googleapis.com/', `projects/${projectId}/locations/${location}/apis`),
          'Apigee Registry api list',
          (body: { apis?: Array<{ name?: string }>; nextPageToken?: string }) => ({
            items: body.apis ?? [],
            nextPageToken: body.nextPageToken
          })
        );
      } catch {
        continue;
      }
      for (const api of apis) {
        if (!api.name) continue;
        const versions = await this.collectPages(
          () => resourceUrl('https://apigeeregistry.googleapis.com/', `${api.name}/versions`),
          'Apigee Registry version list',
          (body: { versions?: Array<{ name?: string }>; nextPageToken?: string }) => ({
            items: body.versions ?? [],
            nextPageToken: body.nextPageToken
          })
        );
        for (const version of versions) {
          if (!version.name) continue;
          const raw = await this.collectPages(
            () => resourceUrl('https://apigeeregistry.googleapis.com/', `${version.name}/specs`),
            'Apigee Registry spec list',
            (body: { apiSpecs?: unknown[]; specs?: unknown[]; nextPageToken?: string }) => ({
              items: body.apiSpecs ?? body.specs ?? [],
              nextPageToken: body.nextPageToken
            })
          );
          specs.push(...raw.map((item) => this.toApigeeRegistrySpec(item)).filter((item) => item.name));
        }
      }
    }
    return specs;
  }

  public async getApigeeRegistrySpec(specName: string): Promise<ApigeeRegistrySpecSummary> {
    const url = resourceUrl('https://apigeeregistry.googleapis.com/', specName);
    return this.toApigeeRegistrySpec(await this.getJson(url, 'Apigee Registry spec get'));
  }

  public async getApigeeRegistrySpecContents(specName: string): Promise<{ bytes: Buffer; mimeType?: string }> {
    const url = resourceUrl('https://apigeeregistry.googleapis.com/', specName);
    url.pathname = `${url.pathname}:getContents`;
    return this.getBoundedBinary(url, 'Apigee Registry spec contents');
  }

  public async probeApigeePortal(org: string): Promise<void> { await this.getJson(resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/sites`), 'Apigee portal probe'); }
  public async listApigeePortalSites(org: string): Promise<ApigeePortalSite[]> { return this.collectPages(() => resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/sites`), 'Apigee portal site list', (body: { sites?: Array<{ id?: string; name?: string }>; nextPageToken?: string }) => ({ items: (body.sites ?? []).map((x) => ({ id: x.id ?? x.name?.split('/').pop() ?? '', name: x.name })).filter((x) => x.id), nextPageToken: body.nextPageToken })); }
  public async listApigeePortalApidocs(org: string, siteId: string): Promise<ApigeePortalApidoc[]> { return this.collectPages(() => resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/sites/${siteId}/apidocs`), 'Apigee portal apidoc list', (body: { data?: ApigeePortalApidoc[]; nextPageToken?: string }) => ({ items: body.data ?? [], nextPageToken: body.nextPageToken })); }
  public async getApigeePortalDocumentation(org: string, siteId: string, apidocId: string): Promise<ApigeePortalDocumentation> {
    const body = await this.getJson<Record<string, unknown>>(
      resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/sites/${siteId}/apidocs/${apidocId}/documentation`),
      'Apigee portal documentation get'
    );
    return parseApigeePortalDocumentationBody(body);
  }
  public async probeVertexExtensions(projectId: string, location: string): Promise<void> {
    const url = resourceUrl(
      `https://${location}-aiplatform.googleapis.com/`,
      `projects/${projectId}/locations/${location}/extensions`,
      'v1beta1'
    );
    url.searchParams.set('pageSize', '1');
    await this.getJson(url, 'Vertex Extensions probe');
  }

  public async listVertexLocations(projectId: string): Promise<string[]> {
    return this.listLocations('https://aiplatform.googleapis.com/', projectId, 'Vertex AI location list');
  }

  public async listVertexExtensions(projectId: string, location: string): Promise<VertexExtensionSummary[]> {
    return this.collectPages(
      () => resourceUrl(
        `https://${location}-aiplatform.googleapis.com/`,
        `projects/${projectId}/locations/${location}/extensions`,
        'v1beta1'
      ),
      'Vertex Extensions list',
      (body: {
        extensions?: Array<{
          name?: string;
          displayName?: string;
          manifest?: { apiSpec?: { openApiYaml?: string; openApiGcsUri?: string } };
        }>;
        nextPageToken?: string;
      }) => ({
        items: (body.extensions ?? [])
          .filter((extension) => extension.name)
          .map((extension) => ({
            name: extension.name!,
            displayName: extension.displayName,
            openApiYaml: extension.manifest?.apiSpec?.openApiYaml,
            openApiGcsUri: extension.manifest?.apiSpec?.openApiGcsUri
          })),
        nextPageToken: body.nextPageToken
      })
    );
  }

  public async probeAgentEngines(projectId: string, location: string): Promise<void> {
    const url = resourceUrl(
      `https://${location}-aiplatform.googleapis.com/`,
      `projects/${projectId}/locations/${location}/reasoningEngines`
    );
    url.searchParams.set('pageSize', '1');
    await this.getJson(url, 'Vertex Agent Engines probe');
  }

  public async listAgentEngines(projectId: string, location: string): Promise<AgentEngineSummary[]> {
    return this.collectPages(
      () => resourceUrl(
        `https://${location}-aiplatform.googleapis.com/`,
        `projects/${projectId}/locations/${location}/reasoningEngines`
      ),
      'Vertex Agent Engines list',
      (body: {
        reasoningEngines?: Array<{
          name?: string;
          displayName?: string;
          spec?: { classMethods?: Array<Record<string, unknown>> };
        }>;
        nextPageToken?: string;
      }) => ({
        items: (body.reasoningEngines ?? [])
          .filter((engine) => engine.name)
          .map((engine) => ({
            name: engine.name!,
            displayName: engine.displayName,
            classMethods: engine.spec?.classMethods ?? []
          })),
        nextPageToken: body.nextPageToken
      })
    );
  }

  public async probeDialogflow(projectId: string): Promise<void> {
    const url = resourceUrl(
      'https://dialogflow.googleapis.com/',
      `projects/${projectId}/locations/global/agents`,
      'v3'
    );
    url.searchParams.set('pageSize', '1');
    await this.getJson(url, 'Dialogflow probe');
  }

  public async listDialogflowAgents(projectId: string): Promise<DialogflowAgentSummary[]> {
    const agents: DialogflowAgentSummary[] = [];
    for (const location of await this.listLocations(
      'https://dialogflow.googleapis.com/',
      projectId,
      'Dialogflow location list',
      'v3'
    )) {
      const origin = location === 'global'
        ? 'https://dialogflow.googleapis.com/'
        : `https://${location}-dialogflow.googleapis.com/`;
      agents.push(...await this.collectPages(
        () => resourceUrl(origin, `projects/${projectId}/locations/${location}/agents`, 'v3'),
        'Dialogflow agent list',
        (body: { agents?: DialogflowAgentSummary[]; nextPageToken?: string }) => ({
          items: body.agents ?? [],
          nextPageToken: body.nextPageToken
        })
      ));
    }
    return agents;
  }

  public async listDialogflowTools(agentName: string): Promise<DialogflowToolSummary[]> {
    const location = /\/locations\/([^/]+)\//.exec(agentName)?.[1] ?? 'global';
    const origin = location === 'global'
      ? 'https://dialogflow.googleapis.com/'
      : `https://${location}-dialogflow.googleapis.com/`;
    return this.collectPages(
      () => resourceUrl(origin, `${agentName}/tools`, 'v3'),
      'Dialogflow tool list',
      (body: {
        tools?: Array<{ name: string; displayName?: string; openApiSpec?: { textSchema?: string } }>;
        nextPageToken?: string;
      }) => ({
        items: (body.tools ?? []).map((tool) => ({
          name: tool.name,
          displayName: tool.displayName,
          textSchema: tool.openApiSpec?.textSchema
        })),
        nextPageToken: body.nextPageToken
      })
    );
  }
  public async probeCes(projectId: string): Promise<void> { const url = resourceUrl('https://ces.googleapis.com/', `projects/${projectId}/locations/global/apps`); url.searchParams.set('pageSize', '1'); await this.getJson(url, 'CES probe'); }
  public async listCesToolsets(projectId: string): Promise<CesToolsetSummary[]> {
    const apps = await this.collectPages(
      () => resourceUrl('https://ces.googleapis.com/', `projects/${projectId}/locations/global/apps`),
      'CES app list',
      (body: { apps?: Array<{ name?: string; toolsets?: unknown[] }>; nextPageToken?: string }) => ({ items: body.apps ?? [], nextPageToken: body.nextPageToken })
    );
    const toolsets: CesToolsetSummary[] = [];
    for (const app of apps) {
      const embedded = Array.isArray(app.toolsets) ? app.toolsets : [];
      const listed = app.name
        ? await this.collectPages(
          () => resourceUrl('https://ces.googleapis.com/', `${app.name}/toolsets`),
          'CES toolset list',
          (body: { toolsets?: unknown[]; nextPageToken?: string }) => ({ items: body.toolsets ?? [], nextPageToken: body.nextPageToken })
        )
        : [];
      const standaloneTools = app.name
        ? await this.collectPages(
          () => resourceUrl('https://ces.googleapis.com/', `${app.name}/tools`),
          'CES tool list',
          (body: { tools?: unknown[]; nextPageToken?: string }) => ({ items: body.tools ?? [], nextPageToken: body.nextPageToken })
        )
        : [];
      for (const value of [...embedded, ...listed]) {
        const item = (value ?? {}) as { name?: string; displayName?: string; openApiToolset?: { openApiSchema?: string; tools?: Array<{ name?: string; displayName?: string; openApiTool?: { openApiSchema?: string } }> }; tools?: Array<{ name?: string; displayName?: string; openApiTool?: { openApiSchema?: string } }> };
        if (!item.name) continue;
        const retrieveUrl = resourceUrl('https://ces.googleapis.com/', item.name);
        retrieveUrl.pathname = `${retrieveUrl.pathname}:retrieveTools`;
        const retrieveBody = await this.postJson<CesRetrieveToolsResponse>(retrieveUrl, 'CES toolset tool retrieval', {});
        const retrieved = retrieveBody.tools ?? [];
        const directSchema = item.openApiToolset?.openApiSchema?.trim();
        if (directSchema) toolsets.push({ name: item.name, displayName: item.displayName, openApiSchema: directSchema });
        const nested = [...(item.openApiToolset?.tools ?? []), ...(item.tools ?? [])]
          .filter((tool) => Boolean(tool.openApiTool?.openApiSchema?.trim()));
        if (!directSchema && nested.length > 0) {
          const first = nested[0]!;
          toolsets.push({ name: first.name ?? item.name, displayName: first.displayName ?? item.displayName, openApiSchema: first.openApiTool!.openApiSchema });
        }
        for (const tool of nested.slice(directSchema ? 0 : 1)) {
          if (tool.name) toolsets.push({ name: tool.name, displayName: tool.displayName ?? item.displayName, openApiSchema: tool.openApiTool!.openApiSchema });
        }
        for (const tool of retrieved.filter((value) => Boolean(value.openApiTool?.openApiSchema?.trim()))) {
          if (tool.name) toolsets.push({ name: tool.name, displayName: tool.displayName ?? item.displayName, openApiSchema: tool.openApiTool!.openApiSchema });
        }
        if (!directSchema && nested.length === 0) toolsets.push({ name: item.name, displayName: item.displayName });
      }
      for (const value of standaloneTools) {
        const tool = (value ?? {}) as { name?: string; displayName?: string; openApiTool?: { openApiSchema?: string } };
        if (tool.name) toolsets.push({ name: tool.name, displayName: tool.displayName, openApiSchema: tool.openApiTool?.openApiSchema });
      }
    }
    return toolsets;
  }

  public async probeAppIntegration(projectId: string): Promise<void> {
    await this.getJson(this.locationsUrl('https://integrations.googleapis.com/', projectId), 'Application Integration probe');
  }

  public async listAppIntegrationApiTriggers(projectId: string): Promise<AppIntegrationApiTrigger[]> {
    const triggers: AppIntegrationApiTrigger[] = [];
    for (const location of await this.listLocations('https://integrations.googleapis.com/', projectId, 'Application Integration location list')) {
      let integrations: Array<{ name?: string; updateTime?: string }>;
      try {
        integrations = await this.collectPages(
          () => resourceUrl('https://integrations.googleapis.com/', `projects/${projectId}/locations/${location}/integrations`),
          'Application Integration list',
          (body: { integrations?: Array<{ name?: string; updateTime?: string }>; nextPageToken?: string }) => ({
            items: body.integrations ?? [],
            nextPageToken: body.nextPageToken
          })
        );
      } catch {
        // Application Integration is regional; unprovisioned regions are skipped.
        continue;
      }
      for (const integration of integrations) {
        if (!integration.name) continue;
        const versions = await this.collectPages(
          () => {
            const versionsUrl = resourceUrl('https://integrations.googleapis.com/', `${integration.name}/versions`);
            versionsUrl.searchParams.set('filter', 'state=ACTIVE');
            return versionsUrl;
          },
          'Application Integration version list',
          (body: {
            integrationVersions?: Array<{
              name?: string;
              updateTime?: string;
              triggerConfigs?: Array<{ triggerId?: string }>;
            }>;
            nextPageToken?: string;
          }) => ({
            items: body.integrationVersions ?? [],
            nextPageToken: body.nextPageToken
          })
        );
        const orderedVersions = [...versions].sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''));
        for (const version of orderedVersions) {
          const triggerIds = (version.triggerConfigs ?? [])
            .map((config) => config.triggerId ?? '')
            .filter((id) => id.startsWith('api_trigger/'))
            .sort((left, right) => left.localeCompare(right));
          if (triggerIds.length === 0) continue;
          triggers.push({
            integrationResource: integration.name,
            location,
            triggerIds,
            updateTime: version.updateTime ?? integration.updateTime,
            versionName: version.name
          });
        }
      }
    }
    return triggers;
  }

  public async generateAppIntegrationOpenApiSpec(location: string, integrationResource: string, triggerIds: string[]): Promise<string> {
    const projectSegment = integrationResource.split('/')[1] ?? '';
    const url = resourceUrl(
      'https://integrations.googleapis.com/',
      `projects/${projectSegment}/locations/${location}:generateOpenApiSpec`
    );
    const body = await this.postJson<{ openApiSpec?: string }>(url, 'Application Integration OpenAPI generation', {
      apiTriggerResources: [{ integrationResource, triggerId: triggerIds }],
      fileFormat: 'YAML'
    });
    if (!body.openApiSpec) throw new Error('Application Integration OpenAPI generation returned no document');
    return body.openApiSpec;
  }

  public async probeConnectors(projectId: string): Promise<void> {
    const url = resourceUrl('https://connectors.googleapis.com/', `projects/${projectId}/locations/global/customConnectors`);
    url.searchParams.set('pageSize', '1');
    await this.getJson(url, 'Integration Connectors probe');
  }

  public async listCustomConnectorVersions(projectId: string): Promise<CustomConnectorVersionSummary[]> {
    const connectors = await this.collectPages(
      () => resourceUrl('https://connectors.googleapis.com/', `projects/${projectId}/locations/global/customConnectors`),
      'Integration Connectors custom connector list',
      (body: { customConnectors?: Array<{ name?: string }>; nextPageToken?: string }) => ({
        items: body.customConnectors ?? [],
        nextPageToken: body.nextPageToken
      })
    );
    const versions: CustomConnectorVersionSummary[] = [];
    for (const connector of connectors) {
      if (!connector.name) continue;
      const raw = await this.collectPages(
        () => resourceUrl('https://connectors.googleapis.com/', `${connector.name}/customConnectorVersions`),
        'Integration Connectors custom connector version list',
        (body: { customConnectorVersions?: unknown[]; nextPageToken?: string }) => ({
          items: body.customConnectorVersions ?? [],
          nextPageToken: body.nextPageToken
        })
      );
      versions.push(...raw.map((item) => this.toCustomConnectorVersion(item)));
    }
    return versions;
  }

  public async listConnectorConnections(projectId: string): Promise<ConnectorConnectionSummary[]> {
    const connections: ConnectorConnectionSummary[] = [];
    for (const location of await this.listLocations('https://connectors.googleapis.com/', projectId, 'Integration Connectors location list')) {
      try {
        connections.push(...await this.collectPages(
          () => resourceUrl('https://connectors.googleapis.com/', `projects/${projectId}/locations/${location}/connections`),
          'Integration Connectors connection list',
          (body: { connections?: ConnectorConnectionSummary[]; nextPageToken?: string }) => ({ items: body.connections ?? [], nextPageToken: body.nextPageToken })
        ));
      } catch { /* regional surface is absent or unauthorized; continue */ }
    }
    return connections.filter((connection) => Boolean(connection.name));
  }

  public async getConnectorSchemaMetadata(connectionName: string): Promise<ConnectorSchemaMetadata | undefined> {
    const url = resourceUrl('https://connectors.googleapis.com/', `${connectionName}/connectionSchemaMetadata`);
    try {
      const body = await this.getJson<{
        entities?: unknown;
        actions?: unknown;
        name?: unknown;
        state?: unknown;
        updateTime?: unknown;
        refreshTime?: unknown;
        errorMessage?: unknown;
      }>(url, 'Integration Connectors schema metadata retrieval');
      const entities = Array.isArray(body.entities)
        ? body.entities.filter((entity): entity is string => typeof entity === 'string')
        : undefined;
      const actions = Array.isArray(body.actions)
        ? body.actions.filter((action): action is string => typeof action === 'string')
        : undefined;
      const metadata: ConnectorSchemaMetadata = {
        ...(entities ? { entities } : {}),
        ...(actions ? { actions } : {}),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.state === 'string' ? { state: body.state } : {}),
        ...(typeof body.updateTime === 'string' ? { updateTime: body.updateTime } : {}),
        ...(typeof body.refreshTime === 'string' ? { refreshTime: body.refreshTime } : {}),
        ...(typeof body.errorMessage === 'string' ? { errorMessage: body.errorMessage } : {})
      };
      return Object.keys(metadata).length > 0 ? metadata : undefined;
    } catch (error) {
      if (/HTTP (?:400|404)/.test(error instanceof Error ? error.message : String(error))) return undefined;
      throw error;
    }
  }

  public async getStorageObjectText(bucket: string, object: string): Promise<string> {
    const objectPath = `storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`;
    const metadataUrl = new URL(objectPath, 'https://storage.googleapis.com/');
    const metadata = await this.getJson<{
      generation?: string;
      size?: string;
      contentType?: string;
      crc32c?: string;
      md5Hash?: string;
    }>(metadataUrl, 'Cloud Storage object metadata');

    const generation = metadata.generation?.trim();
    if (!generation) {
      throw new Error('Cloud Storage object metadata omitted generation');
    }
    const size = Number(metadata.size);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('Cloud Storage object metadata omitted a valid size');
    }
    if (size > MAX_STORAGE_OBJECT_BYTES) {
      throw new Error('Cloud Storage object exceeds 10 MiB');
    }
    void metadata.contentType;

    const mediaUrl = new URL(objectPath, 'https://storage.googleapis.com/');
    mediaUrl.searchParams.set('alt', 'media');
    mediaUrl.searchParams.set('generation', generation);
    const bytes = await this.getBinary(mediaUrl, 'Cloud Storage spec object download');
    if (bytes.byteLength > MAX_STORAGE_OBJECT_BYTES) {
      throw new Error('Cloud Storage object exceeds 10 MiB');
    }

    if (metadata.crc32c) {
      if (crc32cBase64(bytes) !== metadata.crc32c) {
        throw new Error('Cloud Storage object CRC32C mismatch');
      }
    } else if (metadata.md5Hash) {
      if (createHash('md5').update(bytes).digest('base64') !== metadata.md5Hash) {
        throw new Error('Cloud Storage object MD5 mismatch');
      }
    } else {
      throw new Error('Cloud Storage object metadata omitted CRC32C and MD5 checksums');
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Cloud Storage object is not valid UTF-8');
    }
  }

  private locationsUrl(origin: string, projectId: string, apiVersion = 'v1'): URL {
    const url = resourceUrl(origin, `projects/${projectId}/locations`, apiVersion);
    url.searchParams.set('pageSize', '200');
    return url;
  }

  private async listLocations(
    origin: string,
    projectId: string,
    operation: string,
    apiVersion = 'v1'
  ): Promise<string[]> {
    return this.collectPages(
      () => this.locationsUrl(origin, projectId, apiVersion),
      operation,
      (body: { locations?: Array<{ locationId?: string }>; nextPageToken?: string }) => ({
        items: (body.locations ?? []).map((location) => location.locationId ?? '').filter((locationId) => locationId.length > 0),
        nextPageToken: body.nextPageToken
      }),
      200
    );
  }

  private toApiHubSpec(value: unknown, apiDisplayName: string | undefined): ApiHubSpecSummary {
    const item = (value ?? {}) as Record<string, unknown>;
    const specType = item.specType as { enumValues?: { values?: Array<{ id?: string }> } } | undefined;
    return {
      name: typeof item.name === 'string' ? item.name : '',
      displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
      apiDisplayName,
      specTypeIds: (specType?.enumValues?.values ?? [])
        .map((entry) => entry.id ?? '')
        .filter((id) => id.length > 0),
      attributes: flattenApiHubAttributes(item.attributes),
      createTime: typeof item.createTime === 'string' ? item.createTime : undefined,
      sourceUri: typeof item.sourceUri === 'string' ? item.sourceUri : undefined,
      additionalSpecContentTypes: parseApiHubAdditionalContentTypes(item.additionalSpecContents)
    };
  }

  private toApigeeArchiveDeployment(value: unknown): ApigeeArchiveDeploymentSummary {
    const item = (value ?? {}) as Record<string, unknown>;
    return {
      name: typeof item.name === 'string' ? item.name : '',
      labels: normalizeLabels(item.labels),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined
    };
  }

  private toApigeeRegistrySpec(value: unknown): ApigeeRegistrySpecSummary {
    const item = (value ?? {}) as Record<string, unknown>;
    return {
      name: typeof item.name === 'string' ? item.name : '',
      filename: typeof item.filename === 'string' ? item.filename : undefined,
      description: typeof item.description === 'string' ? item.description : undefined,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
      sizeBytes: typeof item.sizeBytes === 'number' ? item.sizeBytes : undefined,
      labels: normalizeLabels(item.labels),
      createTime: typeof item.createTime === 'string' ? item.createTime : undefined
    };
  }

  private toCustomConnectorVersion(value: unknown): CustomConnectorVersionSummary {
    const item = (value ?? {}) as Record<string, unknown>;
    return {
      name: typeof item.name === 'string' ? item.name : '',
      specLocation: typeof item.specLocation === 'string' ? item.specLocation : undefined,
      labels: normalizeLabels(item.labels),
      updateTime: typeof item.updateTime === 'string' ? item.updateTime : undefined
    };
  }

  private async postJson<T>(url: URL, operation: string, data: unknown): Promise<T> {
    const requester = await this.requester();
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        const response = await requester.request<T>({
          url: url.toString(),
          method: 'POST',
          timeout: this.options.requestTimeoutMs,
          retry: false,
          data
        });
        return response.data;
      } catch (error) {
        if (!isTransient(error) || attempt === this.options.maxAttempts) {
          const status = errorStatus(error);
          const suffix = status === undefined ? '' : ` with HTTP ${status}`;
          throw new Error(`${operation} failed${suffix} after ${attempt} attempt(s)`, { cause: error });
        }
      }
    }
    throw new Error(`${operation} exhausted its attempt limit`);
  }

  private async getBinary(url: URL, operation: string): Promise<Buffer> {
    return (await this.getBoundedBinary(url, operation)).bytes;
  }

  private async getBoundedBinary(url: URL, operation: string): Promise<{ bytes: Buffer; mimeType?: string }> {
    const requester = await this.requester();
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        const response = await requester.request<ArrayBuffer | Uint8Array | Buffer>({
          url: url.toString(),
          method: 'GET',
          timeout: this.options.requestTimeoutMs,
          retry: false,
          responseType: 'arraybuffer'
        });
        const bytes = Buffer.from(response.data as ArrayBuffer);
        if (bytes.byteLength > MAX_STORAGE_OBJECT_BYTES) {
          throw new Error(`${operation} exceeds ${MAX_STORAGE_OBJECT_BYTES} bytes`);
        }
        return { bytes, mimeType: headerValue(response.headers, 'content-type') };
      } catch (error) {
        if (!isTransient(error) || attempt === this.options.maxAttempts) {
          if (error instanceof Error && error.message.includes('exceeds')) throw error;
          const status = errorStatus(error);
          throw new Error(`${operation} failed${status === undefined ? '' : ` with HTTP ${status}`} after ${attempt} attempt(s)`, { cause: error });
        }
      }
    }
    throw new Error(`${operation} exhausted its attempt limit`);
  }

  private async collectPages<T, B>(
    createUrl: () => URL,
    operation: string,
    select: (body: B) => { items: T[]; nextPageToken?: string },
    pageSize = 1000
  ): Promise<T[]> {
    const results: T[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const url = createUrl();
      url.searchParams.set('pageSize', String(pageSize));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const selected = select(await this.getJson<B>(url, operation));
      results.push(...selected.items);
      const next = selected.nextPageToken?.trim() || undefined;
      if (!next) return results;
      if (seenTokens.has(next)) {
        throw new Error(`${operation} returned a repeated page token; aborting`);
      }
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error(`${operation} exceeded ${MAX_LIST_PAGES} pages; aborting`);
  }

  private async getJson<T>(url: URL, operation: string): Promise<T> {
    const requester = await this.requester();
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        const response = await requester.request<T>({
          url: url.toString(),
          method: 'GET',
          timeout: this.options.requestTimeoutMs,
          retry: false
        });
        return response.data;
      } catch (error) {
        if (!isTransient(error) || attempt === this.options.maxAttempts) {
          const status = errorStatus(error);
          const suffix = status === undefined ? '' : ` with HTTP ${status}`;
          throw new Error(`${operation} failed${suffix} after ${attempt} attempt(s)`, { cause: error });
        }
      }
    }
    throw new Error(`${operation} exhausted its attempt limit`);
  }

  private toGatewayApi(value: unknown): ApiGatewayApi {
    const item = (value ?? {}) as Record<string, unknown>;
    return {
      name: typeof item.name === 'string' ? item.name : '',
      displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
      labels: normalizeLabels(item.labels),
      state: typeof item.state === 'string' ? item.state : undefined
    };
  }

  private toGatewaySourceFile(value: unknown): GcpSourceFile {
    const item = (value ?? {}) as Record<string, unknown>;
    return {
      path: typeof item.path === 'string' ? item.path : undefined,
      contents: typeof item.contents === 'string' ? item.contents : undefined
    };
  }

  private toGatewayOpenApiDocument(value: unknown): { document?: GcpSourceFile } {
    const item = (value ?? {}) as Record<string, unknown>;
    if (!item.document || typeof item.document !== 'object' || Array.isArray(item.document)) {
      return {};
    }
    return { document: this.toGatewaySourceFile(item.document) };
  }

  private toGatewayGrpcService(value: unknown): ApiGatewayGrpcServiceDefinition {
    const item = (value ?? {}) as Record<string, unknown>;
    const fileDescriptorSet =
      item.fileDescriptorSet && typeof item.fileDescriptorSet === 'object' && !Array.isArray(item.fileDescriptorSet)
        ? this.toGatewaySourceFile(item.fileDescriptorSet)
        : undefined;
    const source = Array.isArray(item.source)
      ? item.source
          .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => this.toGatewaySourceFile(entry))
      : [];
    return { fileDescriptorSet, source };
  }

  private toGatewayConfig(value: unknown): ApiGatewayConfig {
    const item = (value ?? {}) as Record<string, unknown>;
    return {
      name: typeof item.name === 'string' ? item.name : '',
      displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
      labels: normalizeLabels(item.labels),
      state: typeof item.state === 'string' ? item.state : undefined,
      createTime: typeof item.createTime === 'string' ? item.createTime : undefined,
      updateTime: typeof item.updateTime === 'string' ? item.updateTime : undefined,
      openapiDocuments: Array.isArray(item.openapiDocuments)
        ? item.openapiDocuments.map((entry) => this.toGatewayOpenApiDocument(entry))
        : [],
      grpcServices: Array.isArray(item.grpcServices)
        ? item.grpcServices.map((entry) => this.toGatewayGrpcService(entry))
        : [],
      managedServiceConfigs: Array.isArray(item.managedServiceConfigs)
        ? item.managedServiceConfigs
            .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
            .map((entry) => this.toGatewaySourceFile(entry))
        : []
    };
  }

  private toManagedService(value: unknown): ManagedService {
    const item = (value ?? {}) as Record<string, unknown>;
    return {
      serviceName: typeof item.serviceName === 'string' ? item.serviceName : '',
      producerProjectId: typeof item.producerProjectId === 'string' ? item.producerProjectId : undefined
    };
  }

  private toEndpointSourceFile(value: unknown): EndpointSourceFile {
    const item = (value ?? {}) as Record<string, unknown>;
    const mapped: EndpointSourceFile = {
      filePath: typeof item.filePath === 'string' ? item.filePath : undefined,
      fileContents: typeof item.fileContents === 'string' ? item.fileContents : undefined,
      fileType: typeof item.fileType === 'string' ? item.fileType : undefined
    };
    if (typeof item['@type'] === 'string') {
      mapped['@type'] = item['@type'];
    }
    return mapped;
  }

  private toEndpointConfig(value: unknown): EndpointServiceConfig {
    const item = (value ?? {}) as Record<string, unknown>;
    const sourceInfo = item.sourceInfo as { sourceFiles?: unknown[] } | undefined;
    return {
      id: typeof item.id === 'string' ? item.id : '',
      name: typeof item.name === 'string' ? item.name : undefined,
      title: typeof item.title === 'string' ? item.title : undefined,
      producerProjectId: typeof item.producerProjectId === 'string' ? item.producerProjectId : undefined,
      sourceInfo: sourceInfo && Array.isArray(sourceInfo.sourceFiles)
        ? {
            sourceFiles: sourceInfo.sourceFiles
              .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
              .map((entry) => this.toEndpointSourceFile(entry))
          }
        : undefined
    };
  }
}
