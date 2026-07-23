import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

const parsed = parse(releaseWorkflow) as {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

function job(name: string): string {
  return releaseWorkflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

function assertOrder(earlier: string, later: string, haystack = releaseWorkflow): void {
  expect(haystack.indexOf(earlier), `missing earlier: ${earlier}`).toBeGreaterThanOrEqual(0);
  expect(haystack.indexOf(later), `missing later: ${later}`).toBeGreaterThanOrEqual(0);
  expect(haystack.indexOf(earlier)).toBeLessThan(haystack.indexOf(later));
}

function permissionMap(value: Record<string, string> | undefined): Record<string, string> {
  expect(value, 'permissions mapping missing').toBeTruthy();
  return value as Record<string, string>;
}

describe('release workflow publishing contract', () => {
  it('GCP-RELEASE-001: classifies before npm; immutable-only verify/publish/alias; exact main fetch', () => {
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$PKG_VERSION" ]; then');
    expect(releaseWorkflow).not.toContain('PUBLISH_TAGS');
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$MAJOR" ] || [ "$TAG_VERSION" = "$MAJOR.$MINOR" ]; then');
    expect(releaseWorkflow).toContain('release_kind=alias');
    assertOrder('Classify release tag', 'npm ci');

    const classify = job('classify');
    expect(classify.match(/git fetch --depth=1 origin main --no-tags/g) ?? []).toHaveLength(1);
    expect(classify).toContain("git rev-parse 'origin/main^{commit}'");
    expect(classify).toContain('if [ "$TAG_COMMIT" != "$MAIN_COMMIT" ]; then');
    expect(classify).not.toContain('git fetch --tags');
    expect(classify).not.toContain('fetch-depth: 0');

    const verify = job('verify-package');
    const publish = job('publish');
    const alias = job('advance-rolling-aliases');
    expect(verify).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(publish).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(alias).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");

    // verify-package keeps default shallow checkout (no depth override).
    const verifyCheckout = parsed.jobs['verify-package']?.steps?.find((step) =>
      step.uses?.startsWith('actions/checkout@')
    );
    expect(verifyCheckout).toBeTruthy();
    expect(verifyCheckout?.with ?? {}).not.toHaveProperty('fetch-depth');
    expect(verify).not.toContain('fetch-depth:');
  });

  it('GCP-RELEASE-002: exact permission mappings with no extras', () => {
    expect(permissionMap(parsed.permissions)).toEqual({ contents: 'read' });
    expect(Object.keys(permissionMap(parsed.permissions)).sort()).toEqual(['contents']);

    expect(permissionMap(parsed.jobs['verify-package']?.permissions)).toEqual({ contents: 'read' });
    expect(Object.keys(permissionMap(parsed.jobs['verify-package']?.permissions)).sort()).toEqual(['contents']);

    expect(permissionMap(parsed.jobs.publish?.permissions)).toEqual({
      contents: 'write',
      'id-token': 'write',
    });
    expect(Object.keys(permissionMap(parsed.jobs.publish?.permissions)).sort()).toEqual([
      'contents',
      'id-token',
    ]);

    expect(permissionMap(parsed.jobs['advance-rolling-aliases']?.permissions)).toEqual({
      contents: 'write',
    });
    expect(Object.keys(permissionMap(parsed.jobs['advance-rolling-aliases']?.permissions)).sort()).toEqual([
      'contents',
    ]);

    const verify = job('verify-package');
    expect(verify).not.toContain('id-token:');
    expect(verify).not.toContain('NODE_AUTH_TOKEN');
    expect(verify).not.toContain('NPM_TOKEN');
    expect(verify).not.toContain('cache: npm');
    expect(verify).not.toMatch(/\n\s+cache:/);
  });

  it('GCP-RELEASE-003: exact six-name gate queue, one pre-queue bundle, no mutators', () => {
    const verify = job('verify-package');
    expect(verify.match(/^\s*- run: npm ci$/gm) ?? []).toHaveLength(1);
    expect((verify.match(/npm run bundle/g) ?? []).length).toBe(1);
    assertOrder('- run: npm run bundle', 'name: Run gates', verify);
    expect(verify).toContain('MAX_PARALLEL_GATES=2');

    const gateBlock = verify.slice(verify.indexOf('name: Run gates'), verify.indexOf('Create release artifact'));
    const launches = [...gateBlock.matchAll(/^\s*run (\S+) /gm)].map((match) => match[1]);
    expect(launches).toEqual(['lint', 'typecheck', 'test', 'dist', 'actionlint', 'docs']);
    expect(gateBlock).toContain('run lint npm run lint');
    expect(gateBlock).toContain('run typecheck npm run typecheck');
    expect(gateBlock).toContain('run test npm test');
    expect(gateBlock).toContain('run dist npm run verify:dist:assert');
    expect(gateBlock).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(gateBlock).toContain('run docs node scripts/render-action-tables.mjs --check');
    expect(gateBlock).not.toContain('npm run bundle');
    expect(gateBlock).not.toContain('npm pack');
    expect(gateBlock).not.toContain('npm run build');
    expect(gateBlock).not.toContain('npm publish');
    expect(gateBlock).not.toContain('npm ci');
    expect(verify).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash',
    );
    expect(verify).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(verify).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(releaseWorkflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(releaseWorkflow).not.toContain('actions/setup-go');
    expect(releaseWorkflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('GCP-RELEASE-004: upload path block is exactly two paths; publish downloads into isolated runner.temp stage', () => {
    const verifyJob = parsed.jobs['verify-package'];
    const upload = verifyJob?.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe('release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    const uploadPaths = String(upload?.with?.path ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(uploadPaths).toEqual(['release.tgz', 'release-manifest.json']);
    expect(uploadPaths).toHaveLength(2);

    const publishJob = parsed.jobs.publish;
    const download = publishJob?.steps?.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download?.with?.name).toBe('release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(download?.with?.name).toBe(upload?.with?.name);
    expect(download?.with?.path).toBe('${{ runner.temp }}/release-stage');
  });

  it('GCP-RELEASE-005: publish checks out tag commit, verifies isolated stage, repacks, and directory-publishes', () => {
    const publish = job('publish');
    expect(publish).toContain('actions/checkout@');
    expect(publish).toContain('ref: ${{ github.sha }}');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toContain('npm test');
    expect(publish).not.toContain('npm run build');
    expect(publish).not.toMatch(/\n\s+cache:/);
    expect(publish).not.toContain('mkdir package');
    expect(publish).not.toContain('node package/scripts/verify-release-artifacts.mjs');
    expect(publish).toMatch(/EXPECTED_SHA256='[a-f0-9]{64}'/);
    expect(publish).toContain('STAGE_DIR="$RUNNER_TEMP/release-stage"');
    expect(publish).toContain('tar -xOf "$STAGE_DIR/release.tgz" package/scripts/verify-release-artifacts.mjs > "$VERIFIER"');
    expect(publish).toContain('test "$ACTUAL_SHA256" = "$EXPECTED_SHA256"');
    expect(publish).toContain("PACKAGE_NAME='@postman-cse/onboarding-gcp-spec-discovery'");
    expect(publish).toContain('PACKAGE_VERSION="${GITHUB_REF_NAME#v}"');
    expect(publish).toContain('node "$VERIFIER" "$STAGE_DIR"');
    expect(publish).toContain('npm pack --ignore-scripts --pack-destination');
    expect(publish).toContain('cmp -s');
    assertOrder('EXPECTED_SHA256=', 'node "$VERIFIER" "$STAGE_DIR"', publish);
    assertOrder(
      'tar -xOf "$STAGE_DIR/release.tgz" package/scripts/verify-release-artifacts.mjs',
      'node "$VERIFIER" "$STAGE_DIR"',
      publish,
    );
    assertOrder('node "$VERIFIER" "$STAGE_DIR"', 'Publish or verify npm package identity', publish);
    assertOrder('npm pack --ignore-scripts', 'npm publish --ignore-scripts', publish);
  });

  it('GCP-RELEASE-006: npm identity (SRI+gitHead) before GitHub Release before aliases; non-cancelling concurrency', () => {
    const publish = job('publish');
    expect(publish).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" --json');
    expect(publish).toContain('node "$VERIFIER" --check-npm-release-identity');
    expect(publish).toContain('npm publish --ignore-scripts --provenance --access public');
    expect(publish).not.toContain('npm publish ./release.tgz');
    expect(publish).toContain('for attempt in 1 2 3 4 5 6 7 8 9 10');
    expect(publish).toContain('uses: softprops/action-gh-release@');
    expect(publish).toContain('files: ${{ runner.temp }}/release-stage/release.tgz');
    assertOrder('Publish or verify npm package identity', 'Publish GitHub release', publish);
    assertOrder('npm publish --ignore-scripts --provenance --access public', 'softprops/action-gh-release', publish);
    assertOrder('\n  publish:', '\n  advance-rolling-aliases:');
    expect(releaseWorkflow).toContain('group: release-${{ github.repository }}');
    expect(releaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('GCP-RELEASE-007: fail-closed exact alias fetch; frozen v0; probe exit 1; parse failures propagate', () => {
    const alias = job('advance-rolling-aliases');
    expect(alias).toContain('set -euo pipefail');
    expect(alias).toContain('for ALIAS in "$MAJOR" "$MINOR"; do');
    expect(alias).toContain('git ls-remote --exit-code --tags origin "refs/tags/$ALIAS"');
    expect(alias).toContain('git fetch --depth=1 --no-tags origin "refs/tags/$ALIAS:refs/tags/$ALIAS"');
    expect(alias).toContain('failed to probe rolling alias');
    expect(alias).toContain('[ "$status" -ne 2 ]');
    expect(alias).toMatch(
      /failed to probe rolling alias \$ALIAS \(git ls-remote exit \$status\)"\s*\n\s*exit 1/
    );
    expect(alias).toContain(
      `CURRENT_VERSION=$(git show "$ALIAS^{commit}:package.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")`
    );
    expect(alias).not.toContain('|| true');
    expect(alias).not.toContain('2>/dev/null ||');
    expect(alias).not.toContain('||:');
    expect(alias).not.toMatch(/CURRENT_VERSION=.*\|\|\s*true/);
    expect(alias).not.toMatch(/CURRENT_VERSION=.*2>\/dev\/null/);
    expect(alias).toContain('if [ "$ALIAS" = "v0" ]; then');
    expect(alias).toContain('v0 major alias stays frozen');
    expect(alias).toContain('--alias-decision');
    expect(alias).toContain('scripts/verify-release-artifacts.mjs');
    expect(alias).toContain("$ALIAS^{commit}:package.json");
    expect(alias).toContain('is older than current alias target');
    const forceMoves = releaseWorkflow.match(/git push origin .* --force/g) ?? [];
    expect(forceMoves).toEqual(['git push origin "$ALIAS" --force']);
    expect(alias).toContain('git tag -fa "$ALIAS"');
    expect(alias).not.toContain('git fetch --tags');
  });
});
