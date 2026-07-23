import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error JavaScript release verifier is intentionally packaged verbatim.
import { validateManifest, verifyReleaseArtifacts } from '../scripts/verify-release-artifacts.mjs';

const sha256hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const expected = {
  repository: 'postman-cs/postman-gcp-spec-discovery-action',
  commitSha: 'a'.repeat(40),
  tag: 'v1.1.3',
  packageName: '@postman-cse/onboarding-gcp-spec-discovery',
  packageVersion: '1.1.3',
};

const baseManifest = {
  schema_version: 1,
  repository: expected.repository,
  commit_sha: expected.commitSha,
  tag: expected.tag,
  package_name: expected.packageName,
  package_version: expected.packageVersion,
};

// Build a real tarball whose `package/package.json` entry carries the given identity,
// writing it into `stagedDir/release.tgz`. Returns the tarball sha256. The build
// happens in a separate temp dir so no stray files leak into the staged allowlist.
function writeTarball(stagedDir: string, name: string, version: string): string {
  const build = mkdtempSync(join(tmpdir(), 'gcp-tar-build-'));
  try {
    mkdirSync(join(build, 'package'), { recursive: true });
    writeFileSync(join(build, 'package', 'package.json'), JSON.stringify({ name, version }));
    execFileSync('tar', ['-czf', join(stagedDir, 'release.tgz'), '-C', build, 'package/package.json']);
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
  return sha256hex(readFileSync(join(stagedDir, 'release.tgz')));
}

function freshStage(): string {
  return mkdtempSync(join(tmpdir(), 'gcp-release-artifact-'));
}

describe('release artifact contract', () => {
  const manifest = { ...baseManifest, artifacts: [{ path: 'release.tgz', sha256: sha256hex('tarball') }] };

  it('GCP-RELEASE-ARTIFACT-001: accepts only a manifest bound to this release identity', () => {
    expect(validateManifest(manifest, expected)).toEqual(manifest);
    expect(() => validateManifest({ ...manifest, repository: 'other/repository' }, expected)).toThrow('repository');
    expect(() => validateManifest({ ...manifest, commit_sha: 'b'.repeat(40) }, expected)).toThrow('commit_sha');
    expect(() => validateManifest({ ...manifest, tag: 'v1.1.2' }, expected)).toThrow('tag');
  });

  it('GCP-RELEASE-ARTIFACT-002: rejects invalid package versions and checksums', () => {
    expect(() => validateManifest({ ...manifest, package_version: '1.1.2' }, expected)).toThrow('package_version');
    expect(() => validateManifest({ ...manifest, artifacts: [{ path: 'release.tgz', sha256: 'bad' }] }, expected)).toThrow('sha256');
  });

  it('GCP-RELEASE-ARTIFACT-003: rejects dot-only and invalid artifact paths', () => {
    expect(() => validateManifest({ ...manifest, artifacts: [{ path: '.', sha256: sha256hex('x') }] }, expected)).toThrow('invalid artifact path');
    expect(() => validateManifest({ ...manifest, artifacts: [{ path: '..', sha256: sha256hex('x') }] }, expected)).toThrow('invalid artifact path');
    expect(() => validateManifest({ ...manifest, artifacts: [{ path: 'a/b', sha256: sha256hex('x') }] }, expected)).toThrow('invalid artifact path');
  });

  describe('verifyReleaseArtifacts (staged directory)', () => {
    it('accepts a valid staged tarball and manifest', () => {
      const dir = freshStage();
      try {
        const sha = writeTarball(dir, expected.packageName, expected.packageVersion);
        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, artifacts: [{ path: 'release.tgz', sha256: sha }] }));
        expect(() => verifyReleaseArtifacts(dir, expected)).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a tarball checksum mismatch', () => {
      const dir = freshStage();
      try {
        writeTarball(dir, expected.packageName, expected.packageVersion);
        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, artifacts: [{ path: 'release.tgz', sha256: sha256hex('wrong') }] }));
        expect(() => verifyReleaseArtifacts(dir, expected)).toThrow('checksum mismatch');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects an unexpected extra staged file outside the allowlist', () => {
      const dir = freshStage();
      try {
        const sha = writeTarball(dir, expected.packageName, expected.packageVersion);
        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, artifacts: [{ path: 'release.tgz', sha256: sha }] }));
        writeFileSync(join(dir, 'evil-payload'), 'not allowed');
        expect(() => verifyReleaseArtifacts(dir, expected)).toThrow('unexpected staged file');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a tarball whose package name/version differ from the manifest', () => {
      const dir = freshStage();
      try {
        const sha = writeTarball(dir, 'wrong-package', expected.packageVersion);
        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, artifacts: [{ path: 'release.tgz', sha256: sha }] }));
        expect(() => verifyReleaseArtifacts(dir, expected)).toThrow('tarball package identity');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects when the immutable tag does not match the package version', () => {
      const dir = freshStage();
      try {
        const tagMismatch = { ...expected, tag: 'v9.9.9' };
        // Manifest identity matches `tagMismatch`, but the tarball still reports 1.1.3,
        // so validateTagVersion is the check that fails.
        const sha = writeTarball(dir, expected.packageName, expected.packageVersion);
        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, tag: 'v9.9.9', artifacts: [{ path: 'release.tgz', sha256: sha }] }));
        expect(() => verifyReleaseArtifacts(dir, tagMismatch)).toThrow('does not match package version');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a manifest bound to the wrong repository', () => {
      const dir = freshStage();
      try {
        const sha = writeTarball(dir, expected.packageName, expected.packageVersion);
        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, repository: 'other/repository', artifacts: [{ path: 'release.tgz', sha256: sha }] }));
        expect(() => verifyReleaseArtifacts(dir, expected)).toThrow('repository');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
