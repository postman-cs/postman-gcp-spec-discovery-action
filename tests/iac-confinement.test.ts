import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanGCPIac } from '../src/lib/repo/gcp-iac-scanner.js';

function inlineTerraform(name: string): string {
  return `resource "google_endpoints_service" "${name}" {\n  service_name = "${name}.example.com"\n  openapi_config = <<EOF\nswagger: "2.0"\ninfo:\n  title: ${name}\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\nEOF\n}\n`;
}

describe('GCP IaC scan confinement', () => {
  let repoRoot: string;
  beforeEach(async () => { repoRoot = await mkdtemp(path.join(tmpdir(), 'gcp-iac-confinement-')); });
  afterEach(async () => { await rm(repoRoot, { recursive: true, force: true }); });

  it('GCP-IAC-003: scans at most 200 candidate files in stable lexical order', async () => {
    await Promise.all(Array.from({ length: 205 }, async (_, index) => {
      const name = `api-${String(index).padStart(3, '0')}`;
      await writeFile(path.join(repoRoot, `${name}.tf`), inlineTerraform(name));
    }));
    const first = await scanGCPIac(repoRoot, 'discovered-specs');
    const second = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(first.scannedFiles).toHaveLength(200);
    expect(first.candidates).toHaveLength(200);
    expect(first.scannedFiles).toEqual(second.scannedFiles);
    expect(first.scannedFiles[0]).toBe('api-000.tf');
    expect(first.scannedFiles.at(-1)).toBe('api-199.tf');
  });

  it('GCP-IAC-003: depth 6 is included while depth 7, ignored/output dirs, and symlinks are excluded', async () => {
    const depth6 = path.join(repoRoot, 'd1/d2/d3/d4/d5/d6');
    const depth7 = path.join(depth6, 'd7');
    await mkdir(depth7, { recursive: true });
    await writeFile(path.join(depth6, 'included.tf'), inlineTerraform('included'));
    await writeFile(path.join(depth7, 'too-deep.tf'), inlineTerraform('too-deep'));
    for (const directory of ['node_modules', '.git', 'dist', 'discovered-specs']) {
      await mkdir(path.join(repoRoot, directory), { recursive: true });
      await writeFile(path.join(repoRoot, directory, 'ignored.tf'), inlineTerraform(directory.replace('.', 'x')));
    }
    const outside = await mkdtemp(path.join(tmpdir(), 'gcp-iac-outside-'));
    try {
      await writeFile(path.join(outside, 'outside.tf'), inlineTerraform('outside'));
      await symlink(path.join(outside, 'outside.tf'), path.join(repoRoot, 'outside-link.tf'));
      const result = await scanGCPIac(repoRoot, 'discovered-specs');
      expect(result.candidates.map((candidate) => candidate.name)).toEqual(['included']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
