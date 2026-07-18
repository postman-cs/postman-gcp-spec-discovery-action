# GCP Spec Discovery Action v1.0.0 PRD

Status: implementation-ready  
Authoritative plan: `.plans/gcp-spec-discovery-v1-plan.md`  
Repository: `postman-cs/postman-gcp-spec-discovery-action`  
Local path: `cse/postman-gcp-spec-discovery-action/`  
Release: `v1.0.0`; npm `@postman-cse/onboarding-gcp-spec-discovery@1.0.0`

## Product Contract

The action discovers or derives an OpenAPI 3.x or Swagger 2.0 document from one explicitly named Google Cloud project. Resolution order is direct repo spec, one local-IaC referenced spec, then cloud candidates. Ambiguity or unsupported source shape returns `unresolved/manual-review` with sanitized evidence and writes no guessed artifact.

### Inputs

`action.yml` and `src/contracts.ts` MUST declare these keys in order:

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | false | `resolve-one` | `resolve-one` or `discover-many`. |
| `project-id` | true | none | Exact Google Cloud project ID; never inferred from ambient ADC. |
| `location` | false | `global` | API Gateway location; v1 accepts only `global`. |
| `api-id` | false | `''` | Exact full API Gateway config, Cloud Endpoints config, or Apigee proxy revision resource name. |
| `repo-slug` | false | `''` | Repository slug (owner/name) for repository-association matching against `postman-repo` labels; defaults to the CI-detected repository. |
| `output-dir` | false | `discovered-specs` | Confined repository-relative write root. |
| `postman-api-key` | false | `''` | Optional telemetry enrichment only. |
| `postman-access-token` | false | `''` | Optional telemetry enrichment only. |

CLI-only controls mirror Azure: repository context, expected IDs/service name, mapping/filter, candidate cap, dry-run, preflight controls, request timeout, attempts, result JSON, dotenv path, help, and version. Defaults are `max-candidates=50`, `request-timeout-ms=30000`, `max-attempts=3`, `preflight-checks=true`, and `preflight-permission-probe=true`.

### Outputs

The action MUST set all 22 outputs in this order on every successful invocation:

1. `resolution-json`
2. `resolution-status`
3. `source-type`
4. `mapping-confidence`
5. `spec-path`
6. `api-id`
7. `service-name`
8. `services-json`
9. `service-count`
10. `export-summary-json`
11. `candidates-json`
12. `provider-type`
13. `spec-format`
14. `contract-origin`
15. `contract-metadata-path`
16. `variant-count`
17. `derived-openapi-path`
18. `derived-openapi-version`
19. `derived-openapi-completeness`
20. `derived-openapi-format`
21. `derived-openapi-evidence-json`
22. `narrowing-strategy`

Provider types are `api-gateway | cloud-endpoints | apigee | api-hub | app-integration | connectors-custom | apigee-portal | dialogflow-tools | vertex-extensions | ces-toolsets | iac-local`. Source types are `repo-spec | api-gateway-config | cloud-endpoints-config | apigee-proxy | apigee-env-oas | api-hub-spec | app-integration-trigger | connectors-custom-spec | connectors-generated-spec | apigee-portal-doc | vertex-extension-manifest | dialogflow-tool-schema | ces-tool-schema | ces-toolset-schema | iac-embedded | manual-review | discover-many`. Spec formats are `openapi-json | openapi-yaml`. Compatibility outputs 14-16 are empty in v1. Dotenv names use `POSTMAN_GCP_SPEC_*`.

## Requirements

### R1 - Scaffold, contract, input resolution, and confinement (P0)

- Create an independent Node 24 strict-TypeScript package with ESM source and single-file CommonJS `dist/index.cjs` plus executable `dist/cli.cjs`.
- Require `project-id`; validate it against `^[a-z][a-z0-9-]{4,28}[a-z0-9]$`. Reject any `location` other than `global` in v1.
- Confine output/result/dotenv paths beneath `repo-root` lexically and by realpath; reject symlink/path traversal before writing.
- Keep Action/CLI adapters thin and byte-equivalent at the output surface.

Acceptance:

- **GCP-CONTRACT-001:** manifest and contract inputs/outputs exactly match the ordered lists.
- **GCP-CONTRACT-002:** defaults and invalid mode/project/location produce exact actionable errors.
- **GCP-CONTRACT-003:** `../escape` and out-of-root symlink outputs fail with no outside write through runtime and CLI.
- **GCP-CONTRACT-004:** resolved/unresolved and both modes serialize all 22 outputs with documented empty values.
- **GCP-CONTRACT-005:** package name/version/Node engine/files and exact dependency pins match the release contract.

