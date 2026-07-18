# Provider contracts

GCP spec discovery probes providers fail-soft in this order: `api-gateway`, `cloud-endpoints`, `apigee`, `api-hub`, `app-integration`, `connectors-custom`, `apigee-portal`, `vertex-extensions`, `dialogflow-tools`, `ces-toolsets`, `iac-local`. Authorization failures become `skipped:iam`; other provider failures become `skipped:error`; remaining providers continue.

## Repository-association capability

Automatic per-repo selection matches the canonical `postman-repo` label against candidate tags. Providers differ in whether the underlying GCP resource can carry labels at all:

| Capability | Providers | Mechanism |
| --- | --- | --- |
| Label-capable (auto-select works) | `api-gateway`, `apigee`, `api-hub`, `connectors-custom` | Resource labels flow into candidate tags (`postman-repo=<owner--repo>` on the API/config, proxy, hub attribute, or connector version) |
| Label-capable via IaC | `iac-local` | Repository-committed IaC fingerprinting selects without cloud labels |
| Label-incapable (never auto-selects by label) | `cloud-endpoints`, `app-integration`, `apigee-portal`, `vertex-extensions`, `dialogflow-tools`, `ces-toolsets` | The GCP surface exposes no usable label; select with `api-id`, `expected-api-ids-json`, or `service-mapping-json` + `expected-service-name` |

Label-incapable providers still participate in discovery and ranking; they simply cannot be *authorized* for export by repository association alone. See [repository-association.md](repository-association.md).

## `api-gateway`

- Lists API Gateway APIs and configs in the requested project and `global` location.
- Exports the complete `openapiDocuments` content from the selected config.
- Produces `api-gateway-config` candidates and records the full config resource name in `api-id`.

## `cloud-endpoints`

- Lists Cloud Endpoints services and available configs in the requested project.
- Reads `sourceInfo` entries with `OPEN_API_*` source types to recover the OpenAPI source.
- Produces `cloud-endpoints-config` candidates and records the config resource name in `api-id`.

## `apigee`

- Lists accessible Apigee proxies and revisions for the requested project context.
- Downloads the selected proxy revision zip and extracts OpenAPI documents only from `resources/oas` or `resources/openapi`.
- Produces `apigee-proxy` candidates and records the proxy revision resource name in `api-id`.
- Enumerates environments and exports validated `type=oas` resource files as `apigee-env-oas` candidates.
- A proxy without a supported embedded document is surfaced for manual review; the action does not synthesize routes or convert gRPC definitions.

## `api-hub`

- Walks the provisioned API Hub locations, then `apis -> versions -> specs`, in the requested project.
- Exports verbatim spec bytes with `specs/{spec}:contents`; API Hub is the consolidation layer for manually registered specs and Apigee / API Gateway plugin ingestion.
- Produces `api-hub-spec` candidates and records the full spec resource name in `api-id`.
- Non-OpenAPI spec types (proto, WSDL, MCP) surface as unsupported candidates for manual review; nothing is converted.
- IAM note: API Hub uses product-specific roles (`roles/apihub.viewer`); project Owner alone is not sufficient, so unprovisioned or unauthorized hubs probe as `skipped:iam` and discovery continues.

## `app-integration`

- Lists regional Application Integration integrations and keeps only those whose ACTIVE version has an `api_trigger/` trigger.
- Calls `locations/{location}:generateOpenApiSpec` to have Google generate the OpenAPI 3.0 contract from the trigger request/response schemas.
- Produces `app-integration-trigger` candidates; the export evidence marks the contract as generated, not an uploaded source file.

## `connectors-custom`

- Lists global custom Integration Connectors and their versions; each version records the `specLocation` of the OpenAPI document it was built from.
- Fetches `gs://` spec objects through the authenticated Cloud Storage JSON API; `https://` locations are surfaced as manual review because the action never fetches arbitrary remote URLs.
- Produces `connectors-custom-spec` candidates.
- Lists regional connections and, when schema metadata is available, derives an OpenAPI 3.0 document as `connectors-generated-spec`. Evidence explicitly identifies generated contracts, which rank below stored specification sources; connections without schema metadata are skipped fail-soft.

## `apigee-portal`

- Lists Apigee portal sites and their published API documents in the requested project-ID organization.
- Exports the original `oasDocumentation.spec.contents` document.
- Produces `apigee-portal-doc` candidates whose `api-id` is `organizations/{org}/sites/{site}/apidocs/{document}`.
- GraphQL, AsyncAPI, missing, and invalid OpenAPI documentation remains visible as unsupported for manual review.
- IAM note: authorization failures probing portal sites become `skipped:iam`, and discovery continues.

