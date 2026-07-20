# Validation Evidence

`live-gcp-surfaces.json` is the sanitized schema-v2 receipt for GCP live validation. Only a successful `assemble` (or successful `all` that reaches assemble) may overwrite this tracked file. Failed phases write private receipts under gitignored `validation/.live-runs/` and must leave this fixture untouched.

## Schema v2 fields

Receipt metadata:

- `schemaVersion` (2)
- `evidenceKind` — `historical` (migrated legacy run) or `current` (bound to compiled bytes)
- `capturedAt` — ISO-8601 timestamp
- `actionVersion`, `gitCommit`, `distCliSha256`, `distIndexSha256`
- `projectScope` — constant alias `live-validation-project` (never a project id)
- `totals` — `{ cases, passed, failed, substituted }`
- `teardown` — `{ status, reasonCode? }` only (no resource inventory)

Per-case fields only: `name`, `providerType`, `sourceType`, `specFormat`, `status` (`pass|fail|substitute`), `validationMode`, optional `reasonCode`.

Do not commit project identifiers, resource IDs/names, URLs, spec bodies, tokens, queries, raw remote errors, or hashes of sensitive remote data.

## Historical vs current

The committed file may be `evidenceKind: historical` only when all four binding fields are exactly `legacy-unbound`. That preserves the ten Gateway/Endpoints/Apigee-proxy/IaC passes from the prior live run; it does **not** claim complete provider coverage. A current credentialed rerun must explicitly declare `evidenceKind: current`, use real bindings, and provide matrix coverage (pass or closed-code substitute) for every retained provider surface. Acceptance helpers allow either truthful historical migration or a bound current-complete receipt; hybrids, partial/unbound bindings, unbound complete claims, and current receipts with failures/`missing-fixture`/pending teardown are rejected.

Failed validation with teardown `pass` is valid private failure evidence under `validation/.live-runs/failed-runs/`; it is not acceptable final tracked evidence.

## Fixtures

Optional existing-resource fixtures are supplied only via `GCP_LIVE_FIXTURES_JSON` (never logged). Each entry requires `provider`, `resourceId`, `expectedSourceType`, `validationMode` (`exact-bytes` | `semantic-openapi` | `manual-derived-blocked`), and `matrixName`; it must map to exactly one retained matrix variant in the selected project/org scope. Exact-byte entries require `expectedSha256` or a relative, repo-confined non-symlink `expectedFixturePath`; semantic entries require that expected fixture path. Optional `selectionStrategy` (`strict-api-id` | `expected-api-ids` | `api-hub-additional`) and `serviceHint` are derived when omitted; unsafe strategies that can select arbitrary unrelated candidates are rejected. API Hub additional fixtures normalize to `spec#BOOSTED_SPEC_CONTENT` or `spec#GATEWAY_OPEN_API_SPEC`. Unknown keys, duplicate matrix variants, traversal, absolute and symlink paths are rejected.

## Run

```sh
npm run build
# commit the clean dist candidate before live validation
export GCP_PROJECT_ID=<disposable-project>
# optional: export GCP_LIVE_FIXTURES_JSON='[...]'

# Guarded full run (same checkpoints as phased mode):
node validation/scripts/validate-live-gcp-surfaces.mjs --phase all --provision --teardown

# Or resume by phase (state/receipts under validation/.live-runs/):
node validation/scripts/validate-live-gcp-surfaces.mjs --phase preflight --state-path validation/.live-runs/state.json
node validation/scripts/validate-live-gcp-surfaces.mjs --phase provision --provision --state-path validation/.live-runs/state.json
node validation/scripts/validate-live-gcp-surfaces.mjs --phase validate --state-path validation/.live-runs/state.json
node validation/scripts/validate-live-gcp-surfaces.mjs --phase teardown --teardown --state-path validation/.live-runs/state.json
node validation/scripts/validate-live-gcp-surfaces.mjs --phase assemble \
  --phase-receipt validation/.live-runs/preflight-receipt.json \
  --phase-receipt validation/.live-runs/provision-receipt.json \
  --phase-receipt validation/.live-runs/validate-receipt.json \
  --phase-receipt validation/.live-runs/teardown-receipt.json
```

Do not use an ambient `gcloud` project; pass `GCP_PROJECT_ID` explicitly. Bounded timeouts: `--command-timeout-ms` (default 180000) and `--phase-timeout-ms` (default 1200000). Guidance ceilings: preflight 2m, provision 15m, validate 20m, teardown 10m, assemble 1m.

Private durable state under `validation/.live-runs/` holds the run manifest, exact attempted/created resource state, binding, completed slots, and sanitized phase status. Tracked evidence is written only by successful assemble/promotion.