### R2 - ADC transport, preflight, retry, pagination, and sanitization (P0)

- Construct exactly one `GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })` in production and reuse its authenticated fetch transport.
- Preflight calls Cloud Resource Manager `projects.get` for the explicit project before provider enumeration. Credential/project failure is fatal; provider 401/403/service-disabled failures are fail-soft typed probes.
- Every request uses `request-timeout-ms`, at most `max-attempts`, retries only 408/429/5xx, and never retries validation/400/401/403/404 responses.
- Consume `nextPageToken` until empty; reject a repeated token. URL path segments use `encodeURIComponent`; query strings are constructed with `URLSearchParams`.
- Sanitize access tokens, credential JSON, project numbers, service-account emails, full resource names, and URL queries from errors/evidence.

Acceptance:

- **GCP-CLIENT-001:** one shared auth object, successful preflight, and fatal preflight failure before providers.
- **GCP-CLIENT-002:** retry attempt bounds and nonretryable behavior are exact under fake transport.
- **GCP-CLIENT-003:** two-page lists combine in order; repeated token fails after the second page.
- **GCP-CLIENT-004:** mixed provider 403/error/success yields ordered `skipped:iam`, `skipped:error`, `available` and continues.
- **GCP-CLIENT-005:** raw secret/project-number/email/resource/query fixtures are absent after sanitization.

### R3 - API Gateway original-source provider (P0)

- List `projects/{project}/locations/global/apis` and each API's configs with pagination.
- Retain configs in `ACTIVE`; keep unsupported gRPC-only/non-active configs as `supported=false` evidence rather than silently selecting them.
- Exact `api-id` must match `projects/{inputProject}/locations/global/apis/{api}/configs/{config}` and is fetched directly; cross-project or non-config names fail before network export.
- Export with `GET https://apigateway.googleapis.com/v1/{name}?view=FULL`. Decode `openapiDocuments[].document.contents` from base64, enforce at most 10 MiB decoded, validate version and non-empty `paths`, and preserve source JSON/YAML with one trailing newline.
- Exactly one valid OpenAPI document is exportable. Zero or multiple OpenAPI documents are unsupported/manual review; gRPC/service-config files are never converted.

Acceptance:

- **GCP-GATEWAY-001:** paged APIs/configs yield stable candidates and state/support classifications.
- **GCP-GATEWAY-002:** FULL export decodes valid JSON and YAML original bytes with correct filename/format.
- **GCP-GATEWAY-003:** malformed base64, oversize, invalid/empty spec, zero/multiple docs, and gRPC-only configs write nothing and report precise sanitized evidence.
- **GCP-GATEWAY-004:** explicit cross-project/malformed IDs are rejected; an exact valid ID bypasses list calls and resolves at confidence 100.

### R4 - Cloud Endpoints original-source provider (P0)

- List only managed services with exact `producerProjectId=<inputProject>`, with pagination.
- List each service's configs newest-first. v1 candidate set contains the newest config per service; exact IDs can target an older config.
- Export `services/{serviceName}/configs/{configId}?view=FULL` and inspect only `sourceInfo.sourceFiles` whose `fileType` is `OPEN_API_JSON` or `OPEN_API_YAML`.
- Decode base64, cap 10 MiB, validate, and preserve one source document. Zero/multiple valid source files are unsupported/manual review. Service Config normalization is never converted back into guessed OpenAPI.

Acceptance:

- **GCP-ENDPOINTS-001:** producer filtering, config pagination, newest-per-service selection, and stable IDs are exact.
- **GCP-ENDPOINTS-002:** FULL sourceInfo JSON/YAML exports preserve valid bytes and format.
- **GCP-ENDPOINTS-003:** normalized config without sourceInfo, zero/multiple OpenAPI files, malformed/oversize/invalid bytes, and foreign producer project write nothing.
- **GCP-ENDPOINTS-004:** exact older config ID resolves directly while automatic discovery uses newest only.

### R5 - Repository and GCP IaC discovery (P0)

- Direct repository OpenAPI/Swagger files retain highest precedence.
- Scan at most depth 6 and 200 `.tf`, `.json`, `.yaml`, `.yml` files in lexical order, excluding `.git`, `node_modules`, `dist`, and `output-dir`; do not execute Terraform, gcloud, hooks, or source code.
- Terraform recognizes only literal `google_api_gateway_api_config` OpenAPI document `path` references and `google_endpoints_service` literal OpenAPI file/content references. Resolve files beneath repo root only.
- One valid referenced document resolves `iac-embedded`; multiple remain `manual-review`; no match falls through. Extract resource/API/service names only as narrowing fingerprints.

