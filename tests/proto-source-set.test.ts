import { describe, expect, it } from 'vitest';

import {
  extractProtoImports,
  normalizeProtoSourcePath,
  PROTO_SOURCE_SET_LIMITS,
  resolveProtoSourceSet,
  resolveProtoSourceSetLimits,
  type ProtoSourceFileInput,
  type ProtoSourceSetResolution
} from '../src/lib/spec/proto-source-set.js';

function b64(text: string): string {
  return Buffer.from(text).toString('base64');
}

const SERVICE_PROTO = [
  'syntax = "proto3";',
  'package payments.v1;',
  'service Payments {',
  '  rpc GetPayment(GetPaymentRequest) returns (Payment);',
  '}',
  'message GetPaymentRequest { string id = 1; }',
  'message Payment { string id = 1; }',
  ''
].join('\n');

const MESSAGE_ONLY = 'syntax = "proto3";\nmessage Money { int64 units = 1; }\n';

function expectUnsupportedManual(resolved: ProtoSourceSetResolution): void {
  expect(resolved.status).toBe('unsupported');
  if (resolved.status !== 'unsupported') return;
  expect(resolved.authority).toMatch(/unsupported-format|metadata-only/);
  expect(resolved).not.toHaveProperty('export');
  expect(JSON.stringify(resolved)).not.toMatch(/"completeness"\s*:\s*"full"/);
  expect(JSON.stringify(resolved)).not.toMatch(/"status"\s*:\s*"exportable"/);
}

function messageOnly(name: string): string {
  return `syntax = "proto3";\nmessage ${name} { string id = 1; }\n`;
}

function chainInputs(hops: number): ProtoSourceFileInput[] {
  const inputs: ProtoSourceFileInput[] = [];
  const rootImports = hops >= 1 ? 'import "d1.proto";\n' : '';
  inputs.push({
    path: 'service.proto',
    contentsBase64: b64(`syntax = "proto3";\n${rootImports}${SERVICE_PROTO}`)
  });
  for (let i = 1; i <= hops; i += 1) {
    const next = i < hops ? `import "d${i + 1}.proto";\n` : '';
    inputs.push({
      path: `d${i}.proto`,
      contentsBase64: b64(`syntax = "proto3";\n${next}${messageOnly(`D${i}`)}`)
    });
  }
  return inputs;
}

