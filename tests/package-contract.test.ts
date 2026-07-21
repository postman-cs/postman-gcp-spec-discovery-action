import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

interface PackageJson {
  name: string;
  version: string;
  engines?: Record<string, string>;
  files?: string[];
  dependencies: Record<string, string>;
  bin?: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as PackageJson;
const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string }>;
};

const GCP_PINS: Record<string, string> = {
  '@actions/core': '3.0.1',
  '@postman-cse/automation-telemetry-core': '0.2.0',
  'google-auth-library': '10.9.0',
  yaml: '2.9.0'
};

describe('package contract', () => {
  it('GCP-CONTRACT-005: name, version, engine, GCP pins, and packaged files are locked', () => {
    expect(pkg.name).toBe('@postman-cse/onboarding-gcp-spec-discovery');
    expect(pkg.version).toBe('1.1.2');
    expect(pkg.engines?.node).toBe('>=24');
    expect(pkg.bin?.['postman-gcp-spec-discovery']).toBe('dist/cli.cjs');

    for (const [name, version] of Object.entries(GCP_PINS)) {
      expect(pkg.dependencies[name], `${name} must be pinned exactly`).toBe(version);
      expect(lock.packages[`node_modules/${name}`]?.version, `${name} lockfile pin`).toBe(version);
    }

    for (const entry of ['action.yml', 'dist', 'README.md', 'docs', 'SECURITY.md', 'SUPPORT.md', 'RELEASE_POLICY.md']) {
      expect(pkg.files, `files must include ${entry}`).toContain(entry);
    }
  });
});
