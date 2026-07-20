import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('release workflow publishing contract', () => {
  it('GCP-RELEASE-001: immutable releases require origin/main, publish npm once, and move only rolling aliases', () => {
    // npm publishes ONLY from the exact package-version tag.
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$PKG_VERSION" ]; then');
    expect(releaseWorkflow).not.toContain('PUBLISH_TAGS');
    // Rolling aliases (v1, v1.0) skip npm publish.
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$MAJOR" ] || [ "$TAG_VERSION" = "$MAJOR.$MINOR" ]; then');
    expect(releaseWorkflow).toContain('npm_publish=false');
    // npm publish is gated on npm_publish plus not-already-published, with provenance.
    expect(releaseWorkflow).toContain(
      "if: steps.release_tag.outputs.npm_publish == 'true' && steps.npm_package.outputs.already_published != 'true'"
    );
    expect(releaseWorkflow).toContain('npm publish --provenance --access public');
    // GitHub release + tarball for the pushed tag.
    expect(releaseWorkflow).toContain('uses: softprops/action-gh-release@');
    expect(releaseWorkflow).toContain('files: release.tgz');
    // Every release tag must point at protected origin/main.
    expect(releaseWorkflow).toContain("git fetch origin main --no-tags");
    expect(releaseWorkflow).toContain("git rev-parse 'origin/main^{commit}'");
    expect(releaseWorkflow).toContain('if [ "$TAG_COMMIT" != "$MAIN_COMMIT" ]; then');
    // Only the alias job force-moves anything, and only the major/minor aliases.
    const forceMoves = releaseWorkflow.match(/git push origin .* --force/g) ?? [];
    expect(forceMoves).toEqual(['git push origin "$ALIAS" --force']);
    expect(releaseWorkflow).toContain('advance-rolling-aliases:');
    expect(releaseWorkflow).toContain('for ALIAS in "$MAJOR" "$MINOR"; do');
    expect(releaseWorkflow).toContain("if: ${{ needs.release.outputs.npm_publish == 'true' }}");
    // Release gates run before any publish (lint + README table drift included).
    for (const gate of [
      'npm test',
      'npm run typecheck',
      'npm run lint',
      'node scripts/render-action-tables.mjs --check',
      'npm run verify:dist',
    ]) {
      expect(releaseWorkflow).toContain(gate);
    }
    expect(releaseWorkflow).toContain('actionlint');
    // Preserve gate ordering: test -> typecheck -> lint -> docs check -> verify:dist -> actionlint.
    const gateBlock = releaseWorkflow.slice(
      releaseWorkflow.indexOf('- run: npm test'),
      releaseWorkflow.indexOf('Verify release tag matches package version')
    );
    expect(gateBlock.indexOf('npm test')).toBeLessThan(gateBlock.indexOf('npm run typecheck'));
    expect(gateBlock.indexOf('npm run typecheck')).toBeLessThan(gateBlock.indexOf('npm run lint'));
    expect(gateBlock.indexOf('npm run lint')).toBeLessThan(
      gateBlock.indexOf('node scripts/render-action-tables.mjs --check')
    );
    expect(gateBlock.indexOf('node scripts/render-action-tables.mjs --check')).toBeLessThan(
      gateBlock.indexOf('npm run verify:dist')
    );
    expect(gateBlock.indexOf('npm run verify:dist')).toBeLessThan(gateBlock.indexOf('actionlint'));
  });
});