## `vertex-extensions`

- Enumerates Vertex AI project locations and lists extensions in each region.
- Exports the extension manifest's inline `openApiYaml` or fetches its `openApiGcsUri` through authenticated Cloud Storage.
- Produces `vertex-extension-manifest` candidates whose `api-id` is the full extension resource name.
- Manifests with neither source, multiple sources, invalid OpenAPI, or invalid storage locations remain unsupported.
- IAM note: authorization failures probing Vertex AI extensions become `skipped:iam`, and discovery continues.

## `dialogflow-tools`

- Lists Dialogflow CX agents and their tools in the requested project.
- Exports the original `openApiSpec.textSchema` stored on each tool.
- Produces `dialogflow-tool-schema` candidates whose `api-id` is the full tool resource name.
- Tools without `openApiSpec` are skipped; invalid OpenAPI schemas remain unsupported.
- IAM note: authorization failures probing Dialogflow become `skipped:iam`, and discovery continues.

## `ces-toolsets`

- Lists Conversational Agents (Agent Studio) apps and OpenAPI toolsets in the global CES location, then retrieves each toolset's tools with `toolsets/{toolset}:retrieveTools`.
- Exports inline `openApiToolset.openApiSchema` and tool-level `openApiTool.openApiSchema` documents.
- Produces `ces-tool-schema` candidates for standalone app tools and `ces-toolset-schema` candidates for toolset-scoped tools; each `api-id` identifies the original resource.
- Disabled, absent, and unauthorized CES surfaces probe fail-soft so discovery continues.

## `iac-local`

- Requires no network probe and scans bounded repository IaC files.
- Recognizes Terraform `google_api_gateway_api_config` path references and `google_endpoints_service` definitions.
- Resolves embedded documents or repository-relative path references as `iac-embedded` candidates.

## Ordering and narrowing

A committed `repo-spec` wins before provider probing. All provider candidates enter the same narrowing tiers, in order:

1. `iac-fingerprint`
2. `project-correlation`
3. `label-prefilter`
4. `naming-heuristic`

The `postman-repo` label is an ownership signal for label prefiltering. The selected tier appears in `narrowing-strategy`. If candidates remain indistinguishable, the action reports ranked evidence for manual review instead of choosing arbitrarily.

## Deferred surfaces

Runtime URL probing (`Cloud Run`, `GKE`, `Functions`, Firebase hosting, App Engine `_ah/api/discovery` endpoints) is outside v1 because GCP has no catalog of runtime spec endpoints. Traffic-derived surfaces (APIM shadow-API observation jobs, API Hub discovered observations) yield operations, not contracts, and are not spec sources. Convention-only storage (arbitrary GCS buckets, Secret Manager / Parameter Manager payloads, Artifact Registry generic repos, Cloud Build artifacts) and the legacy Apigee Registry (superseded by API Hub) are also excluded. Service Directory holds endpoint routing metadata with no schema payloads. Google API Discovery documents describe Google's own services, not customer APIs. GKE Gateway `HTTPRoute`/Ingress resources carry path skeletons without schemas, and synthesizing routes from them would violate the no-guessed-contract rule. The action does not fetch arbitrary remote URLs, synthesize routes, or convert gRPC descriptor sets (API Gateway `grpcServices`, Cloud Endpoints `FILE_DESCRIPTOR_SET_PROTO`, `google.api.Service` definitions) — descriptor-to-OpenAPI reconstruction produces an inferred contract, not a stored one.

IaC scanning is likewise bounded. `iac-local` recognizes Terraform `google_api_gateway_api_config` path references and `google_endpoints_service` definitions only. Other IaC shapes are deferred with rationale: Deployment Manager templates and Config Connector CRDs (`apigateway.cnrm.cloud.google.com`, `servicemanagement.cnrm.cloud.google.com`) embed the same config payloads but require YAML/Jinja evaluation the action does not perform; Pulumi and CDK-for-Terraform programs require executing user code, which is forbidden; Terraform `google_apigee_*` resources reference proxy bundles, not spec documents; `gcloud` invocation scripts and Cloud Build steps are arbitrary shell, not declarative references. Executing Terraform, Deployment Manager, or any user code remains out of scope; only static path or document references committed to the repository are read.
