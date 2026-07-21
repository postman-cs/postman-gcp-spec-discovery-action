import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDefinitionFileInventory,
  serializeDefinitionFileInventory,
  sha256Hex,
  stageAndSwapServiceDirectory
} from '../src/lib/spec/definition-file-inventory.js';
import { buildExecutionOutputs } from '../src/runtime.js';
import { toDotenv } from '../src/cli.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gcp-inventory-'));
  tempDirs.push(dir);
  return dir;
}

describe('definition file inventory (R2 schema)', () => {
  it('output/CLI schema emits sorted workspace-relative inventory without embedded content', () => {
    const rootContent = 'syntax = "proto3";\nimport "types.proto";\nservice A { rpc X(M) returns (M); }\nmessage M {}\n';
    const typesContent = 'syntax = "proto3";\nmessage Money { int64 units = 1; }\n';
    const inventory = buildDefinitionFileInventory({
      root: 'discovered-specs/payments/service.proto',
      format: 'protobuf',
      completeness: 'full',
      members: [
        { path: 'discovered-specs/payments/types.proto', role: 'dependency', content: typesContent },
        { path: 'discovered-specs/payments/service.proto', role: 'root', content: rootContent }
      ]
    });

    expect(inventory).toEqual({
      schemaVersion: 1,
      root: 'discovered-specs/payments/service.proto',
      format: 'protobuf',
      completeness: 'full',
      provenance: { kind: 'provider', provider: 'gcp' },
      files: [
        {
          path: 'discovered-specs/payments/service.proto',
          role: 'root',
          bytes: Buffer.byteLength(rootContent, 'utf8'),
          sha256: sha256Hex(rootContent)
        },
        {
          path: 'discovered-specs/payments/types.proto',
          role: 'dependency',
          bytes: Buffer.byteLength(typesContent, 'utf8'),
          sha256: sha256Hex(typesContent)
        }
      ]
    });

    const serialized = serializeDefinitionFileInventory(inventory);
    expect(serialized.includes('\n')).toBe(false);
    expect(serialized).not.toContain(rootContent);
    expect(serialized).not.toContain('content');

    const outputs = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        status: 'resolved',
        sourceType: 'api-gateway-config',
        serviceName: 'payments',
        confidence: 100,
        specPath: 'discovered-specs/payments/service.proto',
        specFilesJson: serialized,
        providerType: 'api-gateway',
        specFormat: 'protobuf',
        evidence: []
      }
    });
    expect(Object.keys(outputs).indexOf('spec-files-json')).toBe(Object.keys(outputs).indexOf('spec-path') + 1);
    expect(outputs['spec-files-json']).toBe(serialized);

    const dotenv = toDotenv(outputs);
    expect(dotenv).toContain('POSTMAN_GCP_SPEC_FILES_JSON=');
    expect(dotenv.indexOf('POSTMAN_GCP_SPEC_PATH=')).toBeLessThan(dotenv.indexOf('POSTMAN_GCP_SPEC_FILES_JSON='));

    const empty = buildExecutionOutputs({
      mode: 'discover-many',
      discovered: [
        {
          serviceName: 'payments',
          specPath: 'discovered-specs/payments/service.proto',
          providerType: 'api-gateway',
          authority: 'stored-authoritative',
          specFormat: 'protobuf'
        }
      ],
      exportSummary: { attempted: 1, exported: 1, failed: 0, skipped: 0 }
    });
    expect(empty['spec-files-json']).toBe('');
  });

  it('rejects case-only, NFC/NFD, and exact path collisions; allows distinct directory basenames', () => {
    const rootContent = 'syntax = "proto3";\nservice A { rpc X(M) returns (M); }\nmessage M {}\n';
    const depContent = 'syntax = "proto3";\nmessage Money {}\n';

    expect(() =>
      buildDefinitionFileInventory({
        root: 'discovered-specs/payments/Service.proto',
        format: 'protobuf',
        completeness: 'full',
        members: [
          { path: 'discovered-specs/payments/Service.proto', role: 'root', content: rootContent },
          { path: 'discovered-specs/payments/service.proto', role: 'dependency', content: depContent }
        ]
      })
    ).toThrow(/NFC\/case-fold/i);

    const nfc = 'discovered-specs/payments/caf\u00e9.proto';
    const nfd = 'discovered-specs/payments/cafe\u0301.proto';
    expect(() =>
      buildDefinitionFileInventory({
        root: nfc,
        format: 'protobuf',
        completeness: 'full',
        members: [
          { path: nfc, role: 'root', content: rootContent },
          { path: nfd, role: 'dependency', content: depContent }
        ]
      })
    ).toThrow(/NFC\/case-fold/i);

    expect(() =>
      buildDefinitionFileInventory({
        root: 'discovered-specs/payments/service.proto',
        format: 'protobuf',
        completeness: 'full',
        members: [
          { path: 'discovered-specs/payments/service.proto', role: 'root', content: rootContent },
          { path: 'discovered-specs/payments/service.proto', role: 'dependency', content: depContent }
        ]
      })
    ).toThrow(/NFC\/case-fold/i);

    const inventory = buildDefinitionFileInventory({
      root: 'discovered-specs/payments/svc/service.proto',
      format: 'protobuf',
      completeness: 'full',
      members: [
        {
          path: 'discovered-specs/payments/svc/service.proto',
          role: 'root',
          content: rootContent
        },
        {
          path: 'discovered-specs/payments/shared/types.proto',
          role: 'dependency',
          content: depContent
        },
        {
          path: 'discovered-specs/payments/other/types.proto',
          role: 'dependency',
          content: depContent
        }
      ]
    });
    expect(inventory.files.map((file) => file.path)).toEqual([
      'discovered-specs/payments/other/types.proto',
      'discovered-specs/payments/shared/types.proto',
      'discovered-specs/payments/svc/service.proto'
    ]);
  });

  it('keeps blank unresolved/manual inventory outputs', () => {
    const unresolved = buildExecutionOutputs({
      mode: 'resolve-one',
      discovered: [],
      resolution: {
        status: 'unresolved',
        sourceType: 'manual-review',
        serviceName: 'unknown-service',
        confidence: 0,
        evidence: ['ambiguous candidates']
      }
    });
    expect(unresolved['spec-files-json']).toBe('');
    expect(unresolved['spec-path']).toBe('');
  });
});

