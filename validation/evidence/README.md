# Validation Evidence

`live-gcp-surfaces.json` is the sanitized schema-v2 receipt for GCP live validation.

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

The committed file may be `evidenceKind: historical` with digests/version marked `legacy-unbound`. That preserves the ten Gateway/Endpoints/Apigee-proxy/IaC passes from the prior live run; it does **not** claim complete provider coverage. A current credentialed rerun must rewrite the receipt with real digests and matrix coverage (pass or closed-code substitute) for every retained provider surface. Acceptance helpers allow either truthful historical migration or a bound current-complete receipt; hybrids, unbound complete claims, and current receipts with failures/`missing-fixture`/pending teardown are rejected.

## Fixtures

Optional existing-resource fixtures are supplied only via `GCP_LIVE_FIXTURES_JSON` (never logged). Each entry requires `provider`, `resourceId`, `expectedSourceType`, `validationMode` (`exact-bytes` | `semantic-openapi` | `manual-derived-blocked`), and `matrixName`; it must map to exactly one retained matrix variant in the selected project/org scope. Exact-byte entries require `expectedSha256` or a relative, repo-confined non-symlink `expectedFixturePath`; semantic entries require that expected fixture path. Optional `selectionStrategy` (`strict-api-id` | `expected-api-ids` | `api-hub-additional`) and `serviceHint` are derived when omitted; unsafe strategies that can select arbitrary unrelated candidates are rejected. API Hub additional fixtures normalize to `spec#BOOSTED_SPEC_CONTENT` or `spec#GATEWAY_OPEN_API_SPEC`. Unknown keys, duplicate matrix variants, traversal, absolute and symlink paths are rejected.

## Run

```sh
npm run build
# commit the clean dist candidate before live validation
export GCP_PROJECT_ID=<disposable-project>
# optional: export GCP_LIVE_FIXTURES_JSON='[...]'
node validation/scripts/validate-live-gcp-surfaces.mjs --provision --teardown
```

The runner binds to exact `dist/cli.cjs` and `dist/index.cjs` bytes before provisioning (dirty `dist/` is refused until a clean committed candidate exists), creates collision-resistant Gateway/Endpoints/Apigee proxy resources, covers remaining matrix slots via fixtures or authenticated probe substitutes, and tears down only exact current-run resources. Shared Apigee organization/environment/instance resources are never deleted. An `available` probe without a fixture fails as `missing-fixture` (never a silent substitute). Apigee archive substitutes probe `archiveDeployments`; Agent Engines require paired probe + compiled `manual-derived-blocked` proof.
