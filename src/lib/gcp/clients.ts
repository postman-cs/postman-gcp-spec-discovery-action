import { GoogleAuth } from 'google-auth-library';

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
  request<T>(options: GcpRequestOptions): Promise<{ data: T; status?: number }>;
}

export interface ApiGatewayApi {
  name: string;
  displayName?: string;
  labels: Record<string, string>;
  state?: string;
}

export interface GcpSourceFile {
  path?: string;
  contents?: string;
}

export interface ApiGatewayConfig {
  name: string;
  displayName?: string;
  labels: Record<string, string>;
  state?: string;
  createTime?: string;
  updateTime?: string;
  openapiDocuments: Array<{ document?: GcpSourceFile }>;
  grpcServices: unknown[];
  managedServiceConfigs: GcpSourceFile[];
}

export interface ManagedService {
  serviceName: string;
  producerProjectId?: string;
}

export interface EndpointSourceFile {
  filePath?: string;
  fileContents?: string;
  fileType?: string;
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
}

export interface ApigeePortalSite { id: string; name?: string; }
export interface ApigeePortalApidoc { id: string; title?: string; specId?: string; apiProductName?: string; }
export interface ApigeePortalDocumentation { type: 'oasDocumentation' | 'graphqlDocumentation' | 'asyncapiDocumentation' | 'missing'; contents?: string; }
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
}

export interface CustomConnectorVersionSummary {
  name: string;
  specLocation?: string;
  labels: Record<string, string>;
  updateTime?: string;
}

export interface ConnectorConnectionSummary { name: string; description?: string; serviceAccount?: string; }
export interface ConnectorSchemaMetadata { entities?: Record<string, { fields?: Array<{ name?: string; dataType?: string; description?: string }> }>; actions?: Array<{ name?: string; description?: string }> }

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
  listApigeeEnvironmentOasFiles(org: string, environment: string): Promise<string[]>;
  getApigeeEnvironmentOasFile(org: string, environment: string, name: string): Promise<string>;
  probeApiHub(projectId: string): Promise<void>;
  listApiHubSpecs(projectId: string): Promise<ApiHubSpecSummary[]>;
  getApiHubSpec(specName: string): Promise<ApiHubSpecSummary>;
  getApiHubSpecContents(specName: string): Promise<{ contents?: string; mimeType?: string }>;
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

