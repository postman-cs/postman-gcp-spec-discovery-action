export interface ActionInputContract {
  description: string;
  required: boolean;
  default?: string;
}

export interface ActionOutputContract {
  description: string;
}

export interface GCPSpecDiscoveryActionContract {
  name: string;
  description: string;
  inputs: Record<string, ActionInputContract>;
  outputs: Record<string, ActionOutputContract>;
}

export type ActionMode = 'resolve-one' | 'discover-many';

export type ResolutionStatus = 'resolved' | 'unresolved';

export type ProviderType =
  | 'api-gateway'
  | 'cloud-endpoints'
  | 'apigee'
  | 'api-hub'
  | 'app-integration'
  | 'connectors-custom'
  | 'apigee-portal'
  | 'dialogflow-tools'
  | 'vertex-extensions'
  | 'ces-toolsets'
  | 'iac-local';

export type SourceType =
  | 'repo-spec'
  | 'api-gateway-config'
  | 'cloud-endpoints-config'
  | 'apigee-proxy'
  | 'apigee-env-oas'
  | 'api-hub-spec'
  | 'app-integration-trigger'
  | 'connectors-custom-spec'
  | 'connectors-generated-spec'
  | 'apigee-portal-doc' | 'vertex-extension-manifest' | 'dialogflow-tool-schema' | 'ces-tool-schema' | 'ces-toolset-schema'
  | 'iac-embedded'
  | 'manual-review'
  | 'discover-many';

export type SpecFormat = 'openapi-yaml' | 'openapi-json';

export type ProviderProbeStatus = 'available' | 'skipped:iam' | 'skipped:error';

export type NarrowingTier =
  | 'iac-fingerprint'
  | 'project-correlation'
  | 'label-prefilter'
  | 'naming-heuristic';

export interface ProviderProbeResult {
  provider: ProviderType;
  status: ProviderProbeStatus;
  evidence?: string;
}

export interface AmbiguousCandidateView {
  rank: number;
  serviceName: string;
  resourceId: string;
  apiId?: string;
  providerType: ProviderType;
  confidence: number;
  supported: boolean;
  evidence: string[];
}

export interface NarrowingMetadata {
  tier: NarrowingTier;
  mode: 'select' | 'narrow';
  droppedCount: number; // demoted count; no candidate is deleted here
}

export interface ResolutionResult {
  status: ResolutionStatus;
  sourceType: SourceType;
  serviceName: string;
  confidence: number;
  specPath?: string;
  apiId?: string;
  providerType?: ProviderType;
  specFormat?: SpecFormat;
  derivedOpenApiPath?: string;
  derivedOpenApiVersion?: '3.0.3' | '3.1.0';
  derivedOpenApiCompleteness?: 'full' | 'partial';
  derivedOpenApiFormat?: 'openapi-json';
  derivedOpenApiEvidence?: string[];
  narrowing?: NarrowingMetadata;
  providerProbes?: ProviderProbeResult[];
  rankedCandidates?: AmbiguousCandidateView[];
  evidence: string[];
}

export interface DiscoveredService {
  serviceName: string;
  specPath: string;
  apiId?: string;
  providerType: ProviderType;
  specFormat: SpecFormat;
  derivedOpenApiPath?: string;
  derivedOpenApiVersion?: '3.0.3' | '3.1.0';
  derivedOpenApiCompleteness?: 'full' | 'partial';
  derivedOpenApiFormat?: 'openapi-json';
  derivedOpenApiEvidence?: string[];
}

export interface ExportSummary {
  attempted: number;
  exported: number;
  failed: number;
  skipped: number;
}

