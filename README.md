# Postman Onboarding: GCP Spec Discovery

[![CI](https://github.com/postman-cs/postman-gcp-spec-discovery-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-gcp-spec-discovery-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-gcp-spec-discovery-action?sort=semver)](https://github.com/postman-cs/postman-gcp-spec-discovery-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-gcp-spec-discovery)](https://www.npmjs.com/package/@postman-cse/onboarding-gcp-spec-discovery) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Discover and export OpenAPI specifications from GCP services for Postman onboarding. The action uses repository context and Google Cloud credentials to select an existing specification or export one from a supported GCP provider.

## Authentication

Authenticate with Application Default Credentials (ADC) or Workload Identity Federation. In GitHub Actions, use [`google-github-actions/auth`](https://github.com/google-github-actions/auth) before this action. `project-id` is required; `location` defaults to `global`.

```yaml
jobs:
  discover:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - id: spec
        uses: postman-cs/postman-gcp-spec-discovery-action@v1
        with:
          project-id: my-gcp-project
      - run: echo "Resolved ${{ steps.spec.outputs.source-type }} -> ${{ steps.spec.outputs.spec-path }}"
```

## Usage

### Resolve one service

```yaml
- id: spec
  uses: postman-cs/postman-gcp-spec-discovery-action@v1
  with:
    project-id: my-gcp-project
```

### Discover automatically from the gateway (repository association)

Label the deployed GCP resource that owns this repository's API with `postman-repo=<owner--repo>` (canonicalized slug: lowercase, `/` folded to `--`, invalid characters folded to `-`; for `github.com/acme/payments-api` the value is `acme--payments-api`). The action then resolves the right API from repository identity alone — no `api-id`, no service-name hints:

```yaml
- id: spec
  uses: postman-cs/postman-gcp-spec-discovery-action@v1
  with:
    project-id: my-gcp-project
    # repo-slug defaults to the CI-detected repository (GITHUB_REPOSITORY);
    # set it only to resolve on behalf of a different repository.
```

Exactly one conflict-free exact label match auto-selects. Zero matches, multiple matches, or colliding label values stay `unresolved` (`manual-review`) with the expected label value printed in the evidence — the action never guesses. Colliding repositories (same canonical value, e.g. case-fold or punctuation collisions, or slugs longer than 63 characters) must set `api-id` or `expected-api-ids-json` explicitly.

`postman-repo` is an owner assertion, not a verified binding: anyone with `*.update` on the resource can point it at any repository. Keep IAM label-write privileges scoped to the deployment pipeline; ambiguity still always forces `manual-review`.

A ready-to-distribute per-service-repo workflow using this pattern (adapted from the AWS discovery hub, but hub-less — each repo discovers its own spec) ships in [`templates/postman-gcp-onboard.yml`](templates/postman-gcp-onboard.yml). See [docs/repository-association.md](docs/repository-association.md) for marker placement per provider, ambiguity semantics, and WIF bootstrap.

### Resolve a known config or Apigee proxy revision

```yaml
- uses: postman-cs/postman-gcp-spec-discovery-action@v1
  with:
    project-id: my-gcp-project
    api-id: projects/my-gcp-project/locations/global/apis/payments/configs/v1
```

### Export every candidate

```yaml
- uses: postman-cs/postman-gcp-spec-discovery-action@v1
  with:
    project-id: my-gcp-project
    mode: discover-many
```

### Portable CLI

```sh
npx @postman-cse/onboarding-gcp-spec-discovery \
  --project-id "$GCP_PROJECT_ID" \
  --result-json postman-gcp-spec-discovery-result.json \
  --dotenv-path gcp-spec.env
```

## Inputs

<!-- inputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `mode` | Discovery mode: resolve-one selects the single best service for this repository; discover-many exports every exportable candidate. | no | `resolve-one` |
| `project-id` | Google Cloud project ID used as the exact discovery and credential preflight scope. | yes | n/a |
| `location` | Google Cloud API Gateway location. v1 supports global. | no | `global` |
| `api-id` | Optional full API Gateway config, Cloud Endpoints config, or Apigee proxy revision resource name. Use this to bypass broader project discovery. | no | n/a |
| `repo-slug` | Repository slug (owner/name) used for repository-association matching against postman-repo resource labels. Defaults to the CI-detected repository (GITHUB_REPOSITORY). | no | n/a |
| `output-dir` | Directory under the repository root where generated specs are written. | no | `discovered-specs` |
| `postman-api-key` | Optional service-account PMAK used to mint or re-mint a postman-access-token for telemetry enrichment (account_type). Not used for any GCP or Postman asset operation. | no | n/a |
| `postman-access-token` | Optional Postman service-account access token, used only to enrich anonymous telemetry with the session account_type. When omitted, postman-api-key alone can mint one for the same purpose. Not used for any GCP or Postman asset operation. | no | n/a |
<!-- inputs-table:end -->

## Outputs

<!-- outputs-table:start -->
| Name | Description |
| --- | --- |
| `resolution-json` | JSON resolution result describing status, source type, confidence, and evidence. |
| `resolution-status` | Resolution status: resolved or unresolved. |
| `source-type` | Resolved source type: repo-spec, api-gateway-config, cloud-endpoints-config, apigee-proxy, api-hub-spec, app-integration-trigger, connectors-custom-spec, apigee-portal-doc, vertex-extension-manifest, dialogflow-tool-schema, ces-tool-schema, ces-toolset-schema, iac-embedded, manual-review, or discover-many. |
| `mapping-confidence` | Numeric confidence score for the selected service candidate. |
| `spec-path` | Path to the resolved or generated specification when available. |
| `api-id` | Full API Gateway, Cloud Endpoints config, Apigee proxy revision, or API Hub spec resource name; empty for repo, generated, or IaC-local resolutions. |
| `service-name` | Resolved service name. |
| `services-json` | discover-many output: JSON array of exported services. |
| `service-count` | discover-many output: number of exported services. |
| `export-summary-json` | JSON summary of attempted, exported, failed, and skipped candidates. |
| `candidates-json` | Ranked ambiguous candidates as JSON when resolution is unresolved with at least two candidates; empty otherwise. |
| `provider-type` | Provider that produced the resolved spec: api-gateway, cloud-endpoints, apigee, api-hub, app-integration, connectors-custom, apigee-portal, vertex-extensions, dialogflow-tools, ces-toolsets, or iac-local. |
| `spec-format` | Format of the resolved spec: openapi-yaml or openapi-json. |
| `contract-origin` | Compatibility output; always empty in v1. |
| `contract-metadata-path` | Compatibility output; always empty in v1. |
| `variant-count` | Compatibility output; always empty in v1. |
| `derived-openapi-path` | Path to the derived OpenAPI 3.x document when the source was not already OpenAPI 3.x. |
| `derived-openapi-version` | OpenAPI version of the derived document: 3.0.3 or 3.1.0. |
| `derived-openapi-completeness` | Whether the derived OpenAPI document is full or partial. |
| `derived-openapi-format` | Serialization format of the derived OpenAPI document: openapi-json. |
| `derived-openapi-evidence-json` | JSON array of evidence strings describing how the derived OpenAPI document was produced. |
| `narrowing-strategy` | Narrowing tier that produced the candidate ordering: iac-fingerprint, project-correlation, label-prefilter, naming-heuristic, or none. |
<!-- outputs-table:end -->

## Supported providers

| Provider | Source type | Exported format |
| --- | --- | --- |
| `api-gateway` | `api-gateway-config` | OpenAPI from the full API Gateway config `openapiDocuments` payload |
| `cloud-endpoints` | `cloud-endpoints-config` | OpenAPI from Cloud Endpoints `sourceInfo` `OPEN_API_*` sources |
| `apigee` | `apigee-proxy` | OpenAPI found in an Apigee proxy revision zip under `resources/oas` or `resources/openapi` |
| `api-hub` | `api-hub-spec` | Verbatim OpenAPI stored in Apigee API Hub, exported via `specs:contents` (manually registered or ingested from Apigee / API Gateway plugins) |
| `app-integration` | `app-integration-trigger` | OpenAPI 3.0 generated server-side by Application Integration `generateOpenApiSpec` for published integrations with API triggers |
| `connectors-custom` | `connectors-custom-spec` | The OpenAPI document a custom Integration Connector was built from, fetched from its recorded `gs://` `specLocation` |
| `apigee-portal` | `apigee-portal-doc` | Original OpenAPI documentation published through an Apigee portal API document |
| `vertex-extensions` | `vertex-extension-manifest` | Inline or Cloud Storage OpenAPI from a Vertex AI extension manifest |
| `dialogflow-tools` | `dialogflow-tool-schema` | Original OpenAPI text schema stored on a Dialogflow CX tool |
| `ces-toolsets` | `ces-toolset-schema` | Original OpenAPI schema stored on a Conversational Agents app toolset |
| `iac-local` | `iac-embedded` / path reference | OpenAPI referenced by local Terraform `google_api_gateway_api_config` or `google_endpoints_service` resources |

The resolver probes providers in this order: `api-gateway`, `cloud-endpoints`, `apigee`, `api-hub`, `app-integration`, `connectors-custom`, `apigee-portal`, `vertex-extensions`, `dialogflow-tools`, `ces-toolsets`, `iac-local`. A committed `repo-spec` wins before remote discovery. Candidates are narrowed by `iac-fingerprint`, `project-correlation`, `label-prefilter`, then `naming-heuristic`; the `postman-repo` label is an ownership signal. Ambiguous or unsupported results are reported for **manual review** rather than guessed.

## v1 boundaries

v1 does not probe `Cloud Run`, `GKE`, or `Functions` runtime URLs (there is no GCP catalog of runtime specs), does not fetch arbitrary remote URLs, does not synthesize routes from traffic observations (APIM shadow-API discovery yields operations, not contracts), and does not convert gRPC or `google.api.Service` definitions to OpenAPI. Non-OpenAPI `API Hub` spec types (proto, WSDL, MCP) surface as manual review candidates rather than being converted.

## How it works

1. Validate `project-id` and Google credentials.
2. Prefer a committed repository specification.
3. Probe supported providers fail-soft and collect candidates.
4. Narrow and rank candidates using repository and project signals.
5. Export and validate the selected OpenAPI document inside `output-dir`.
6. Emit resolution, export, candidate, and narrowing outputs.

## Resources

- [Provider contracts](docs/providers.md)
- [Repository association](docs/repository-association.md)
- [Per-service-repo onboarding workflow template](templates/postman-gcp-onboard.yml)
- [Live testing runbook](docs/LIVE_TESTING_RUNBOOK.md)
- [RELEASE_POLICY.md](RELEASE_POLICY.md), [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md)

## Telemetry

The action emits one anonymous `completion` event per run (action name `gcp-spec-discovery`) through `@postman-cse/automation-telemetry-core`. The payload excludes project identifiers, resource names, labels, specification content, URLs, and credentials. Opt out with `POSTMAN_ACTIONS_TELEMETRY=off` or `DO_NOT_TRACK=1`.

## License

[MIT](LICENSE)
