import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const parseExactSemver = (value) => {
  const raw = String(value ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`invalid MAJOR.MINOR.PATCH version: ${value}`);
  }
  return raw.split('.').map((part) => Number(part));
};

/** Compute npm SHA-512 SRI for a tarball path or bytes. */
export function computeNpmSri(tarballOrBytes) {
  const bytes = typeof tarballOrBytes === 'string' ? readFileSync(tarballOrBytes) : tarballOrBytes;
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** True when two npm SHA-512 SRI strings are equal after trim. */
export function npmSriEquals(expected, actual) {
  return String(expected ?? '').trim() === String(actual ?? '').trim();
}

/** Assert npm SHA-512 SRI equality; throw on mismatch. */
export function assertNpmSriMatch(expected, actual) {
  if (!npmSriEquals(expected, actual)) {
    throw new Error('published npm integrity does not match release.tgz');
  }
}

/**
 * Decide whether a rolling alias should move.
 * Equal or older current permits advance; newer current skips.
 * Versions must be strict numeric MAJOR.MINOR.PATCH.
 */
export function decideAliasVersion({ currentVersion, candidateVersion }) {
  const current = parseExactSemver(currentVersion);
  const candidate = parseExactSemver(candidateVersion);
  for (let i = 0; i < 3; i += 1) {
    if (current[i] > candidate[i]) return { action: 'skip' };
    if (current[i] < candidate[i]) return { action: 'advance' };
  }
  return { action: 'advance' };
}

export function validateManifest(manifest, expected) {
  if (!manifest || manifest.schema_version !== 1) throw new Error('schema_version must be 1');
  for (const [manifestKey, expectedKey] of Object.entries({
    repository: 'repository', commit_sha: 'commitSha', tag: 'tag', package_name: 'packageName', package_version: 'packageVersion',
  })) {
    if (manifest[manifestKey] !== expected[expectedKey]) throw new Error(`manifest ${manifestKey} does not match release identity`);
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new Error('manifest artifacts are required');
  for (const artifact of manifest.artifacts) {
    if (typeof artifact?.path !== 'string' || artifact.path === '.' || artifact.path === '..' || !/^[a-zA-Z0-9._-]+$/.test(artifact.path)) throw new Error('invalid artifact path');
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`invalid sha256 for ${artifact.path}`);
  }
  return manifest;
}

export function validateTagVersion(tag, version) {
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match package version ${version}`);
}

export function verifyReleaseArtifacts(directory, expected) {
  const manifest = validateManifest(JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8')), expected);
  const declared = new Set(manifest.artifacts.map(({ path }) => path));
  if (!declared.has('release.tgz')) throw new Error('manifest must include release.tgz');
  // Enforce the exact staged-file allowlist: only the manifest plus declared artifacts (R3).
  const allowed = new Set(['release-manifest.json', ...declared]);
  for (const entry of readdirSync(directory)) {
    if (!allowed.has(entry)) throw new Error(`unexpected staged file: ${entry}`);
  }
  for (const artifact of manifest.artifacts) {
    const path = join(directory, artifact.path);
    if (!existsSync(path)) throw new Error(`missing artifact ${artifact.path}`);
    if (sha256(path) !== artifact.sha256) throw new Error(`checksum mismatch for ${artifact.path}`);
  }
  const packageJson = JSON.parse(execFileSync('tar', ['-xOf', join(directory, 'release.tgz'), 'package/package.json'], { encoding: 'utf8' }));
  if (packageJson.name !== expected.packageName || packageJson.version !== expected.packageVersion) {
    throw new Error('tarball package identity does not match manifest');
  }
  validateTagVersion(expected.tag, packageJson.version);
  return manifest;
}

function runCli(argv) {
  if (argv[0] === '--check-npm-sri') {
    const [, tarball, expectedSri] = argv;
    if (!tarball || expectedSri === undefined) {
      throw new Error('usage: node scripts/verify-release-artifacts.mjs --check-npm-sri <tarball> <expectedSri>');
    }
    assertNpmSriMatch(expectedSri, computeNpmSri(tarball));
    return;
  }
  if (argv[0] === '--alias-decision') {
    const [, currentVersion, candidateVersion] = argv;
    if (!currentVersion || !candidateVersion) {
      throw new Error('usage: node scripts/verify-release-artifacts.mjs --alias-decision <current> <candidate>');
    }
    const decision = decideAliasVersion({ currentVersion, candidateVersion });
    process.stdout.write(`${decision.action}\n`);
    return;
  }

  verifyReleaseArtifacts(argv[0] ?? '.', {
    repository: process.env.GITHUB_REPOSITORY,
    commitSha: process.env.GITHUB_SHA,
    tag: process.env.GITHUB_REF_NAME,
    packageName: process.env.PACKAGE_NAME,
    packageVersion: process.env.PACKAGE_VERSION,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
