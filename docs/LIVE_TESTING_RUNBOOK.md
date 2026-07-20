# Live GCP validation runbook

Live validation is an operator-triggered, phase-addressable job. It binds a sanitized schema-v2 receipt to exact dist digests, provisions one disposable manifest, validates retained provider surfaces, tears down only current-run resources, and promotes tracked evidence only after a successful assemble. It is not part of pull-request CI.

## Prerequisites

- An explicitly selected disposable project via `GCP_PROJECT_ID`. Never rely on an ambient `gcloud` project; every mutating command passes `--project` from that env value.
- ADC credentials from `gcloud auth application-default login`, or equivalent workload identity credentials.
- A clean committed candidate build: `npm run build`, then commit the resulting `dist/` before live validation (the runner refuses missing or dirty `dist/` and never runs `npm run build` itself).

## Fresh-job orchestration

Default phase is `all` and still requires both lifecycle flags:

```sh
export GCP_PROJECT_ID=your-disposable-project-id
# Optional existing-resource fixtures (never logged):
# export GCP_LIVE_FIXTURES_JSON='[{"provider":"api-hub","resourceId":"projects/.../specs/...","expectedSourceType":"api-hub-spec","validationMode":"exact-bytes","expectedSha256":"<64-hex>","matrixName":"api-hub-original"}]'
node validation/scripts/validate-live-gcp-surfaces.mjs --phase all --provision --teardown
```

Prefer resumable phases for long runs. Private durable state and phase receipts live under gitignored `validation/.live-runs/` (mode `0600` JSON; traversal/symlinks rejected):

```sh
export GCP_PROJECT_ID=your-disposable-project-id
STATE=validation/.live-runs/state.json

node validation/scripts/validate-live-gcp-surfaces.mjs \
  --phase preflight --state-path "$STATE" \
  --command-timeout-ms 180000 --phase-timeout-ms 120000

node validation/scripts/validate-live-gcp-surfaces.mjs \
  --phase provision --provision --state-path "$STATE" \
  --command-timeout-ms 180000 --phase-timeout-ms 900000

node validation/scripts/validate-live-gcp-surfaces.mjs \
  --phase validate --state-path "$STATE" \
  --slots gateway-explicit-api-id,api-gateway,iac-local \
  --command-timeout-ms 180000 --phase-timeout-ms 1200000

node validation/scripts/validate-live-gcp-surfaces.mjs \
  --phase teardown --teardown --state-path "$STATE" \
  --command-timeout-ms 180000 --phase-timeout-ms 600000

node validation/scripts/validate-live-gcp-surfaces.mjs \
  --phase assemble \
  --phase-receipt validation/.live-runs/preflight-receipt.json \
  --phase-receipt validation/.live-runs/provision-receipt.json \
  --phase-receipt validation/.live-runs/validate-receipt.json \
  --phase-receipt validation/.live-runs/teardown-receipt.json \
  --command-timeout-ms 180000 --phase-timeout-ms 60000
```

### Maximum phase durations (guidance)

| Phase | Guidance ceiling | Notes |
| --- | --- | --- |
| `preflight` | 2 minutes | Project/env/auth/binding checks only; no resource creation |
| `provision` | 15 minutes | Enable/verify APIs + one manifest; checkpoints after each create |
| `validate` | 20 minutes | Requested slots only; fail-fast; carries prior completed slot receipts |
| `teardown` | 10 minutes | Exact ownership cleanup + absence proof; idempotent |
| `assemble` | 1 minute | Completeness/binding/substitute/teardown gates; only writer of tracked evidence |
| `all` | 60 minutes | Composes the same checkpoints for compatibility |

CLI bounds: `--command-timeout-ms` default `180000` (min `5000`, max `600000`); `--phase-timeout-ms` default `1200000` (min `30000`, max `3600000`). Every subprocess receives `min(command limit, remaining phase deadline)`. Timeouts map to sanitized `command-timeout` / `phase-timeout` failure classes. No unbounded synchronous command remains.

## Phase semantics

