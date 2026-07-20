import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanGCPIac } from '../src/lib/repo/gcp-iac-scanner.js';

/** Candidate IaC ceiling (16 MiB): one 10 MiB base64 source plus YAML envelope. */
const MAX_CANDIDATE_IAC_BYTES = 16 * 1024 * 1024;
/** Referenced raw OpenAPI ceiling (10 MiB). */
const MAX_REFERENCED_OPENAPI_BYTES = 10 * 1024 * 1024;

function inlineTerraform(name: string): string {
  return `resource "google_endpoints_service" "${name}" {\n  service_name = "${name}.example.com"\n  openapi_config = <<EOF\nswagger: "2.0"\ninfo:\n  title: ${name}\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\nEOF\n}\n`;
}

/** Sparse oversized file via truncate — avoids allocating a huge buffer. */
async function writeSparseOversize(filePath: string, bytes: number): Promise<void> {
  await writeFile(filePath, '');
  await truncate(filePath, bytes);
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

  it('GCP-IAC-003: gateway document paths outside the repo root are rejected', async () => {
    await writeFile(
      path.join(repoRoot, 'escape.tf'),
      `resource "google_api_gateway_api_config" "escape" {
  openapi_documents {
    document {
      path = "../outside.yaml"
      contents = filebase64("../outside.yaml")
    }
  }
}
`
    );
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toEqual([]);
  });

  it('GCP-IAC-003: oversized IaC candidate files are skipped before read and yield no candidates', async () => {
    await writeFile(path.join(repoRoot, 'ok.tf'), inlineTerraform('ok'));
    await writeSparseOversize(path.join(repoRoot, 'huge.tf'), MAX_CANDIDATE_IAC_BYTES + 1);
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.scannedFiles).toEqual(expect.arrayContaining(['huge.tf', 'ok.tf']));
    expect(scan.candidates.map((candidate) => candidate.name)).toEqual(['ok']);
  });

  it('GCP-IAC-003: oversized referenced OpenAPI files are skipped before read and yield no candidates', async () => {
    await writeFile(
      path.join(repoRoot, 'gateway.tf'),
      `resource "google_api_gateway_api_config" "gateway" {
  openapi_documents {
    document {
      path = "huge-spec.yaml"
    }
  }
}
`
    );
    await writeFile(
      path.join(repoRoot, 'bounded.tf'),
      `resource "google_api_gateway_api_config" "bounded" {
  openapi_documents {
    document {
      path = "ok-spec.yaml"
    }
  }
}
`
    );
    await writeSparseOversize(path.join(repoRoot, 'huge-spec.yaml'), MAX_REFERENCED_OPENAPI_BYTES + 1);
    await writeFile(
      path.join(repoRoot, 'ok-spec.yaml'),
      'swagger: "2.0"\ninfo:\n  title: bounded\n  version: "1"\npaths:\n  /health:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    );
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates.map((candidate) => candidate.name)).toEqual(['bounded']);
    expect(scan.candidates.every((candidate) => candidate.meta?.relativePath !== 'huge-spec.yaml')).toBe(true);
  });

  it('GCP-IAC-006: Pulumi YAML aliases, merges, remote URLs, and multi-document files never yield candidates', async () => {
    const contents = Buffer.from(
      'openapi: 3.0.3\ninfo:\n  title: Payments\n  version: "1"\npaths:\n  /items:\n    get:\n      responses:\n        "200":\n          description: ok\n',
      'utf8'
    ).toString('base64');
    await writeFile(
      path.join(repoRoot, 'Pulumi.alias.yaml'),
      [
        'name: alias-stack',
        'runtime: yaml',
        `x-anchor: &doc ${contents}`,
        'resources:',
        '  viaAlias:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      openapiDocuments:',
        '        - document:',
        '            path: gateway-contract.yaml',
        '            contents: *doc',
        ''
      ].join('\n')
    );
    await writeFile(
      path.join(repoRoot, 'Pulumi.merge.yaml'),
      [
        'name: merge-stack',
        'runtime: yaml',
        'definitions:',
        '  shared: &shared',
        '    path: gateway-contract.yaml',
        `    contents: ${contents}`,
        'resources:',
        '  merged:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      openapiDocuments:',
        '        - document:',
        '            <<: *shared',
        ''
      ].join('\n')
    );
    await writeFile(
      path.join(repoRoot, 'Pulumi.remote.yaml'),
      [
        'name: remote-stack',
        'runtime: yaml',
        'resources:',
        '  remote:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      openapiDocuments:',
        '        - document:',
        '            path: https://example.com/openapi.yaml',
        '            contents: https://example.com/openapi.yaml',
        ''
      ].join('\n')
    );
    await writeFile(
      path.join(repoRoot, 'Pulumi.multidoc.yaml'),
      [
        'name: multi-doc-stack',
        'runtime: yaml',
        'resources:',
        '  first:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      openapiDocuments:',
        '        - document:',
        '            path: first.yaml',
        `            contents: ${contents}`,
        '---',
        'name: other',
        'runtime: yaml',
        'resources:',
        '  second:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      openapiDocuments:',
        '        - document:',
        '            path: second.yaml',
        `            contents: ${contents}`,
        ''
      ].join('\n')
    );
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toEqual([]);
  });
});