function resourceUrl(origin: string, resourceName: string): URL {
  const encoded = resourceName.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return new URL(`v1/${encoded}`, origin);
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
      : () => auth.getClient() as Promise<GcpAuthenticatedRequester>;
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

  public async listApigeeEnvironmentOasFiles(org: string, environment: string): Promise<string[]> {
    const url = resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/environments/${environment}/resourcefiles`);
    url.searchParams.set('type', 'oas');
    const body = await this.getJson<{ resourceFile?: Array<{ name?: string }> }>(url, 'Apigee environment OAS resource list');
    return (body.resourceFile ?? []).map((file) => file.name ?? '').filter(Boolean);
  }

  public async getApigeeEnvironmentOasFile(org: string, environment: string, name: string): Promise<string> {
    const bytes = await this.getBinary(resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/environments/${environment}/resourcefiles/oas/${name}`), 'Apigee environment OAS resource download');
    return bytes.toString('utf8');
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
    const url = resourceUrl('https://apihub.googleapis.com/', specName);
    return this.toApiHubSpec(await this.getJson(url, 'API Hub spec get'), undefined);
  }

  public async getApiHubSpecContents(specName: string): Promise<{ contents?: string; mimeType?: string }> {
    const url = resourceUrl('https://apihub.googleapis.com/', `${specName}:contents`);
    const body = await this.getJson<{ contents?: string; mimeType?: string }>(url, 'API Hub spec contents');
    return { contents: body.contents, mimeType: body.mimeType };
  }

  public async probeApigeePortal(org: string): Promise<void> { const url = resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/sites`); url.searchParams.set('pageSize', '1'); await this.getJson(url, 'Apigee portal probe'); }
  public async listApigeePortalSites(org: string): Promise<ApigeePortalSite[]> { return this.collectPages(() => resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/sites`), 'Apigee portal site list', (body: { sites?: Array<{ id?: string; name?: string }>; nextPageToken?: string }) => ({ items: (body.sites ?? []).map((x) => ({ id: x.id ?? x.name?.split('/').pop() ?? '', name: x.name })).filter((x) => x.id), nextPageToken: body.nextPageToken })); }
  public async listApigeePortalApidocs(org: string, siteId: string): Promise<ApigeePortalApidoc[]> { return this.collectPages(() => resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/sites/${siteId}/apidocs`), 'Apigee portal apidoc list', (body: { data?: ApigeePortalApidoc[]; nextPageToken?: string }) => ({ items: body.data ?? [], nextPageToken: body.nextPageToken })); }
  public async getApigeePortalDocumentation(org: string, siteId: string, apidocId: string): Promise<ApigeePortalDocumentation> { const body = await this.getJson<{ data?: Record<string, unknown> }>(resourceUrl('https://apigee.googleapis.com/', `organizations/${org}/sites/${siteId}/apidocs/${apidocId}/documentation`), 'Apigee portal documentation get'); const data = body.data ?? {}; for (const type of ['oasDocumentation', 'graphqlDocumentation', 'asyncapiDocumentation'] as const) { if (data[type]) return { type, contents: type === 'oasDocumentation' ? (data[type] as { spec?: { contents?: string } }).spec?.contents : undefined }; } return { type: 'missing' }; }
  public async probeVertexExtensions(projectId: string, location: string): Promise<void> { const url = resourceUrl(`https://${location}-aiplatform.googleapis.com/`, `projects/${projectId}/locations/${location}/extensions`); url.searchParams.set('pageSize', '1'); await this.getJson(url, 'Vertex Extensions probe'); }
  public async listVertexLocations(projectId: string): Promise<string[]> { return this.listLocations('https://aiplatform.googleapis.com/', projectId, 'Vertex AI location list'); }
  public async listVertexExtensions(projectId: string, location: string): Promise<VertexExtensionSummary[]> { return this.collectPages(() => resourceUrl(`https://${location}-aiplatform.googleapis.com/`, `projects/${projectId}/locations/${location}/extensions`), 'Vertex Extensions list', (body: { extensions?: Array<{ name?: string; displayName?: string; manifest?: { apiSpec?: { openApiYaml?: string; openApiGcsUri?: string } } }>; nextPageToken?: string }) => ({ items: (body.extensions ?? []).filter((x) => x.name).map((x) => ({ name: x.name!, displayName: x.displayName, openApiYaml: x.manifest?.apiSpec?.openApiYaml, openApiGcsUri: x.manifest?.apiSpec?.openApiGcsUri })), nextPageToken: body.nextPageToken })); }
  public async probeAgentEngines(projectId: string, location: string): Promise<void> { const url = resourceUrl(`https://${location}-aiplatform.googleapis.com/`, `projects/${projectId}/locations/${location}/reasoningEngines`); url.searchParams.set('pageSize', '1'); await this.getJson(url, 'Vertex Agent Engines probe'); }
  public async listAgentEngines(projectId: string, location: string): Promise<AgentEngineSummary[]> { return this.collectPages(() => resourceUrl(`https://${location}-aiplatform.googleapis.com/`, `projects/${projectId}/locations/${location}/reasoningEngines`), 'Vertex Agent Engines list', (body: { reasoningEngines?: Array<{ name?: string; displayName?: string; spec?: { classMethods?: Array<Record<string, unknown>> } }>; nextPageToken?: string }) => ({ items: (body.reasoningEngines ?? []).filter((x) => x.name).map((x) => ({ name: x.name!, displayName: x.displayName, classMethods: x.spec?.classMethods ?? [] })), nextPageToken: body.nextPageToken })); }
  public async probeDialogflow(projectId: string): Promise<void> { const url = resourceUrl('https://dialogflow.googleapis.com/', `projects/${projectId}/locations/global/agents`); url.searchParams.set('pageSize', '1'); await this.getJson(url, 'Dialogflow probe'); }
  public async listDialogflowAgents(projectId: string): Promise<DialogflowAgentSummary[]> { const agents: DialogflowAgentSummary[]=[]; for(const location of await this.listLocations('https://dialogflow.googleapis.com/',projectId,'Dialogflow location list')){const origin=location==='global'?'https://dialogflow.googleapis.com/':`https://${location}-dialogflow.googleapis.com/`;agents.push(...await this.collectPages(() => resourceUrl(origin, `projects/${projectId}/locations/${location}/agents`), 'Dialogflow agent list', (body: { agents?: DialogflowAgentSummary[]; nextPageToken?: string }) => ({ items: body.agents ?? [], nextPageToken: body.nextPageToken })));}return agents; }
  public async listDialogflowTools(agentName: string): Promise<DialogflowToolSummary[]> { const location=/\/locations\/([^/]+)\//.exec(agentName)?.[1]??'global';const origin=location==='global'?'https://dialogflow.googleapis.com/':`https://${location}-dialogflow.googleapis.com/`;return this.collectPages(() => resourceUrl(origin, `${agentName}/tools`), 'Dialogflow tool list', (body: { tools?: Array<{ name: string; displayName?: string; openApiSpec?: { textSchema?: string } }>; nextPageToken?: string }) => ({ items: (body.tools ?? []).map((x) => ({ name: x.name, displayName: x.displayName, textSchema: x.openApiSpec?.textSchema })), nextPageToken: body.nextPageToken })); }
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
        const versionsUrl = resourceUrl('https://integrations.googleapis.com/', `${integration.name}/versions`);
        versionsUrl.searchParams.set('filter', 'state=ACTIVE');
        versionsUrl.searchParams.set('pageSize', '1');
        const versions = await this.getJson<{
          integrationVersions?: Array<{ triggerConfigs?: Array<{ triggerId?: string }> }>;
        }>(versionsUrl, 'Application Integration version list');
        const active = versions.integrationVersions?.[0];
        const triggerIds = (active?.triggerConfigs ?? [])
          .map((config) => config.triggerId ?? '')
          .filter((id) => id.startsWith('api_trigger/'));
        if (triggerIds.length > 0) {
          triggers.push({
            integrationResource: integration.name,
            location,
            triggerIds,
            updateTime: integration.updateTime
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
    const url = resourceUrl('https://connectors.googleapis.com/', connectionName);
    url.pathname = `${url.pathname}:getConnectionSchemaMetadata`;
    try {
      const body = await this.postJson<ConnectorSchemaMetadata>(url, 'Integration Connectors schema metadata retrieval', {});
      return Object.keys(body.entities ?? {}).length || (body.actions?.length ?? 0) ? body : undefined;
    } catch (error) {
      if (/HTTP (?:400|404)/.test(error instanceof Error ? error.message : String(error))) return undefined;
      throw error;
    }
  }

  public async getStorageObjectText(bucket: string, object: string): Promise<string> {
    const url = new URL(
      `storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`,
      'https://storage.googleapis.com/'
    );
    url.searchParams.set('alt', 'media');
    const bytes = await this.getBinary(url, 'Cloud Storage spec object download');
    return bytes.toString('utf8');
  }

  private locationsUrl(origin: string, projectId: string): URL {
    const url = resourceUrl(origin, `projects/${projectId}/locations`);
    url.searchParams.set('pageSize', '200');
    return url;
  }

  private async listLocations(origin: string, projectId: string, operation: string): Promise<string[]> {
    return this.collectPages(
      () => this.locationsUrl(origin, projectId),
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
      createTime: typeof item.createTime === 'string' ? item.createTime : undefined
      ,sourceUri: typeof item.sourceUri === 'string' ? item.sourceUri : undefined
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
    const requester = await this.requester();
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        const response = await requester.request<ArrayBuffer | Uint8Array | Buffer>({ url: url.toString(), method: 'GET', timeout: this.options.requestTimeoutMs, retry: false, responseType: 'arraybuffer' });
        return Buffer.from(response.data as ArrayBuffer);
      } catch (error) {
        if (!isTransient(error) || attempt === this.options.maxAttempts) {
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
        ? item.openapiDocuments as Array<{ document?: GcpSourceFile }>
        : [],
      grpcServices: Array.isArray(item.grpcServices) ? item.grpcServices : [],
      managedServiceConfigs: Array.isArray(item.managedServiceConfigs)
        ? item.managedServiceConfigs as GcpSourceFile[]
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

  private toEndpointConfig(value: unknown): EndpointServiceConfig {
    const item = (value ?? {}) as Record<string, unknown>;
    const sourceInfo = item.sourceInfo as { sourceFiles?: unknown[] } | undefined;
    return {
      id: typeof item.id === 'string' ? item.id : '',
      name: typeof item.name === 'string' ? item.name : undefined,
      title: typeof item.title === 'string' ? item.title : undefined,
      producerProjectId: typeof item.producerProjectId === 'string' ? item.producerProjectId : undefined,
      sourceInfo: sourceInfo && Array.isArray(sourceInfo.sourceFiles)
        ? { sourceFiles: sourceInfo.sourceFiles as EndpointSourceFile[] }
        : undefined
    };
  }
}
