# Provider contracts

GCP spec discovery probes providers fail-soft in this order: `api-gateway`, `cloud-endpoints`, `apigee`, `api-hub`, `app-integration`, `connectors-custom`, then `iac-local`. Authorization failures become `skipped:iam`; other provider failures become `skipped:error`; remaining providers continue.

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

Runtime URL probing (`Cloud Run`, `GKE`, `Functions`, Firebase hosting) is outside v1 because GCP has no catalog of runtime spec endpoints. Traffic-derived surfaces (APIM shadow-API observation jobs, API Hub discovered observations) yield operations, not contracts, and are not spec sources. Convention-only storage (arbitrary GCS buckets, Artifact Registry generic repos, Cloud Build artifacts) and the legacy Apigee Registry (superseded by API Hub) are also excluded. The action does not fetch arbitrary remote URLs, synthesize routes, or convert gRPC / `google.api.Service` definitions.