- `preflight` — exact project/env/auth/binding checks; writes state + receipt; no GCP resource creation.
- `provision` — consumes state; enables/verifies APIs; provisions one manifest; saves state after every successful create and state transition; does not validate.
- `validate` — consumes the same state; validates only requested allowed slots (`--slots`) or the full allowlist; fail-fast on first unexpected failure; preserves prior completed slot receipts; no provisioning/teardown.
- `teardown` — consumes state; exact ownership cleanup and absence proof only; idempotent; writes clean/fail receipt.
- `assemble` — combines completed phase receipts; requires every matrix/provisioned slot exactly once (or justified `satisfiedBy`), current binding, zero failures/missing fixtures, justified substitutes, and clean teardown before writing/promoting `validation/evidence/live-gcp-surfaces.json`.
- `all` — may compose phases for compatibility but uses the same checkpoints; failed runs never overwrite tracked final evidence (private failure receipts stay under `validation/.live-runs/failed-runs/`).

Failed validation with teardown `pass` is valid private failure evidence; it is not acceptable final tracked evidence.

## Coverage matrix

The runner derives required surfaces from the retained provider order (api-gateway, cloud-endpoints, apigee proxy + archive, api-hub original + additional, apigee-registry, app-integration, connectors-custom, apigee-portal, vertex-extensions, agent-engines, dialogflow-tools, ces-toolsets, iac-local). Tests fail if the matrix and runtime provider order drift.

Provisioned run-scoped cases (always executed in a full validate):

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

Fixture selection is provider/source-specific via optional `selectionStrategy`: strict `--api-id` (`strict-api-id`) only for source forms the runtime explicit parser accepts; `--expected-api-ids-json` + service hint (`expected-api-ids`) for parser-less providers (`app-integration`, `connectors-custom`, `agent-engines`); `api-hub-additional` uses the deterministic `spec#VARIANT` selector so generated content cannot collapse to the stored original. Strategies that can select arbitrary unrelated candidates are rejected.

Apigee archive substitutes authenticate against the environment `archiveDeployments` endpoint (not the generic proxy API). Org/env values are never logged.

Agent Engines completion/substitute must pair an authenticated probe (available or closed-reason unavailability) with a compiled-CLI `manual-derived-blocked` proof that local-derived authority cannot resolve/export. Availability alone cannot pass.

## Receipt

Schema v2 includes ISO `capturedAt`, `actionVersion`, `gitCommit`, `distCliSha256`, `distIndexSha256`, constant `projectScope` alias, totals, sanitized teardown status, and per-case `{name, providerType, sourceType, specFormat, status, validationMode, reasonCode?}`. No resource IDs, names, URLs, bodies, tokens, queries, or raw remote errors.

Every phase also writes a sanitized phase receipt (phase/group, elapsed ms, current binding, status/failure class) atomically in `finally`. Private run state may contain resource identifiers under `validation/.live-runs/`; tracked evidence must not.

Receipt acceptance is dual-mode: historical migration must declare `historical` and use `legacy-unbound` for all four binding fields, preserving the ten prior passes as explicitly incomplete; a current complete receipt must declare `current`, use bound git/dist/action fields, have full matrix coverage, zero failures, justified substitutes only, and clean teardown. Fake hybrids, partial/unbound bindings, unbound complete claims, and current receipts with failed/missing-fixture/pending teardown are rejected.

## Safety rules

- `provision` requires `--provision`; `teardown` requires `--teardown`; `all` requires both. Phase state also rejects provision before preflight, validation before provision, and validation after teardown.
- Receipt binding is computed before credentials or provisioning, so failure receipts retain the current action version, commit, and dist digests.
- Teardown: unattempted surfaces are not probed; attempted-but-unconfirmed surfaces must prove exact-name absence and are never deleted; confirmed resources must prove the current-run marker/name before deletion and exact-name absence afterward. Repeated teardown is safe because an already-absent confirmed resource is accepted as absent.
- Shared Apigee organization, environment, environment group, and instance resources are never deleted.
- Do not use a production project or broaden cleanup beyond the current run.
- Never log `GCP_LIVE_FIXTURES_JSON` or credential material.
- Never put private IDs/specs/tokens in tracked evidence.
