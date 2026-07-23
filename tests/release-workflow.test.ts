import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('release workflow publishing contract', () => {
  it('GCP-RELEASE-001: classifies before install, validates immutable main-tip releases, and uses a bundle-once queue', () => {
    // npm publishes ONLY from the exact package-version tag.
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$PKG_VERSION" ]; then');
    expect(releaseWorkflow).not.toContain('PUBLISH_TAGS');
    // Rolling aliases (v1, v1.0) skip npm publish.
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$MAJOR" ] || [ "$TAG_VERSION" = "$MAJOR.$MINOR" ]; then');
    expect(releaseWorkflow).toContain('release_kind=alias');
    // npm publish is gated on npm_publish plus not-already-published, with provenance.
    expect(releaseWorkflow).toContain('npm publish ./release.tgz --provenance --access public');
    // GitHub release + tarball for the pushed tag.
    expect(releaseWorkflow).toContain('uses: softprops/action-gh-release@');
    expect(releaseWorkflow).toContain('files: release.tgz');
    // Every release tag must point at protected origin/main.
    expect(releaseWorkflow).toContain('git fetch --depth=1 origin main --no-tags');
    expect(releaseWorkflow).toContain("git rev-parse 'origin/main^{commit}'");
    expect(releaseWorkflow).toContain('if [ "$TAG_COMMIT" != "$MAIN_COMMIT" ]; then');
    // Only the alias job force-moves anything, and only the major/minor aliases.
    expect(releaseWorkflow).toContain('is older than current alias target');
    // Only the alias job force-moves anything, and exactly the major/minor aliases (no other force push).
    const forceMoves = releaseWorkflow.match(/git push origin .* --force/g) ?? [];
    expect(forceMoves).toEqual(['git push origin "$ALIAS" --force']);
    expect(releaseWorkflow).toContain('advance-rolling-aliases:');
    expect(releaseWorkflow).toContain('for ALIAS in "$MAJOR" "$MINOR"; do');
    expect(releaseWorkflow).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    // Release gates run before any publish (lint + README table drift included).
    for (const gate of [
      'npm test',
      'npm run typecheck',
      'npm run lint',
      'node scripts/render-action-tables.mjs --check',
      'npm run verify:dist:assert',
    ]) {
      expect(releaseWorkflow).toContain(gate);
    }
    expect(releaseWorkflow).toContain('actionlint');
    expect(releaseWorkflow).toContain('MAX_PARALLEL_GATES=2');
    expect(releaseWorkflow).toContain('npm run bundle');
    expect(releaseWorkflow).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(releaseWorkflow).not.toContain('actions/setup-go');
    expect(releaseWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(releaseWorkflow).toContain('cancel-in-progress: false');
    expect(releaseWorkflow).toContain('release-${{ github.repository }}');
    expect(releaseWorkflow.indexOf('Classify release tag')).toBeLessThan(releaseWorkflow.indexOf('npm ci'));
    const gateBlock = releaseWorkflow.slice(
      releaseWorkflow.indexOf('name: Run gates'),
      releaseWorkflow.indexOf('Create release artifact')
    );
    for (const command of ['run lint', 'run typecheck', 'run test', 'run dist', 'run actionlint', 'run docs']) {
      expect(gateBlock).toContain(command);
    }
  });
});