describe('proto source set resolution', () => {
  it('exports exactly one service/rpc-bearing entrypoint with exact bytes and canonical evidence', () => {
    const exact = `${SERVICE_PROTO}\r\n\r\n`;
    const resolved = resolveProtoSourceSet([
      { path: 'api/payments.proto', contentsBase64: b64(exact) },
      { path: 'api/money.proto', contentsBase64: b64(MESSAGE_ONLY) }
    ]);
    expect(resolved.status).toBe('exportable');
    if (resolved.status !== 'exportable') return;
    expect(resolved.export.content).toBe(exact);
    expect(resolved.export.originalPath).toBe('api/payments.proto');
    expect(resolved.export.members).toHaveLength(1);
    expect(resolved.export.evidence.join(' ')).toContain('ignored non-imported sources');
  });

  it('exports a complete sibling-import proto set', () => {
    const types = MESSAGE_ONLY;
    const root = `syntax = "proto3";\nimport "types.proto";\n${SERVICE_PROTO}`;
    const resolved = resolveProtoSourceSet([
      { path: 'service.proto', contentsBase64: b64(root) },
      { path: 'types.proto', contentsBase64: b64(types) }
    ]);
    expect(resolved.status).toBe('exportable');
    if (resolved.status !== 'exportable') return;
    expect(resolved.export.completeness).toBe('full');
    expect(resolved.export.rootPath).toBe('service.proto');
    expect(resolved.export.content).toBe(root);
    expect(resolved.export.members).toEqual([
      {
        content: root,
        originalPath: 'service.proto',
        normalizedPath: 'service.proto',
        role: 'root'
      },
      {
        content: types,
        originalPath: 'types.proto',
        normalizedPath: 'types.proto',
        role: 'dependency'
      }
    ]);
    expect(resolved.export.evidence.join(' ')).not.toContain('bootstrap cannot load proto closure');
  });

  it('rejects basename/suffix guesses: service.proto import types.proto with only other/types.proto is unresolved', () => {
    const types = MESSAGE_ONLY;
    const root = `syntax = "proto3";\nimport "types.proto";\n${SERVICE_PROTO}`;
    const resolved = resolveProtoSourceSet([
      { path: 'service.proto', contentsBase64: b64(root) },
      { path: 'other/types.proto', contentsBase64: b64(types) }
    ]);
    expect(resolved.status).toBe('unsupported');
    if (resolved.status !== 'unsupported') return;
    expect(resolved.authority).toBe('unsupported-format');
    expect(resolved.evidence.join(' ')).toContain('unresolved local import');
    expect(resolved.evidence.join(' ')).toContain('types.proto');
    expect(resolved).not.toHaveProperty('export');
    expect(JSON.stringify(resolved)).not.toMatch(/"completeness"\s*:\s*"full"/);
  });

  it('rejects message-only, descriptor-only, multi-entrypoint, and missing imports', () => {
    expect(
      resolveProtoSourceSet([{ path: 'types.proto', contentsBase64: b64(MESSAGE_ONLY) }])
    ).toMatchObject({
      status: 'unsupported',
      authority: 'unsupported-format'
    });

    const descriptorOnly = resolveProtoSourceSet([], { descriptorOnly: true });
    expect(descriptorOnly).toMatchObject({
      status: 'unsupported',
      authority: 'unsupported-format'
    });
    if (descriptorOnly.status === 'unsupported') {
      expect(descriptorOnly.evidence.join(' ')).toContain('descriptor');
    }

    const multi = resolveProtoSourceSet([
      { path: 'a.proto', contentsBase64: b64(SERVICE_PROTO) },
      { path: 'b.proto', contentsBase64: b64(SERVICE_PROTO.replace('Payments', 'Ledger')) }
    ]);
    expect(multi.status).toBe('unsupported');
    if (multi.status === 'unsupported') {
      expect(multi.evidence.join(' ')).toContain('2 service/rpc-bearing entrypoints');
    }

    const missing = resolveProtoSourceSet([
      {
        path: 'service.proto',
        contentsBase64: b64(`syntax = "proto3";\nimport "missing.proto";\n${SERVICE_PROTO}`)
      }
    ]);
    expect(missing.status).toBe('unsupported');
    if (missing.status === 'unsupported') {
      expect(missing.evidence.join(' ')).toContain('unresolved local import');
    }
  });

  it('allows well-known google imports and rejects unsafe/colliding paths', () => {
    const withWellKnown = resolveProtoSourceSet([
      {
        path: 'service.proto',
        contentsBase64: b64(
          'syntax = "proto3";\nimport "google/protobuf/empty.proto";\nimport "google/api/annotations.proto";\n' +
            SERVICE_PROTO
        )
      }
    ]);
    expect(withWellKnown.status).toBe('exportable');

    expect(
      resolveProtoSourceSet([{ path: '../evil.proto', contentsBase64: b64(SERVICE_PROTO) }]).status
    ).toBe('unsupported');
    expect(
      resolveProtoSourceSet([
        { path: 'api/service.proto', contentsBase64: b64(SERVICE_PROTO) },
        { path: 'api/service.proto', contentsBase64: b64(SERVICE_PROTO) }
      ]).status
    ).toBe('unsupported');
  });

  it('rejects case-only, NFC/NFD, and exact path collisions before root selection', () => {
    const caseOnly = resolveProtoSourceSet([
      { path: 'api/Service.proto', contentsBase64: b64(SERVICE_PROTO) },
      { path: 'api/service.proto', contentsBase64: b64(MESSAGE_ONLY) }
    ]);
    expect(caseOnly.status).toBe('unsupported');
    if (caseOnly.status === 'unsupported') {
      expect(caseOnly.evidence.join(' ')).toMatch(/collide/i);
    }

    const nfc = 'api/caf\u00e9.proto';
    const nfd = 'api/cafe\u0301.proto';
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));
    const unicodeFold = resolveProtoSourceSet([
      { path: nfc, contentsBase64: b64(SERVICE_PROTO) },
      { path: nfd, contentsBase64: b64(MESSAGE_ONLY) }
    ]);
    expect(unicodeFold.status).toBe('unsupported');
    if (unicodeFold.status === 'unsupported') {
      expect(unicodeFold.evidence.join(' ')).toMatch(/collide/i);
    }

    const exact = resolveProtoSourceSet([
      { path: 'api/service.proto', contentsBase64: b64(SERVICE_PROTO) },
      { path: 'api/service.proto', contentsBase64: b64(SERVICE_PROTO) }
    ]);
    expect(exact.status).toBe('unsupported');
  });

  it('accepts distinct same basenames in different directories and keeps provider paths', () => {
    const types = MESSAGE_ONLY;
    const root = `syntax = "proto3";\nimport "shared/types.proto";\n${SERVICE_PROTO}`;
    const resolved = resolveProtoSourceSet([
      { path: 'svc/service.proto', contentsBase64: b64(root) },
      { path: 'shared/types.proto', contentsBase64: b64(types) },
      { path: 'other/types.proto', contentsBase64: b64(types) }
    ]);
    expect(resolved.status).toBe('exportable');
    if (resolved.status !== 'exportable') return;
    expect(resolved.export.originalPath).toBe('svc/service.proto');
    expect(resolved.export.rootPath).toBe('svc/service.proto');
    expect(resolved.export.members.map((member) => member.originalPath)).toEqual([
      'svc/service.proto',
      'shared/types.proto'
    ]);
    expect(resolved.export.members.map((member) => member.normalizedPath)).toEqual([
      'svc/service.proto',
      'shared/types.proto'
    ]);
  });

  it('normalizes path keys and extracts import statements', () => {
    expect(normalizeProtoSourcePath('api/./x.proto')).toBeUndefined();
    expect(normalizeProtoSourcePath('api/x.proto')).toBe('api/x.proto');
    expect(normalizeProtoSourcePath('api/cafe\u0301.proto')).toBe('api/caf\u00e9.proto');
    expect(extractProtoImports('import public "a.proto";\nimport "b.proto";\n')).toEqual([
      'a.proto',
      'b.proto'
    ]);
  });
});

