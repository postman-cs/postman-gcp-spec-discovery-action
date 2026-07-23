import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyReleaseArtifacts(process.argv[2] ?? '.', {
    repository: process.env.GITHUB_REPOSITORY,
    commitSha: process.env.GITHUB_SHA,
    tag: process.env.GITHUB_REF_NAME,
    packageName: process.env.PACKAGE_NAME,
    packageVersion: process.env.PACKAGE_VERSION,
  });
}