Acceptance:

- **GCP-IAC-001:** exact Terraform fixtures yield the referenced valid docs and fingerprints without process/network calls.
- **GCP-IAC-002:** one document resolves, two are ambiguous with no write, zero falls through.
- **GCP-IAC-003:** traversal, symlink escape, depth/file caps, ignored directories, and lexical repeatability are enforced.
- **GCP-IAC-004:** interpolation, remote URLs, data sources, provisioners, and nonliteral expressions are evidence-only or ignored and never executed/fetched.

### R5b - API Hub, Application Integration, and Integration Connectors providers (P0)

- `api-hub`: walk provisioned hub locations, then `apis -> versions -> specs`; export verbatim bytes via `specs/{spec}:contents`; record the full spec resource name in `api-id` and accept it as an explicit `api-id` input. Non-OpenAPI spec types (proto, WSDL, MCP) stay unsupported/manual-review. Product-specific IAM (`roles/apihub.viewer`) or an unprovisioned hub probes `skipped:iam` fail-soft.
- `app-integration`: list regional integrations whose ACTIVE version has an `api_trigger/`; generate OpenAPI 3.0 server-side with `locations/{location}:generateOpenApiSpec`; evidence marks the contract as generated, never an uploaded source file.
- `connectors-custom`: list global custom connectors and versions; fetch only `gs://` `specLocation` objects through the authenticated Cloud Storage JSON API; `https://` locations stay manual-review because the action never fetches arbitrary remote URLs.

Acceptance:

- **GCP-APIHUB-001..005:** strict spec-name parsing, fail-soft probes, verbatim OpenAPI export, unsupported non-OpenAPI types, and project-scoped explicit `api-id` are pinned by tests.
- **GCP-APPINT-001..003:** fail-soft probes, trigger-scoped listing plus generated-contract export evidence, and non-integration `api-id` yielding no candidates are pinned by tests.
- **GCP-CONNECTORS-001..004:** strict `gs://` parsing, fail-soft probes, authenticated storage fetch, and https manual-review with no fetch are pinned by tests.

### R5c - Apigee Portal, Vertex AI Extensions, and Dialogflow CX Tools providers (P0)

- `apigee-portal`: list integrated-portal sites and their `apidocs`; fetch each documentation snapshot via `getDocumentation` and decode the stored OpenAPI contents. Candidates carry `api-id` `organizations/{org}/sites/{site}/apidocs/{document}` and source type `apigee-portal-doc`. Missing portal provisioning or product IAM probes `skipped:iam` fail-soft.
- `vertex-extensions`: list Vertex AI Extensions in the project region; export each extension's stored `apiSpec` manifest (inline YAML or `gs://` object fetched through the authenticated Cloud Storage JSON API) as source type `vertex-extension-manifest`.
- `dialogflow-tools`: walk Dialogflow CX agents and their OpenAPI-typed tools; export each tool's stored `openApiSpec.textSchema` verbatim as source type `dialogflow-tool-schema`. Non-OpenAPI tool types stay unsupported/manual-review.

Acceptance:

- **GCP-PORTAL-001..003:** fail-soft probes, apidoc listing plus documentation export, and non-OpenAPI documentation manual-review are pinned by tests.
- **GCP-VERTEX-001..003:** fail-soft probes, inline and `gs://` manifest export, and strict location parsing are pinned by tests.
- **GCP-DIALOGFLOW-001..003:** fail-soft probes, OpenAPI tool export, and non-OpenAPI tool types unsupported are pinned by tests.

### R6 - Resolution, narrowing, modes, UX, and telemetry (P0)

- Provider order is API Gateway, Cloud Endpoints, Apigee, API Hub, Application Integration, Integration Connectors, Apigee Portal, Vertex AI Extensions, Dialogflow CX Tools, IaC local after direct repo-spec precedence.
- Narrowing order is `iac-fingerprint`, `project-correlation`, `label-prefilter`, `naming-heuristic`. It partitions without deleting; cap applies after partition. Only explicit ID or one exact label key `postman-repo` with the canonical repo-label value selects. Canonicalization lowercases the full owner/repo slug, replaces `/` with `--`, replaces every other run outside `[a-z0-9_-]` with `-`, trims leading/trailing separators, and declines label selection when the result is empty or exceeds 63 characters.
- Equal top confidence, multiple local docs, unsupported selected candidates, or no candidate resolve to sanitized manual review, never arbitrary first-item selection.
- `discover-many` exports every supported candidate in stable order and records attempted/exported/failed/skipped accurately.
- Ambiguity populates deterministic `candidates-json` and a `## Postman GCP spec discovery` Step Summary. Summary failure is warn-only.
- Emit at most one best-effort telemetry completion event with `action: 'gcp-spec-discovery'`; no GCP identifiers/specs/URLs/tags enter telemetry.