describe('proto source set PRD/bootstrap bounds', () => {
  it('defaults match bootstrap bundle contract and cannot be raised', () => {
    expect(PROTO_SOURCE_SET_LIMITS).toEqual({
      maxFiles: 101,
      maxDepth: 20,
      maxBytesPerFile: 25 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024
    });
    expect(resolveProtoSourceSetLimits({ maxFiles: 10_000, maxDepth: 99 })).toEqual(
      PROTO_SOURCE_SET_LIMITS
    );
    expect(resolveProtoSourceSetLimits({ maxFiles: 3, maxDepth: 2 })).toMatchObject({
      maxFiles: 3,
      maxDepth: 2
    });
  });

  it('rejects 102 provider inputs before decode as unsupported/manual', () => {
    const inputs: ProtoSourceFileInput[] = [
      { path: 'service.proto', contentsBase64: b64(SERVICE_PROTO) }
    ];
    for (let i = 0; i < 101; i += 1) {
      inputs.push({
        path: `extra${i}.proto`,
        contentsBase64: b64(messageOnly(`E${i}`))
      });
    }
    expect(inputs).toHaveLength(102);
    const resolved = resolveProtoSourceSet(inputs);
    expectUnsupportedManual(resolved);
    if (resolved.status === 'unsupported') {
      expect(resolved.evidence.join(' ')).toMatch(/maxFiles=101/);
      expect(resolved.evidence.join(' ')).toMatch(/refusing unbounded decode/i);
    }
  });

  it('allows exactly 101 files including root and rejects the 102nd unique closure member', () => {
    const importLines = Array.from({ length: 100 }, (_, i) => `import "d${i}.proto";`).join('\n');
    const atCap: ProtoSourceFileInput[] = [
      {
        path: 'service.proto',
        contentsBase64: b64(`syntax = "proto3";\n${importLines}\n${SERVICE_PROTO}`)
      }
    ];
    for (let i = 0; i < 100; i += 1) {
      atCap.push({
        path: `d${i}.proto`,
        contentsBase64: b64(messageOnly(`D${i}`))
      });
    }
    expect(atCap).toHaveLength(101);
    const atCapResolved = resolveProtoSourceSet(atCap);
    expect(atCapResolved.status).toBe('exportable');
    if (atCapResolved.status === 'exportable') {
      expect(atCapResolved.export.completeness).toBe('full');
      expect(atCapResolved.export.members).toHaveLength(101);
    }

    // Injectable lowered ceiling: exact unique-file cap is full; +1 unique is unsupported.
    const exactCap = resolveProtoSourceSet(
      [
        {
          path: 'service.proto',
          contentsBase64: b64(
            `syntax = "proto3";\nimport "a.proto";\nimport "b.proto";\n${SERVICE_PROTO}`
          )
        },
        { path: 'a.proto', contentsBase64: b64(messageOnly('A')) },
        { path: 'b.proto', contentsBase64: b64(messageOnly('B')) }
      ],
      { limits: { maxFiles: 3 } }
    );
    expect(exactCap.status).toBe('exportable');
    if (exactCap.status === 'exportable') {
      expect(exactCap.export.completeness).toBe('full');
      expect(exactCap.export.members).toHaveLength(3);
    }

    const overCap = resolveProtoSourceSet(
      [
        {
          path: 'service.proto',
          contentsBase64: b64(
            `syntax = "proto3";\nimport "a.proto";\nimport "b.proto";\nimport "c.proto";\n${SERVICE_PROTO}`
          )
        },
        { path: 'a.proto', contentsBase64: b64(messageOnly('A')) },
        { path: 'b.proto', contentsBase64: b64(messageOnly('B')) },
        { path: 'c.proto', contentsBase64: b64(messageOnly('C')) }
      ],
      { limits: { maxFiles: 3 } }
    );
    expectUnsupportedManual(overCap);
    if (overCap.status === 'unsupported') {
      expect(overCap.evidence.join(' ')).toMatch(/maxFiles=3/);
    }
  });

  it('allows depth 20 and rejects depth 21 as unsupported/manual', () => {
    const atDepth = resolveProtoSourceSet(chainInputs(20));
    expect(atDepth.status).toBe('exportable');
    if (atDepth.status === 'exportable') {
      expect(atDepth.export.completeness).toBe('full');
      expect(atDepth.export.members).toHaveLength(21);
    }

    const overDepth = resolveProtoSourceSet(chainInputs(21));
    expectUnsupportedManual(overDepth);
    if (overDepth.status === 'unsupported') {
      expect(overDepth.evidence.join(' ')).toMatch(/maxDepth=20/);
    }

    // Injectable lowered depth: exact cap full, +1 unsupported.
    const loweredAt = resolveProtoSourceSet(chainInputs(2), { limits: { maxDepth: 2 } });
    expect(loweredAt.status).toBe('exportable');
    const loweredOver = resolveProtoSourceSet(chainInputs(3), { limits: { maxDepth: 2 } });
    expectUnsupportedManual(loweredOver);
    if (loweredOver.status === 'unsupported') {
      expect(loweredOver.evidence.join(' ')).toMatch(/maxDepth=2/);
    }
  });

  it('rejects aggregate UTF-8 overage and allows exact total-byte cap', () => {
    const a = 'syntax = "proto3";\nmessage A { string id = 1; }\n';
    const root = `syntax = "proto3";\nimport "a.proto";\n${SERVICE_PROTO}`;
    const rootBytes = Buffer.byteLength(root, 'utf8');
    const aBytes = Buffer.byteLength(a, 'utf8');
    const exactTotal = rootBytes + aBytes;

    const atCap = resolveProtoSourceSet(
      [
        { path: 'service.proto', contentsBase64: b64(root) },
        { path: 'a.proto', contentsBase64: b64(a) }
      ],
      { limits: { maxTotalBytes: exactTotal } }
    );
    expect(atCap.status).toBe('exportable');
    if (atCap.status === 'exportable') {
      expect(atCap.export.completeness).toBe('full');
      expect(atCap.export.members).toHaveLength(2);
    }

    const over = resolveProtoSourceSet(
      [
        { path: 'service.proto', contentsBase64: b64(root) },
        { path: 'a.proto', contentsBase64: b64(a) }
      ],
      { limits: { maxTotalBytes: exactTotal - 1 } }
    );
    expectUnsupportedManual(over);
    if (over.status === 'unsupported') {
      expect(over.evidence.join(' ')).toMatch(/maxTotalBytes=/);
    }
  });

  it('reads circular refs once without duplicating members or false-positive limits', () => {
    const root = `syntax = "proto3";\nimport "a.proto";\n${SERVICE_PROTO}`;
    const dep = 'syntax = "proto3";\nimport "service.proto";\nmessage A { string id = 1; }\n';
    const resolved = resolveProtoSourceSet([
      { path: 'service.proto', contentsBase64: b64(root) },
      { path: 'a.proto', contentsBase64: b64(dep) }
    ]);
    expect(resolved.status).toBe('exportable');
    if (resolved.status !== 'exportable') return;
    expect(resolved.export.completeness).toBe('full');
    expect(resolved.export.members).toHaveLength(2);
    expect(resolved.export.members.filter((m) => m.role === 'root')).toHaveLength(1);
    expect(resolved.export.members.filter((m) => m.normalizedPath === 'service.proto')).toHaveLength(
      1
    );
    expect(resolved.export.members.map((m) => m.normalizedPath).sort()).toEqual([
      'a.proto',
      'service.proto'
    ]);
    expect(resolved.export.members.find((m) => m.normalizedPath === 'a.proto')?.content).toBe(dep);
    expect(resolved.export.content).toBe(root);

    // Cycle at exact unique-file cap must remain full (cycle edge does not consume the cap).
    const cycleAtCap = resolveProtoSourceSet(
      [
        { path: 'service.proto', contentsBase64: b64(root) },
        { path: 'a.proto', contentsBase64: b64(dep) }
      ],
      { limits: { maxFiles: 2 } }
    );
    expect(cycleAtCap.status).toBe('exportable');
    if (cycleAtCap.status === 'exportable') {
      expect(cycleAtCap.export.completeness).toBe('full');
      expect(cycleAtCap.export.members).toHaveLength(2);
    }
  });
});
