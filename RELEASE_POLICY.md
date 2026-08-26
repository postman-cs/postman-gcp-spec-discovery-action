# Release Policy

## Source of truth

Git tags and GitHub releases are the public release identifiers for this action. `package.json` versions support npm packaging, but consumers should select action versions by Git tag. The committed `dist/` bundle is part of the released artifact because GitHub Actions runs it verbatim from the tag.

## Tag policy

- Immutable releases use `vMAJOR.MINOR.PATCH` tags.
- The rolling major and minor aliases (`vMAJOR` and `vMAJOR.MINOR`, i.e. `v1` and `v1.0`) are force-moved by the release workflow's `advance-rolling-aliases` job after a successful immutable publish.
- Existing immutable release tags are never force-pushed, rewritten, deleted, or recreated.
- Immutable release tags are cut automatically from `main` by `.github/workflows/auto-release.yml`; the tagged commit carries the version bump and rebuilt `dist/`, and is not pushed onto `main`.
- Every release tag commit must descend from protected `origin/main`; the release workflow verifies by ancestry before publication.
- `v0` tags stay frozen at the last `v0` release. The `v0` major remains frozen.
- Every immutable release tag has a GitHub release with generated notes.

## Release checks

Releases are cut automatically. Merging to `main` runs `.github/workflows/auto-release.yml`,
which derives the next version from the conventional-commit history, then runs
`scripts/release-cut.mjs`: bump, rebuild `dist/`, run the gate set, commit, and tag.

The tag is created only after the exact bytes of the release commit pass every
gate, so a failed cut leaves no tag and burns no version number. The next merge
retries on a fresh version, skipping any already-tagged one.

Before planning another cut, auto-release reconciles the latest immutable tag
when its GitHub release is missing or either rolling alias has not advanced. It
does not duplicate an active release run, and a successful release completion
resumes planning.

Do not push `vX.Y.Z` tags by hand. The pre-push hook refuses them, because a
hand-pushed tag becomes a public identifier before any gate has run against it.

To see what the next merge would cut:

```sh
node scripts/release-cut.mjs --plan
```

The same read-only validators run locally before any push:

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
2. **publish** checks out the exact tag commit (`ref: github.sha`), downloads staged artifacts into `$RUNNER_TEMP/release-stage` (isolated from the checkout tree), verifies exact bytes and repository/commit/tag/package identity from the manifest using the checksum-pinned verifier extracted from `release.tgz`, independently `npm pack --ignore-scripts` the checked-out tree and `cmp`s that tarball to staged `release.tgz`, then creates the authoritative GitHub Release from the staged tarball under `$RUNNER_TEMP`. It attempts npm publication separately and warns without failing the job when registry access is unavailable. When the npm attempt succeeds (including an existing version), a bounded retry requires registry `dist.integrity` SRI to equal staged `release.tgz` **and** registry `gitHead` to equal `GITHUB_SHA` (missing `gitHead` is a hard failure).
3. **advance-rolling-aliases** advances non-regressing major and minor aliases last. Alias movement never regresses to an older immutable target. The `v0` major remains frozen. Only rolling aliases may be force-moved; immutable `vMAJOR.MINOR.PATCH` tags never move.

Rolling-alias tag pushes are no-ops: no package, npm publish, GitHub Release, or alias rewrite.

## npm package

The CLI publishes as `@postman-cs/onboarding-gcp-spec-discovery` with versions that match the GitHub release tag. Publication is OIDC-only and runs from the git checkout (not from a prebuilt tarball) so the registry records `gitHead` equal to the immutable tag commit. Staged `release.tgz` remains the byte-identity artifact for GitHub Release assets and SRI comparison. GitHub Releases and tags remain authoritative if npm publication warns; rerun the immutable release after trusted publishing is restored. Rolling major/minor aliases update action channels and skip npm publishing.

## Compatibility

This action emits `spec-path`, `service-name`, and resolution metadata for downstream actions. Changes to output names, output types, required inputs, or resolution semantics are breaking changes and require a new major release.

## Security fixes

Security fixes ship on the latest immutable `vMAJOR.MINOR.PATCH` tag and move onto the rolling major/minor aliases. Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).

## Suite release order

GCP discovery can be released on its own unless a downstream onboarding example depends on a new composite or bootstrap feature. When multiple onboarding actions change together, release the lower-level actions first, then update the composite action after its pinned dependencies are available.
