import { describe, expect, it } from 'vitest';

import {
  extractProtoImports,
  normalizeProtoSourcePath,
  resolveProtoSourceSet
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
    expect(resolved.export.evidence.join(' ')).toContain('ignored non-imported sources');
  });

  it('rejects message-only, descriptor-only, multi-entrypoint, sibling imports, and unresolved imports', () => {
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

    const imported = resolveProtoSourceSet([
      {
        path: 'service.proto',
        contentsBase64: b64(`syntax = "proto3";\nimport "types.proto";\n${SERVICE_PROTO}`)
      },
      { path: 'types.proto', contentsBase64: b64(MESSAGE_ONLY) }
    ]);
    expect(imported.status).toBe('unsupported');
    if (imported.status === 'unsupported') {
      expect(imported.evidence.join(' ')).toContain('imports sibling source');
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

  it('normalizes path keys and extracts import statements', () => {
    expect(normalizeProtoSourcePath('api/./x.proto')).toBeUndefined();
    expect(normalizeProtoSourcePath('api/x.proto')).toBe('api/x.proto');
    expect(extractProtoImports('import public "a.proto";\nimport "b.proto";\n')).toEqual([
      'a.proto',
      'b.proto'
    ]);
  });
});
