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
    expect(result.resolution).toMatchObject({
      status: 'resolved',
      sourceType: 'iac-embedded',
      confidence: 100,
      authority: 'stored-authoritative'
    });
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

  it('GCP-IAC-005: unrelated path attributes never become OpenAPI candidates', async () => {
    await writeFile(path.join(repoRoot, 'unrelated-valid.yaml'), OPENAPI.replace('Payments', 'Unrelated'));
    await writeFile(path.join(repoRoot, 'gateway-contract.yaml'), OPENAPI);
    await writeFile(
      path.join(repoRoot, 'main.tf'),
      `resource "google_api_gateway_api_config" "payments" {
  api = "payments"
  project = "sample-project-123"
  grpc_services {
    file_descriptor_set {
      path = "unrelated-valid.yaml"
      contents = filebase64("unrelated-valid.yaml")
    }
  }
  openapi_documents {
    document {
      path = "gateway-contract.yaml"
      contents = filebase64("gateway-contract.yaml")
    }
  }
}
`
    );
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates.map((candidate) => candidate.meta?.relativePath)).toEqual(['gateway-contract.yaml']);
  });

  it('GCP-IAC-005: multiple openapi_documents blocks and nested document path fields are extracted', async () => {
    await writeFile(path.join(repoRoot, 'alpha-contract.yaml'), OPENAPI.replace('Payments', 'Alpha'));
    await writeFile(path.join(repoRoot, 'bravo-contract.yaml'), OPENAPI.replace('Payments', 'Bravo'));
    await writeFile(
      path.join(repoRoot, 'main.tf'),
      `resource "google_api_gateway_api_config" "multi" {
  api = "multi"
  project = "sample-project-123"
  openapi_documents {
    document {
      path = "alpha-contract.yaml"
      contents = filebase64("alpha-contract.yaml")
    }
  }
  openapi_documents {
    document {
      path = "bravo-contract.yaml"
      contents = filebase64("bravo-contract.yaml")
    }
  }
}
`
    );
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates.map((candidate) => candidate.meta?.relativePath).sort()).toEqual([
      'alpha-contract.yaml',
      'bravo-contract.yaml'
    ]);
  });

  it('GCP-IAC-005: braces inside comments and strings do not create false path candidates', async () => {
    await writeFile(path.join(repoRoot, 'gateway-contract.yaml'), OPENAPI);
    await writeFile(path.join(repoRoot, 'decoy.yaml'), OPENAPI.replace('Payments', 'Decoy'));
    await writeFile(
      path.join(repoRoot, 'main.tf'),
      `resource "google_api_gateway_api_config" "payments" {
  api = "payments"
  project = "sample-project-123"
  # openapi_documents { document { path = "decoy.yaml" } }
  labels = {
    note = "openapi_documents { document { path = \\"decoy.yaml\\" } }"
  }
  openapi_documents {
    document {
      path = "gateway-contract.yaml"
      # path = "decoy.yaml"
      contents = filebase64("gateway-contract.yaml")
    }
  }
}
`
    );
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates.map((candidate) => candidate.meta?.relativePath)).toEqual(['gateway-contract.yaml']);
  });

  it('GCP-IAC-006: one literal Pulumi YAML ApiConfig resolves locally with confidence 100', async () => {
    const contents = Buffer.from(OPENAPI, 'utf8').toString('base64');
    await writeFile(
      path.join(repoRoot, 'Pulumi.yaml'),
      [
        'name: payments-stack',
        'runtime: yaml',
        'resources:',
        '  paymentsConfig:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      api: payments',
        '      project: sample-project-123',
        '      openapiDocuments:',
        '        - document:',
        '            path: gateway-contract.yaml',
        `            contents: ${contents}`,
        ''
      ].join('\n')
    );
    const writeSpecFile = vi.fn<GCPDependencies['writeSpecFile']>(async () => undefined);
    const result = await execute(
      resolveInputs({ INPUT_PROJECT_ID: 'sample-project-123', INPUT_REPO_ROOT: repoRoot }),
      dependencies(writeSpecFile)
    );
    expect(result.resolution).toMatchObject({
      status: 'resolved',
      sourceType: 'iac-embedded',
      confidence: 100,
      authority: 'stored-authoritative'
    });
    expect(writeSpecFile).toHaveBeenCalledTimes(2);
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]?.id).toBe('Pulumi.yaml#gcp:apigateway:ApiConfig.paymentsConfig:openapiDocuments/0');
    expect(scan.fingerprint).toMatchObject({
      projectIds: ['sample-project-123'],
      serviceNames: expect.arrayContaining(['payments', 'paymentsConfig']),
      resourceIds: ['Pulumi.yaml#gcp:apigateway:ApiConfig.paymentsConfig:openapiDocuments/0']
    });
  });

  it('GCP-IAC-006: multiple literal Pulumi OpenAPI documents remain manual-review', async () => {
    const alpha = Buffer.from(OPENAPI.replace('Payments', 'Alpha'), 'utf8').toString('base64');
    const bravo = Buffer.from(OPENAPI.replace('Payments', 'Bravo'), 'utf8').toString('base64');
    await writeFile(
      path.join(repoRoot, 'Pulumi.yaml'),
      [
        'name: multi-stack',
        'runtime: yaml',
        'resources:',
        '  alphaConfig:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      api: alpha',
        '      openapiDocuments:',
        '        - document:',
        '            path: alpha.yaml',
        `            contents: ${alpha}`,
        '  bravoConfig:',
        '    type: google-native:apigateway/v1:Config',
        '    properties:',
        '      apiId: bravo',
        '      openapiDocuments:',
        '        - document:',
        '            path: bravo.yaml',
        `            contents: ${bravo}`,
        ''
      ].join('\n')
    );
    const writeSpecFile = vi.fn<GCPDependencies['writeSpecFile']>(async () => undefined);
    const result = await execute(
      resolveInputs({ INPUT_PROJECT_ID: 'sample-project-123', INPUT_REPO_ROOT: repoRoot }),
      dependencies(writeSpecFile)
    );
    expect(result.resolution).toMatchObject({ status: 'unresolved', sourceType: 'manual-review' });
    expect(result.resolution?.rankedCandidates).toHaveLength(2);
    expect(writeSpecFile).not.toHaveBeenCalled();
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates.map((candidate) => candidate.id).sort()).toEqual([
      'Pulumi.yaml#gcp:apigateway:ApiConfig.alphaConfig:openapiDocuments/0',
      'Pulumi.yaml#google-native:apigateway/v1:Config.bravoConfig:openapiDocuments/0'
    ]);
  });

  it('GCP-IAC-006: interpolation, fn::, wrong runtime, wrong type, and fictional Config Connector are ignored', async () => {
    const contents = Buffer.from(OPENAPI, 'utf8').toString('base64');
    await writeFile(
      path.join(repoRoot, 'Pulumi.yaml'),
      [
        'name: unsafe-stack',
        'runtime: nodejs',
        'resources:',
        '  ignoredRuntime:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      openapiDocuments:',
        '        - document:',
        '            path: gateway-contract.yaml',
        `            contents: ${contents}`,
        ''
      ].join('\n')
    );
    await writeFile(
      path.join(repoRoot, 'Pulumi.interp.yaml'),
      [
        'name: interp-stack',
        'runtime: yaml',
        'resources:',
        '  interpolated:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      api: ${payments-api.id}',
        '      openapiDocuments:',
        '        - document:',
        '            path: gateway-contract.yaml',
        '            contents: ${openapi_b64}',
        '  withFn:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      openapiDocuments:',
        '        - document:',
        '            path: gateway-contract.yaml',
        '            contents:',
        '              fn::fileAsset: ./gateway-contract.yaml',
        '  wrongType:',
        '    type: gcp:apigateway:Api',
        '    properties:',
        '      apiId: payments',
        '      openapiDocuments:',
        '        - document:',
        '            path: gateway-contract.yaml',
        `            contents: ${contents}`,
        '  pathOnly:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      openapiDocuments:',
        '        - document:',
        '            path: gateway-contract.yaml',
        ''
      ].join('\n')
    );
    await writeFile(
      path.join(repoRoot, 'config-connector-apiconfig.yaml'),
      [
        'apiVersion: apigateway.cnrm.cloud.google.com/v1beta1',
        'kind: APIGatewayAPIConfig',
        'metadata:',
        '  name: payments',
        'spec:',
        '  projectRef:',
        '    external: sample-project-123',
        '  apiRef:',
        '    name: payments',
        '  openapiDocuments:',
        '    - document:',
        '        path: gateway-contract.yaml',
        `        contents: ${contents}`,
        ''
      ].join('\n')
    );
    await writeFile(path.join(repoRoot, 'gateway-contract.yaml'), OPENAPI);
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toEqual([]);
  });

  it('GCP-IAC-006: malformed and oversize Pulumi base64 contents are ignored with safe evidence', async () => {
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    await writeFile(
      path.join(repoRoot, 'Pulumi.yaml'),
      [
        'name: bad-stack',
        'runtime: yaml',
        'resources:',
        '  malformed:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      api: malformed',
        '      project: sample-project-123',
        '      openapiDocuments:',
        '        - document:',
        '            path: bad.yaml',
        '            contents: not!!!base64',
        '  oversized:',
        '    type: gcp:apigateway:ApiConfig',
        '    properties:',
        '      api: oversized',
        '      openapiDocuments:',
        '        - document:',
        '            path: huge.yaml',
        `            contents: ${oversize}`,
        ''
      ].join('\n')
    );
    const scan = await scanGCPIac(repoRoot, 'discovered-specs');
    expect(scan.candidates).toEqual([]);
    expect(scan.fingerprint.evidence.some((entry) => entry.includes('not valid base64') || entry.includes('exceeds'))).toBe(true);
    expect(JSON.stringify(scan.fingerprint.evidence)).not.toContain(oversize.slice(0, 64));
    expect(scan.fingerprint.projectIds).toEqual(['sample-project-123']);
    expect(scan.fingerprint.serviceNames).toEqual(expect.arrayContaining(['malformed', 'oversized']));
  });
});
