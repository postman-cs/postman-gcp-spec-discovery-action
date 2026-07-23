# Release Policy

## Source of truth

Git tags and GitHub releases are the public release identifiers for this action. `package.json` versions support npm packaging, but consumers should select action versions by Git tag. The committed `dist/` bundle is part of the released artifact because GitHub Actions runs it verbatim from the tag.

## Tag policy

- Immutable releases use `vMAJOR.MINOR.PATCH` tags.
- The rolling major and minor aliases (`vMAJOR` and `vMAJOR.MINOR`, i.e. `v1` and `v1.0`) are force-moved by the release workflow's `advance-rolling-aliases` job after a successful immutable publish.
- Existing immutable release tags are never force-pushed, rewritten, deleted, or recreated.
- Every release tag commit must equal protected `origin/main`; the release workflow verifies this before publication.
- `v0` tags stay frozen at the last `v0` release. The `v0` major remains frozen.
- Every immutable release tag has a GitHub release with generated notes.

## Release checks

Run the package validators from this directory before pushing an immutable tag:

1. Confirm the working tree is clean.
2. Install dependencies once (`npm ci`).
3. Bundle once (`npm run bundle`).
4. Run the read-only validators against that one bundle (do not rebuild for verification):
   - `npm run lint`
   - `npm test`
   - `npm run typecheck`
   - `npm run verify:dist:assert`
   - `node scripts/render-action-tables.mjs --check`
   - pinned actionlint `1.7.11` over `.github/workflows/*.yml`: install the binary with the official `download-actionlint.bash` downloader **pinned to commit** `393031adb9afb225ee52ae2ccd7a5af5525e03e8` (not `main`) into `$RUNNER_TEMP` (or a local temp directory) and run that binary; do not install a Go toolchain or compile actionlint from source
5. Confirm `SECURITY.md`, `SUPPORT.md`, and this file still describe the release surface.

Pre-release validation must stay read-only after the single bundle: do not rebuild `dist/` for verification and do not regenerate README tables as the validation step. Local validation is one install, one `npm run bundle`, then the read-only checks above.

## CI

CI preserves required Linux (`gate`) and Windows (`windows`) jobs. Linux installs dependencies and bundles once (`npm run bundle`), then runs an at-most-two read-only queue containing lint, typecheck, test, dist verification, `actionlint`, docs (`node scripts/render-action-tables.mjs --check`), and PR-only `commitlint`; dist verification is `npm run verify:dist:assert` against the one pre-queue bundle. Windows installs dependencies only on an exact-cache miss, then runs direct, unfiltered `npm test` without bundling or a gate queue.

## Release order and boundary

Immutable releases serialize per repository without cancellation (`cancel-in-progress: false`). The executable contract is:

1. **verify-package** (unprivileged, `contents: read`) validates and packs only. It creates checksummed `release.tgz` (via `npm pack --ignore-scripts`) plus `release-manifest.json` and uploads those staged artifacts. It does not publish npm, create a GitHub Release, or move aliases. actionlint installer is fetched from the immutable actionlint commit pin above.
2. **publish** checks out the exact tag commit (`ref: github.sha`), downloads staged artifacts into `$RUNNER_TEMP/release-stage` (isolated from the checkout tree), verifies exact bytes and repository/commit/tag/package identity from the manifest using the checksum-pinned verifier extracted from `release.tgz`, independently `npm pack --ignore-scripts` the checked-out tree and `cmp`s that tarball to staged `release.tgz`, then either publishes the **checked-out directory** with `npm publish --ignore-scripts --provenance --access public` (so registry `gitHead` is set from the tag commit) or skips publish when the version already exists. After publish-or-skip, a bounded retry requires registry `dist.integrity` SRI to equal staged `release.tgz` **and** registry `gitHead` to equal `GITHUB_SHA` (missing `gitHead` is a hard failure). GitHub Release is created second from the staged tarball under `$RUNNER_TEMP`.
3. **advance-rolling-aliases** advances non-regressing major and minor aliases last. Alias movement never regresses to an older immutable target. The `v0` major remains frozen. Only rolling aliases may be force-moved; immutable `vMAJOR.MINOR.PATCH` tags never move.

Rolling-alias tag pushes are no-ops: no package, npm publish, GitHub Release, or alias rewrite.

## npm package

The CLI publishes as `@postman-cse/onboarding-gcp-spec-discovery` with versions that match the GitHub release tag. Publication is from the git checkout (not from a prebuilt tarball) so the registry records `gitHead` equal to the immutable tag commit. Staged `release.tgz` remains the byte-identity artifact for GitHub Release assets and SRI comparison. Rolling major/minor aliases update action channels and skip npm publishing.

## Compatibility

This action emits `spec-path`, `service-name`, and resolution metadata for downstream actions. Changes to output names, output types, required inputs, or resolution semantics are breaking changes and require a new major release.

## Security fixes

Security fixes ship on the latest immutable `vMAJOR.MINOR.PATCH` tag and move onto the rolling major/minor aliases. Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).

## Suite release order

GCP discovery can be released on its own unless a downstream onboarding example depends on a new composite or bootstrap feature. When multiple onboarding actions change together, release the lower-level actions first, then update the composite action after its pinned dependencies are available.
