import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertNpmSriMatch,
  computeNpmSri,
  decideAliasVersion,
  npmSriEquals,
  validateManifest,
  verifyReleaseArtifacts,
  // @ts-expect-error JavaScript release verifier is intentionally packaged verbatim.
} from '../scripts/verify-release-artifacts.mjs';

const sha256hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Bounded wait for tar / Node verifier / npm pack under full-suite parallel load. */
const EXTERNAL_COMMAND_TIMEOUT_MS = 20_000;
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const verifierPath = join(process.cwd(), 'scripts/verify-release-artifacts.mjs');
const verifierDigest = sha256hex(readFileSync(verifierPath));
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  files: string[];
};
const npmCliPath = process.env.npm_execpath;

const expected = {
  repository: 'postman-cs/postman-gcp-spec-discovery-action',
  commitSha: 'a'.repeat(40),
  tag: 'v1.1.4',
  packageName: '@postman-cse/onboarding-gcp-spec-discovery',
  packageVersion: '1.1.4',
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
    execFileSync('tar', ['-czf', join(stagedDir, 'release.tgz'), '-C', build, 'package/package.json'], {
      timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
    });
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

  it('GCP-RELEASE-ARTIFACT-001: release.yml is required and pins verifier digest to the script on disk', () => {
    expect(releaseWorkflow.length).toBeGreaterThan(0);
    expect(releaseWorkflow).toContain('name: Release');
    const publishJob = releaseWorkflow.match(/ {2}publish:\n[\s\S]*?(?=\n {2}[a-zA-Z0-9_-]+:|$)/)?.[0] ?? '';
    expect(publishJob).toContain(`EXPECTED_SHA256='${verifierDigest}'`);
    expect(publishJob).toContain('test "$ACTUAL_SHA256" = "$EXPECTED_SHA256"');
    expect(publishJob).toContain("PACKAGE_NAME='@postman-cse/onboarding-gcp-spec-discovery'");
    expect(publishJob).toContain('PACKAGE_VERSION="${GITHUB_REF_NAME#v}"');
    expect(packageJson.files).toContain('scripts/verify-release-artifacts.mjs');
  });

  it('GCP-RELEASE-ARTIFACT-002: accepts only a manifest bound to this release identity', () => {
    expect(validateManifest(manifest, expected)).toEqual(manifest);
    expect(() => validateManifest({ ...manifest, repository: 'other/repository' }, expected)).toThrow('repository');
    expect(() => validateManifest({ ...manifest, commit_sha: 'b'.repeat(40) }, expected)).toThrow('commit_sha');
    expect(() => validateManifest({ ...manifest, tag: 'v1.1.2' }, expected)).toThrow('tag');
    expect(() => validateManifest({ ...manifest, package_name: '@other/pkg' }, expected)).toThrow('package_name');
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

    it('rejects wrong repo/SHA/tag/name/version/checksum and exact stage allowlist extras', () => {
      const dir = freshStage();
      try {
        const sha = writeTarball(dir, expected.packageName, expected.packageVersion);
        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, artifacts: [{ path: 'release.tgz', sha256: sha }] }));

        expect(() => verifyReleaseArtifacts(dir, { ...expected, repository: 'other/repository' })).toThrow('repository');
        expect(() => verifyReleaseArtifacts(dir, { ...expected, commitSha: 'b'.repeat(40) })).toThrow('commit_sha');
        expect(() => verifyReleaseArtifacts(dir, { ...expected, tag: 'v9.9.9' })).toThrow('tag');
        expect(() => verifyReleaseArtifacts(dir, { ...expected, packageName: '@other/pkg' })).toThrow('package_name');
        expect(() => verifyReleaseArtifacts(dir, { ...expected, packageVersion: '9.9.9' })).toThrow('package_version');

        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, artifacts: [{ path: 'release.tgz', sha256: sha256hex('wrong') }] }));
        expect(() => verifyReleaseArtifacts(dir, expected)).toThrow('checksum mismatch');

        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, artifacts: [{ path: 'release.tgz', sha256: sha }] }));
        writeFileSync(join(dir, 'evil-payload'), 'not allowed');
        expect(() => verifyReleaseArtifacts(dir, expected)).toThrow('unexpected staged file');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a tarball whose package name/version differ from the trusted identity', () => {
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
        const sha = writeTarball(dir, expected.packageName, expected.packageVersion);
        writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify({ ...baseManifest, tag: 'v9.9.9', artifacts: [{ path: 'release.tgz', sha256: sha }] }));
        expect(() => verifyReleaseArtifacts(dir, tagMismatch)).toThrow('does not match package version');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('GCP-RELEASE-ARTIFACT-004: matching/mismatching npm SRI and older/equal/newer alias decisions', () => {
    const bytes = Buffer.from('gcp-release-tarball');
    const sri = computeNpmSri(bytes);
    expect(sri).toMatch(/^sha512-/);
    expect(npmSriEquals(sri, sri)).toBe(true);
    expect(npmSriEquals(sri, 'sha512-other')).toBe(false);
    expect(() => assertNpmSriMatch(sri, sri)).not.toThrow();
    expect(() => assertNpmSriMatch(sri, 'sha512-AAAAAAAAAAAAAAAAAAAAAA==')).toThrow(/integrity/);

    const dir = freshStage();
    try {
      writeTarball(dir, expected.packageName, expected.packageVersion);
      const stagedSri = computeNpmSri(join(dir, 'release.tgz'));
      expect(() => assertNpmSriMatch(stagedSri, computeNpmSri(join(dir, 'release.tgz')))).not.toThrow();
      expect(() => assertNpmSriMatch(stagedSri, 'sha512-not-matching')).toThrow(/integrity/);
      execFileSync(process.execPath, [verifierPath, '--check-npm-sri', join(dir, 'release.tgz'), stagedSri], {
        encoding: 'utf8',
        timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
      });
      expect(() =>
        execFileSync(process.execPath, [verifierPath, '--check-npm-sri', join(dir, 'release.tgz'), 'sha512-bad'], {
          encoding: 'utf8',
          timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
        })
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(decideAliasVersion({ currentVersion: '1.1.2', candidateVersion: '1.1.3' })).toEqual({ action: 'advance' });
    expect(decideAliasVersion({ currentVersion: '1.1.3', candidateVersion: '1.1.3' })).toEqual({ action: 'advance' });
    expect(decideAliasVersion({ currentVersion: '1.2.0', candidateVersion: '1.1.3' })).toEqual({ action: 'skip' });
    expect(() => decideAliasVersion({ currentVersion: '1.1', candidateVersion: '1.1.3' })).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(() => decideAliasVersion({ currentVersion: '1.1.3', candidateVersion: 'bad' })).toThrow(/MAJOR\.MINOR\.PATCH/);

    expect(
      execFileSync(process.execPath, [verifierPath, '--alias-decision', '1.1.2', '1.1.3'], {
        encoding: 'utf8',
        timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
      }).trim(),
    ).toBe('advance');
    expect(
      execFileSync(process.execPath, [verifierPath, '--alias-decision', '1.1.3', '1.1.3'], {
        encoding: 'utf8',
        timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
      }).trim(),
    ).toBe('advance');
    expect(
      execFileSync(process.execPath, [verifierPath, '--alias-decision', '1.2.0', '1.1.3'], {
        encoding: 'utf8',
        timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
      }).trim(),
    ).toBe('skip');
  });

  it(
    'GCP-RELEASE-ARTIFACT-005: real npm-packed verifier handoff matches pin and verifies the exact two-file stage',
    () => {
      const packDir = mkdtempSync(join(tmpdir(), 'gcp-npm-pack-'));
      const stageDir = mkdtempSync(join(tmpdir(), 'gcp-packed-stage-'));
      const extractDir = mkdtempSync(join(tmpdir(), 'gcp-extracted-verifier-'));
      try {
        if (!npmCliPath) throw new Error('npm_execpath is required for the npm-packed verifier contract');
        execFileSync(process.execPath, [npmCliPath, 'pack', '--ignore-scripts', '--pack-destination', packDir], {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
        });
        const packed = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
        expect(packed).toHaveLength(1);
        const releaseTgz = join(stageDir, 'release.tgz');
        renameSync(join(packDir, packed[0]!), releaseTgz);

        const tarballSha = sha256hex(readFileSync(releaseTgz));
        const identity = {
          repository: 'postman-cs/postman-gcp-spec-discovery-action',
          commit_sha: 'c'.repeat(40),
          tag: `v${packageJson.version}`,
          package_name: packageJson.name,
          package_version: packageJson.version,
        };
        writeFileSync(
          join(stageDir, 'release-manifest.json'),
          JSON.stringify({
            schema_version: 1,
            ...identity,
            artifacts: [{ path: 'release.tgz', sha256: tarballSha }],
          })
        );
        expect(readdirSync(stageDir).sort()).toEqual(['release-manifest.json', 'release.tgz']);

        const extractedVerifier = join(extractDir, 'verify-release-artifacts.mjs');
        const extractedBytes = execFileSync('tar', ['-xOf', releaseTgz, 'package/scripts/verify-release-artifacts.mjs'], {
          timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
        });
        writeFileSync(extractedVerifier, extractedBytes);
        const extractedDigest = sha256hex(readFileSync(extractedVerifier));
        expect(extractedDigest).toBe(verifierDigest);
        expect(releaseWorkflow).toContain(`EXPECTED_SHA256='${extractedDigest}'`);

        execFileSync(process.execPath, [extractedVerifier, stageDir], {
          encoding: 'utf8',
          timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
          env: {
            ...process.env,
            GITHUB_REPOSITORY: identity.repository,
            GITHUB_SHA: identity.commit_sha,
            GITHUB_REF_NAME: identity.tag,
            PACKAGE_NAME: identity.package_name,
            PACKAGE_VERSION: identity.package_version,
          },
        });
      } finally {
        rmSync(packDir, { recursive: true, force: true });
        rmSync(stageDir, { recursive: true, force: true });
        rmSync(extractDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