export const actionContract: GCPSpecDiscoveryActionContract = {
  name: 'Postman Onboarding: GCP Spec Discovery',
  description:
    'Discover GCP-hosted API specs and expose a spec path for Postman onboarding. Part of the Postman API Onboarding suite.',
  inputs: {
    mode: {
      description: 'Discovery mode: resolve-one selects the single best service for this repository; discover-many exports every exportable candidate.',
      required: false,
      default: 'resolve-one'
    },
    'project-id': {
      description: 'Google Cloud project ID used as the exact discovery and credential preflight scope.',
      required: true
    },
    location: {
      description: 'Google Cloud API Gateway location. v1 supports global.',
      required: false,
      default: 'global'
    },
    'api-id': {
      description: 'Optional full API Gateway config, Cloud Endpoints config, Apigee proxy revision, or API Hub spec resource name. Use this to bypass broader project discovery.',
      required: false,
      default: ''
    },
    'repo-slug': {
      description: 'Repository slug (owner/name) used for repository-association matching against postman-repo resource labels. Defaults to the CI-detected repository (GITHUB_REPOSITORY).',
      required: false,
      default: ''
    },
    'output-dir': {
      description: 'Directory under the repository root where generated specs are written.',
      required: false,
      default: 'discovered-specs'
    },
    'postman-api-key': {
      description: 'Optional service-account PMAK used to mint or re-mint a postman-access-token for telemetry enrichment (account_type). Not used for any GCP or Postman asset operation.',
      required: false,
      default: ''
    },
    'postman-access-token': {
      description: 'Optional Postman service-account access token, used only to enrich anonymous telemetry with the session account_type. When omitted, postman-api-key alone can mint one for the same purpose. Not used for any GCP or Postman asset operation.',
      required: false,
      default: ''
    }
  },
  outputs: {
    'resolution-json': {
      description: 'JSON resolution result describing status, source type, confidence, and evidence.'
    },
    'resolution-status': {
      description: 'Resolution status: resolved or unresolved.'
    },
    'source-type': {
      description: 'Resolved source type: repo-spec, api-gateway-config, cloud-endpoints-config, apigee-proxy, apigee-env-oas, api-hub-spec, app-integration-trigger, connectors-custom-spec, connectors-generated-spec, apigee-portal-doc, vertex-extension-manifest, dialogflow-tool-schema, ces-tool-schema, ces-toolset-schema, iac-embedded, manual-review, or discover-many.'
    },
    'mapping-confidence': {
      description: 'Numeric confidence score for the selected service candidate.'
    },
    'spec-path': {
      description: 'Path to the resolved or generated specification when available.'
    },
    'api-id': {
      description: 'Full API Gateway, Cloud Endpoints config, Apigee proxy revision, or API Hub spec resource name; empty for repo, generated, or IaC-local resolutions.'
    },
    'service-name': {
      description: 'Resolved service name.'
    },
    'services-json': {
      description: 'discover-many output: JSON array of exported services.'
    },
    'service-count': {
      description: 'discover-many output: number of exported services.'
    },
    'export-summary-json': {
      description: 'JSON summary of attempted, exported, failed, and skipped candidates.'
    },
    'candidates-json': {
      description: 'Ranked ambiguous candidates as JSON when resolution is unresolved with at least two candidates; empty otherwise.'
    },
    'provider-type': {
      description: 'Provider that produced the resolved spec: api-gateway, cloud-endpoints, apigee, api-hub, app-integration, connectors-custom, apigee-portal, vertex-extensions, dialogflow-tools, ces-toolsets, or iac-local.'
    },
    'spec-format': {
      description: 'Format of the resolved spec: openapi-yaml or openapi-json.'
    },
    'contract-origin': {
      description: 'Compatibility output; always empty in v1.'
    },
    'contract-metadata-path': {
      description: 'Compatibility output; always empty in v1.'
    },
    'variant-count': {
      description: 'Compatibility output; always empty in v1.'
    },
    'derived-openapi-path': {
      description: 'Path to the derived OpenAPI 3.x document when the source was not already OpenAPI 3.x.'
    },
    'derived-openapi-version': {
      description: 'OpenAPI version of the derived document: 3.0.3 or 3.1.0.'
    },
    'derived-openapi-completeness': {
      description: 'Whether the derived OpenAPI document is full or partial.'
    },
    'derived-openapi-format': {
      description: 'Serialization format of the derived OpenAPI document: openapi-json.'
    },
    'derived-openapi-evidence-json': {
      description: 'JSON array of evidence strings describing how the derived OpenAPI document was produced.'
    },
    'narrowing-strategy': {
      description: 'Narrowing tier that produced the candidate ordering: iac-fingerprint, project-correlation, label-prefilter, naming-heuristic, or none.'
    }
  }
};

export const contractInputNames: string[] = Object.keys(actionContract.inputs);

export const contractOutputNames: string[] = Object.keys(actionContract.outputs);
