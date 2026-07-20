# Live GCP validation runbook

Live validation provisions disposable GCP resources, runs the compiled CLI against every retained provider surface, captures a sanitized schema-v2 receipt bound to exact dist digests, and tears down only resources created by the current run. It is operator-triggered and is not part of pull-request CI.

## Prerequisites

- An explicitly selected disposable project with permission to create and delete run-scoped validation resources. Never use a personal or production project.
- ADC credentials from `gcloud auth application-default login`, or equivalent workload identity credentials.
- A clean committed candidate build: `npm run build`, then commit the resulting `dist/` before live validation (the runner refuses missing or dirty `dist/` and never runs `npm run build` itself).

```sh
export GCP_PROJECT_ID=your-disposable-project-id
# Optional existing-resource fixtures (never logged):
# `matrixName` is required and binds one fixture to one source variant. Exact-byte
# fixtures require a 64-hex `expectedSha256` (or a repo-local, non-symlink
# `expectedFixturePath`); semantic fixtures require that expected fixture path.
# Optional `selectionStrategy`: `strict-api-id` | `expected-api-ids` | `api-hub-additional`
# (derived from provider/source when omitted). API Hub additional fixtures may use a
# bare spec name or `spec#BOOSTED_SPEC_CONTENT` / `spec#GATEWAY_OPEN_API_SPEC`.
# export GCP_LIVE_FIXTURES_JSON='[{"provider":"api-hub","resourceId":"projects/.../specs/...","expectedSourceType":"api-hub-spec","validationMode":"exact-bytes","expectedSha256":"<64-hex>","matrixName":"api-hub-original"}]'
node validation/scripts/validate-live-gcp-surfaces.mjs --provision --teardown
```

## Coverage matrix

The runner derives required surfaces from the retained provider order (api-gateway, cloud-endpoints, apigee proxy + archive, api-hub original + additional, apigee-registry, app-integration, connectors-custom, apigee-portal, vertex-extensions, agent-engines, dialogflow-tools, ces-toolsets, iac-local). Tests fail if the matrix and runtime provider order drift.

Provisioned run-scoped cases (always executed):

1. `gateway-explicit-api-id`
2. `gateway-discovery`
3. `gateway-repo-label`
4. `gateway-label-conflict`
5. `endpoints-explicit-api-id`
6. `endpoints-discovery`
7. `apigee-discovery`
8. `discover-many`
9. `iac-single`
10. `ambiguity`

Remaining matrix slots require either:

- a fixture in `GCP_LIVE_FIXTURES_JSON` validated through current `dist/cli.cjs` (`exact-bytes`, `semantic-openapi`, or `manual-derived-blocked` for agent-engines), or
- an authenticated compiled-CLI probe for that exact provider plus a REST probe that proves a closed substitute reason: `iam-denied`, `api-unavailable`, `product-deprecated`, or `registry-unsupported`. An absent provider probe is inconclusive; names and catch-all errors never imply deprecation.

`available` with no fixture is **not** completion — the case fails as `missing-fixture`.

Fixture selection is provider/source-specific: strict `--api-id` only for source forms the runtime explicit parser accepts; `--expected-api-ids-json` + service hint for parser-less providers (`app-integration`, `connectors-custom`, `agent-engines`); `api-hub-additional` uses the deterministic `spec#VARIANT` selector so generated content cannot collapse to the stored original. Strategies that can select arbitrary unrelated candidates are rejected.

Apigee archive substitutes authenticate against the environment `archiveDeployments` endpoint (not the generic proxy API). Org/env values are never logged.

Agent Engines completion/substitute must pair an authenticated probe (available or closed-reason unavailability) with a compiled-CLI `manual-derived-blocked` proof that local-derived authority cannot resolve/export. Availability alone cannot pass.

## Receipt

Schema v2 includes ISO `capturedAt`, `actionVersion`, `gitCommit`, `distCliSha256`, `distIndexSha256`, constant `projectScope` alias, totals, sanitized teardown status, and per-case `{name, providerType, sourceType, specFormat, status, validationMode, reasonCode?}`. No resource IDs, names, URLs, bodies, tokens, queries, or raw remote errors.

Receipt acceptance is dual-mode: historical migration may keep the ten prior passes with `legacy-unbound` digests (explicitly incomplete); a current complete receipt requires bound git/dist/action fields, full matrix coverage, zero failures, justified substitutes only, and clean teardown. Fake hybrids, unbound complete claims, and current receipts with failed/missing-fixture/pending teardown are rejected.

## Safety rules

- `--provision` and `--teardown` are both required.
- Receipt binding is computed before credentials or provisioning, so failure receipts retain the current action version, commit, and dist digests. Teardown runs in `finally`, deletes only exact current-run Gateway/Endpoints/Apigee proxy names after ownership checks, proves no residue, and records `pending` until that proof completes.
- Shared Apigee organization, environment, environment group, and instance resources are never deleted.
- Do not use a production project or broaden cleanup beyond the current run.
- Never log `GCP_LIVE_FIXTURES_JSON` or credential material.