Acceptance:

- **GCP-NARROW-001:** tier order, zero-intersection fallthrough, partition-never-delete, exact-label-only select, and cap-after-partition are proven.
- **GCP-RESOLVE-001:** repo spec/local IaC/cloud precedence, ties, unsupported candidates, explicit IDs, and both modes match contracts.
- **GCP-SUMMARY-001:** golden summary/candidates are stable and contain no project number, service-account email, full resource name, token, or URL query.
- **GCP-ENTRY-001:** Action and CLI call one runtime and return all 22 byte-equal outputs.
- **GCP-TELEMETRY-001:** success/failure/transport-failure/opt-out emit at most one safe event without changing runtime status.

### R7 - Documentation, CI, live validation, and release (P0)

- README tables are generated from the contract; docs state exact providers, ADC/WIF setup, IAM permissions, and deferred surfaces without overclaiming.
- CI is one Node 24 `gate` job with one `npm ci`, one bundle, max two concurrent local checks, read-only dist assertion, and no credentialed live step on pull requests.
- Live runner uses explicit `GCP_PROJECT_ID=dans-project-491920`, requires `--provision --teardown`, enables `apigateway.googleapis.com`, creates only collision-resistant run-marked API Gateway API/config and Cloud Endpoints service/config resources, validates current compiled CLI, and tears down exact identities in `finally`.
- Live cases: explicit Gateway config; Gateway discovery; explicit Endpoints config; Endpoints discovery; discover-many; local IaC single; ambiguity. Evidence stores only case name/status/source/provider/format and totals.
- Release accepts only immutable `v1.0.0` at `origin/main`, runs all gates, publishes npm with provenance, creates GitHub release, then moves only `v1` and `v1.0`. Rolling tags never publish npm.

Acceptance:

- **GCP-DOCS-001:** generated tables have no drift and docs name exactly the v1 providers/non-goals.
- **GCP-CI-001:** workflow contract test and actionlint pass.
- **GCP-LIVE-001:** all current-build live cases pass in Dan's project; teardown leaves no current-run active API Gateway/Endpoints resource.
- **GCP-LIVE-002:** failure/marker mismatch tests prove `finally` cleanup and deletion refusal for foreign resources.
- **GCP-LIVE-003:** committed evidence totals match and contains no forbidden identifiers/URLs/secrets/spec bodies.
- **GCP-RELEASE-001:** release workflow tests prove tag/package/main equality, npm idempotence, GitHub release, and dual rolling aliases.
- **GCP-RELEASE-002:** after publication, npm version, GitHub release, immutable/rolling tag peel, and npm/tag `dist` bytes all verify independently.

## Must Pass

From `cse/postman-gcp-spec-discovery-action/` on the release candidate:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:dist
npm run docs:tables
git diff --exit-code -- README.md
actionlint .github/workflows/*.yml
node validation/scripts/validate-live-gcp-surfaces.mjs --provision --teardown
```

Then judge-sol and judge-fable MUST both return COMPLETE. Release verification MUST prove `v1.0.0 == v1 == v1.0 == origin/main`, npm reports `1.0.0`, the GitHub release exists, and both npm bundle files byte-match the immutable tag.

## Must Not

- No service-account key or credential JSON input, durable secret, token logging, ambient project inference, or personal project validation.
- API Hub, Application Integration, and Integration Connectors custom connectors are IN scope as fail-soft providers (`api-hub`, `app-integration`, `connectors-custom`). No Cloud Run/Functions runtime probing, arbitrary remote URL fetch, traffic-derived route synthesis (APIM shadow-API observation), legacy Apigee Registry, gRPC/`google.api.Service` conversion, Terraform/gcloud execution, or cross-action TypeScript import in v1. Apigee is explicitly IN SCOPE and release-blocking: the Dan's-project org and its billing org must be fully working (management plane, data plane, spec surfaces) before v1 ships, at any cost.
- No arbitrary ambiguity selection, destructive narrowing, cap-before-partition, path escape, stale-dist proof, credentialed PR job, rolling-tag npm publish, immutable-tag movement, or release from a commit other than protected `origin/main`.

## Completion Audit

Completion requires a prompt-to-artifact checklist mapping every requirement/AC above to current files, test output, live evidence, judge receipts, commit/CI state, and published artifacts. Missing or indirect evidence remains incomplete.
