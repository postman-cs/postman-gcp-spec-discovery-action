# postman-gcp-spec-discovery-action

Discovers GCP-hosted API specifications (API Gateway, Cloud Endpoints, Apigee, and related surfaces) and emits resolution metadata for downstream Postman onboarding actions. Dual entry: GitHub Action (`dist/index.cjs`) and CLI (`dist/cli.cjs`).

## Commands

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run bundle
npm run verify:dist:assert   # read-only dist contract (CI)
npm run verify:dist          # rebuild + git diff + assert
node scripts/render-action-tables.mjs --check
```

## CI

`.github/workflows/ci.yml` runs one `gate` job. Bundles once, queues at most two checks on one runner. Typecheck runs exactly once. Dist is read-only `verify:dist:assert`; no second build. Every check prints `::group::` result even when another fails.

## Releases

Tags are an **output** of passing run, never input. Never push release tags by hand; `.githooks/pre-push` rejects them.

- `.github/workflows/auto-release.yml` runs on every push to `main` and drives `scripts/release-cut.mjs`.
- `node scripts/release-cut.mjs --plan` reports pending cut (fetch tags first). `--execute` bumps, rebuilds `dist/`, runs typecheck/lint/test/docs-table checks, commits, re-verifies committed bytes, then tags last.
- Version comes from highest tag ever cut, not `package.json`. Existing tags are burnt and skipped, so failed cut never reuses or rewinds version.
- Conventional-commit type picks bump; `chore`/`ci`/`build`/`test`/`style` alone cut nothing.
- release commit lives only on tag. `release.yml` reads tagged commit; `main` advances through pull requests.
- `RELEASE_POLICY.md` holds full contract.

## Anti-Patterns

- Never hardcode secrets, tokens, or absolute paths in durable memory
- Never run credentialed live GCP validation in CI pull requests