describe('staged service directory replacement (R4)', () => {
  it('refuses to stage NFC/case-fold colliding owned members', async () => {
    const repoRoot = await makeTemp();
    await expect(
      stageAndSwapServiceDirectory({
        repoRoot,
        serviceDirRelative: 'discovered-specs/payments',
        runId: 'collide',
        members: [
          {
            relativePath: 'Service.proto',
            content: 'syntax = "proto3";\nservice A { rpc X(M) returns (M); }\nmessage M {}\n'
          },
          {
            relativePath: 'service.proto',
            content: 'syntax = "proto3";\nmessage Money {}\n'
          }
        ]
      })
    ).rejects.toThrow(/NFC\/case-fold/i);
  });

  it('staging failure preserves prior tree', async () => {
    const repoRoot = await makeTemp();
    const serviceRel = 'discovered-specs/payments';
    const serviceAbs = path.join(repoRoot, ...serviceRel.split('/'));
    await mkdir(serviceAbs, { recursive: true });
    const priorRoot = 'syntax = "proto3";\nservice Prior { rpc X(M) returns (M); }\nmessage M {}\n';
    const priorDep = 'syntax = "proto3";\nmessage PriorDep {}\n';
    const sidecar = '{"derived":true}\n';
    await writeFile(path.join(serviceAbs, 'service.proto'), priorRoot, 'utf8');
    await writeFile(path.join(serviceAbs, 'types.proto'), priorDep, 'utf8');
    await writeFile(path.join(serviceAbs, 'openapi.derived.json'), sidecar, 'utf8');

    await expect(
      stageAndSwapServiceDirectory({
        repoRoot,
        serviceDirRelative: serviceRel,
        runId: 'failtest',
        members: [
          { relativePath: 'service.proto', content: 'syntax = "proto3";\nimport "a.proto";\nimport "b.proto";\nservice N { rpc X(M) returns (M); }\nmessage M {}\n' },
          { relativePath: 'a.proto', content: 'syntax = "proto3";\nmessage A {}\n' },
          { relativePath: 'b.proto', content: 'syntax = "proto3";\nmessage B {}\n' }
        ],
        beforeWriteMember: (index) => {
          if (index === 1) throw new Error('injected staging failure on member 2 of 3');
        }
      })
    ).rejects.toThrow(/injected staging failure/);

    expect(await readFile(path.join(serviceAbs, 'service.proto'), 'utf8')).toBe(priorRoot);
    expect(await readFile(path.join(serviceAbs, 'types.proto'), 'utf8')).toBe(priorDep);
    expect(await readFile(path.join(serviceAbs, 'openapi.derived.json'), 'utf8')).toBe(sidecar);
  });

  it('stale member removed and sidecars preserved on success', async () => {
    const repoRoot = await makeTemp();
    const serviceRel = 'discovered-specs/payments';
    const serviceAbs = path.join(repoRoot, ...serviceRel.split('/'));
    await mkdir(serviceAbs, { recursive: true });
    await writeFile(path.join(serviceAbs, 'service.proto'), 'old-root\n', 'utf8');
    await writeFile(path.join(serviceAbs, 'types.proto'), 'old-types\n', 'utf8');
    await writeFile(path.join(serviceAbs, 'stale.proto'), 'stale\n', 'utf8');
    await writeFile(path.join(serviceAbs, 'openapi.derived.json'), '{"keep":true}\n', 'utf8');

    const root = 'syntax = "proto3";\nimport "types.proto";\nservice A { rpc X(M) returns (M); }\nmessage M {}\n';
    const types = 'syntax = "proto3";\nmessage Money {}\n';
    await stageAndSwapServiceDirectory({
      repoRoot,
      serviceDirRelative: serviceRel,
      runId: 'oktest',
      members: [
        { relativePath: 'service.proto', content: root },
        { relativePath: 'types.proto', content: types }
      ]
    });

    expect(await readFile(path.join(serviceAbs, 'service.proto'), 'utf8')).toBe(root);
    expect(await readFile(path.join(serviceAbs, 'types.proto'), 'utf8')).toBe(types);
    await expect(readFile(path.join(serviceAbs, 'stale.proto'), 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(serviceAbs, 'openapi.derived.json'), 'utf8')).toBe('{"keep":true}\n');
    expect(createHash('sha256').update(root, 'utf8').digest('hex')).toBe(sha256Hex(root));
  });

  it('post-swap canonical validation failure restores backup and leaves no residue', async () => {
    const repoRoot = await makeTemp();
    const serviceRel = 'discovered-specs/payments';
    const serviceAbs = path.join(repoRoot, ...serviceRel.split('/'));
    await mkdir(serviceAbs, { recursive: true });
    const priorRoot = 'syntax = "proto3";\nservice Prior { rpc X(M) returns (M); }\nmessage M {}\n';
    const priorDep = 'syntax = "proto3";\nmessage PriorDep {}\n';
    const sidecar = '{"derived":true}\n';
    await writeFile(path.join(serviceAbs, 'service.proto'), priorRoot, 'utf8');
    await writeFile(path.join(serviceAbs, 'types.proto'), priorDep, 'utf8');
    await writeFile(path.join(serviceAbs, 'openapi.derived.json'), sidecar, 'utf8');

    const newRoot =
      'syntax = "proto3";\nimport "types.proto";\nservice Next { rpc X(M) returns (M); }\nmessage M {}\n';
    const newTypes = 'syntax = "proto3";\nmessage NextDep {}\n';

    await expect(
      stageAndSwapServiceDirectory({
        repoRoot,
        serviceDirRelative: serviceRel,
        runId: 'postswap-fail',
        members: [
          { relativePath: 'service.proto', content: newRoot },
          { relativePath: 'types.proto', content: newTypes }
        ],
        afterCanonicalSwap: async () => {
          // Corrupt swapped canonical so post-swap byte validation fails while backup exists.
          await writeFile(path.join(serviceAbs, 'service.proto'), 'CORRUPTED-CANONICAL\n', 'utf8');
        }
      })
    ).rejects.toThrow(/byte mismatch|hash mismatch/i);

    expect(await readFile(path.join(serviceAbs, 'service.proto'), 'utf8')).toBe(priorRoot);
    expect(await readFile(path.join(serviceAbs, 'types.proto'), 'utf8')).toBe(priorDep);
    expect(await readFile(path.join(serviceAbs, 'openapi.derived.json'), 'utf8')).toBe(sidecar);

    const parentEntries = await readdir(path.dirname(serviceAbs));
    expect(parentEntries.filter((name) => /\.(stage|backup)-/.test(name))).toEqual([]);
    const serviceEntries = await readdir(serviceAbs);
    expect(serviceEntries.filter((name) => /\.(stage|backup)-/.test(name))).toEqual([]);
  });
});
