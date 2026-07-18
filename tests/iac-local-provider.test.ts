import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';
import { scanGCPIac } from '../src/lib/repo/gcp-iac-scanner.js';
import { execute, resolveInputs, type GCPDependencies, type ReporterLike } from '../src/runtime.js';

const OPENAPI = 'openapi: 3.0.3\ninfo:\n  title: Payments\n  version: "1"\npaths:\n  /items:\n    get:\n      responses:\n        "200":\n          description: ok\n';

function gatewayTerraform(name: string, specPath: string): string {
  return `resource "google_api_gateway_api_config" "${name}" {\n  api = "${name}"\n  project = "sample-project-123"\n  openapi_documents {\n    document {\n      path = "${specPath}"\n      contents = filebase64("${specPath}")\n    }\n  }\n}\n`;
}

const reporter: ReporterLike = { group: async (_name, fn) => fn(), info: () => undefined, warning: () => undefined };

function forbiddenCloudClient(): GcpDiscoveryClient {
  return new Proxy({}, { get: () => vi.fn(async () => { throw new Error('local IaC must not call GCP'); }) }) as GcpDiscoveryClient;
}

describe('local GCP IaC resolution', () => {
  let repoRoot: string;

  beforeEach(async () => { repoRoot = await mkdtemp(path.join(tmpdir(), 'gcp-iac-provider-')); });
  afterEach(async () => { await rm(repoRoot, { recursive: true, force: true }); });

  function dependencies(writeSpecFile: GCPDependencies['writeSpecFile']): GCPDependencies {
    return { core: reporter, client: forbiddenCloudClient(), writeSpecFile };
  }

  it('GCP-IAC-001/GCP-IAC-002: one literal Terraform reference resolves locally with confidence 100', async () => {
    await writeFile(path.join(repoRoot, 'gateway-contract.yaml'), OPENAPI);
    await writeFile(path.join(repoRoot, 'main.tf'), gatewayTerraform('payments', 'gateway-contract.yaml'));
    const writeSpecFile = vi.fn<GCPDependencies['writeSpecFile']>(async () => undefined);
    const result = await execute(
      resolveInputs({ INPUT_PROJECT_ID: 'sample-project-123', INPUT_REPO_ROOT: repoRoot }),
      dependencies(writeSpecFile)
    );
    expect(result.resolution).toMatchObject({ status: 'resolved', sourceType: 'iac-embedded', confidence: 100 });
    // Two writes: the preserved YAML source document plus the derived OpenAPI JSON.
    expect(writeSpecFile).toHaveBeenCalledTimes(2);
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.fingerprint).toMatchObject({ projectIds: ['sample-project-123'], serviceNames: ['payments'] });
  });

  it('GCP-IAC-002: multiple referenced documents remain manual-review and write nothing', async () => {
    await writeFile(path.join(repoRoot, 'alpha-contract.yaml'), OPENAPI.replace('Payments', 'Alpha'));
    await writeFile(path.join(repoRoot, 'bravo-contract.yaml'), OPENAPI.replace('Payments', 'Bravo'));
    await writeFile(path.join(repoRoot, 'alpha.tf'), gatewayTerraform('alpha', 'alpha-contract.yaml'));
    await writeFile(path.join(repoRoot, 'bravo.tf'), gatewayTerraform('bravo', 'bravo-contract.yaml'));
    const writeSpecFile = vi.fn<GCPDependencies['writeSpecFile']>(async () => undefined);
    const result = await execute(
      resolveInputs({ INPUT_PROJECT_ID: 'sample-project-123', INPUT_REPO_ROOT: repoRoot }),
      dependencies(writeSpecFile)
    );
    expect(result.resolution).toMatchObject({ status: 'unresolved', sourceType: 'manual-review' });
    expect(result.resolution?.rankedCandidates).toHaveLength(2);
    expect(writeSpecFile).not.toHaveBeenCalled();
  });

  it('GCP-IAC-004: nonliteral, URL, and provisioner-like expressions are never fetched or executed', async () => {
    await writeFile(path.join(repoRoot, 'unsafe.tf'), `resource "google_api_gateway_api_config" "unsafe" {\n  openapi_documents { document { path = var.spec_path } }\n  provisioner "local-exec" { command = "curl https://example.com/openapi.yaml" }\n}\nresource "google_endpoints_service" "remote" { openapi_config = file("https://example.com/openapi.yaml") }\n`);
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toEqual([]);
  });
});
