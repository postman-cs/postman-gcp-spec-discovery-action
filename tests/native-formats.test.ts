import { describe, expect, it } from 'vitest';

import type { SpecFormat } from '../src/contracts.js';
import {
  detectNativeFormat,
  nativeFilename,
  parseAndValidateNativeSpec
} from '../src/lib/spec/native-formats.js';
import { decodeUtf8NativeSpec, decodeUtf8OpenApi } from '../src/lib/providers/source-document.js';

const REQUIRED_FORMATS: SpecFormat[] = [
  'openapi-yaml',
  'openapi-json',
  'asyncapi-yaml',
  'asyncapi-json',
  'graphql-sdl',
  'graphql-introspection-json',
  'protobuf',
  'wsdl',
  'mcp-json'
];

const VALID_PROTO =
  'syntax = "proto3";\npackage demo;\nmessage Ping { string id = 1; }\nservice Greeter {\n  rpc SayHello (Ping) returns (Ping);\n}\n';

describe('native format contracts', () => {
  it('expands SpecFormat with stable bootstrap-native names', () => {
    for (const format of REQUIRED_FORMATS) {
      const assigned: SpecFormat = format;
      expect(assigned).toBe(format);
      expect(nativeFilename(format).length).toBeGreaterThan(0);
    }
  });
});

describe('native format detection', () => {
  it('identifies OpenAPI JSON vs YAML across 2.0, 3.0, and 3.1', () => {
    expect(
      detectNativeFormat(
        JSON.stringify({
          swagger: '2.0',
          info: { title: 's', version: '1' },
          paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } }
        })
      )
    ).toMatchObject({ format: 'openapi-json', kind: 'openapi', version: 'swagger-2.0' });

    expect(
      detectNativeFormat(
        'openapi: "3.0.3"\ninfo:\n  title: o\n  version: "1"\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n'
      )
    ).toMatchObject({ format: 'openapi-yaml', kind: 'openapi', version: 'openapi-3.0' });
  });

  it('identifies AsyncAPI JSON vs YAML', () => {
    expect(
      detectNativeFormat(
        JSON.stringify({
          asyncapi: '2.6.0',
          info: { title: 'events', version: '1.0.0' },
          channels: { ping: { publish: { message: { payload: { type: 'object' } } } } }
        })
      )
    ).toMatchObject({ format: 'asyncapi-json', kind: 'asyncapi' });

    expect(
      detectNativeFormat(
        'asyncapi: 3.0.0\ninfo:\n  title: events\n  version: "1"\nchannels:\n  ping:\n    address: ping\n'
      )
    ).toMatchObject({ format: 'asyncapi-yaml', kind: 'asyncapi' });
  });

  it('detects WSDL 1.1/2.0 roots and rejects arbitrary XML', () => {
    const wsdl = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Orders">
  <portType name="OrdersPort"/>
</definitions>`;
    expect(detectNativeFormat(wsdl)).toMatchObject({ format: 'wsdl', kind: 'wsdl' });
    expect(detectNativeFormat('<root><child/></root>')).toBeUndefined();
  });

  it('detects protobuf only when a service/rpc is present', () => {
    expect(detectNativeFormat(VALID_PROTO)).toMatchObject({ format: 'protobuf', kind: 'protobuf' });
    expect(
      detectNativeFormat('syntax = "proto3";\npackage demo;\nmessage Ping { string id = 1; }\n')
    ).toBeUndefined();
    expect(detectNativeFormat('// not a protobuf file, just a comment\n')).toBeUndefined();
  });

  it('detects GraphQL SDL and introspection JSON', () => {
    expect(detectNativeFormat('type Query { ping: String! }\n')).toMatchObject({
      format: 'graphql-sdl',
      kind: 'graphql-sdl'
    });
    expect(
      detectNativeFormat(JSON.stringify({ __schema: { queryType: { name: 'Query' }, types: [] } }))
    ).toMatchObject({ format: 'graphql-introspection-json', kind: 'graphql-introspection' });
    expect(detectNativeFormat('type: object\nproperties:\n  id: { type: string }\n')).toBeUndefined();
  });

  it('detects MCP JSON conservatively and rejects arbitrary JSON', () => {
    expect(
      detectNativeFormat(
        JSON.stringify({
          mcpServers: { demo: { command: 'node', args: ['server.js'] } }
        })
      )
    ).toMatchObject({ format: 'mcp-json', kind: 'mcp' });
    expect(detectNativeFormat(JSON.stringify({ name: 'demo', remotes: [{ url: 'https://example.com' }] }))).toMatchObject(
      { format: 'mcp-json', kind: 'mcp' }
    );
    expect(detectNativeFormat(JSON.stringify({ foo: 'bar', count: 1 }))).toBeUndefined();
  });
});

describe('native format validation', () => {
  it('rejects empty, malformed, and wrong-kind documents', () => {
    expect(() => parseAndValidateNativeSpec('')).toThrow(/empty/i);
    expect(() => parseAndValidateNativeSpec('{not json')).toThrow(/parseable|malformed/i);
    expect(() =>
      parseAndValidateNativeSpec(
        JSON.stringify({
          asyncapi: '2.6.0',
          info: { title: 'events', version: '1.0.0' },
          channels: { ping: {} }
        }),
        'openapi-json'
      )
    ).toThrow(/openapi|swagger|wrong/i);
  });

  it('rejects message-only protobuf (PROTO_NO_SERVICES) and non-object MCP entries', () => {
    expect(() =>
      parseAndValidateNativeSpec('syntax = "proto3";\nmessage Ping { string id = 1; }\n')
    ).toThrow(/PROTO_NO_SERVICES|service methods|rpc/i);
    expect(() => parseAndValidateNativeSpec(JSON.stringify({ mcpServers: {} }))).toThrow(/MCP|mcpServers/i);
    expect(() =>
      parseAndValidateNativeSpec(JSON.stringify({ mcpServers: { demo: 'not-an-object' } }))
    ).toThrow(/MCP|mcpServers/i);
    expect(() =>
      parseAndValidateNativeSpec(
        JSON.stringify({
          $schema: 'https://static.modelcontextprotocol.io/schemas/2025-07-09/server.json',
          name: 'io.github.example/empty-shell'
        })
      )
    ).toThrow(/MCP|mcpServers|remotes|packages/i);
    expect(() =>
      parseAndValidateNativeSpec(JSON.stringify({ name: 'io.github.example/weather', remotes: [null, 'x'] }))
    ).toThrow(/MCP|mcpServers|remotes|packages/i);
  });

  it('validates each bootstrap-native family and materializes exact decoded text', () => {
    const asyncapi = parseAndValidateNativeSpec(
      JSON.stringify({
        asyncapi: '2.6.0',
        info: { title: 'events', version: '1.0.0' },
        channels: { ping: { publish: { message: { payload: { type: 'string' } } } } }
      })
    );
    expect(asyncapi.format).toBe('asyncapi-json');

    expect(parseAndValidateNativeSpec(VALID_PROTO).format).toBe('protobuf');
    expect(parseAndValidateNativeSpec('type Query { ok: Boolean! }\n').format).toBe('graphql-sdl');
    expect(
      parseAndValidateNativeSpec(JSON.stringify({ data: { __schema: { queryType: { name: 'Query' }, types: [] } } }))
        .format
    ).toBe('graphql-introspection-json');
    expect(
      parseAndValidateNativeSpec(
        JSON.stringify({ mcpServers: { demo: { command: 'npx', args: ['demo'] } } })
      ).format
    ).toBe('mcp-json');

    const noNewline = 'type Query { ping: String! }';
    expect(decodeUtf8NativeSpec(noNewline).content).toBe(noNewline);

    const crlf = 'type Query { ping: String! }\r\n';
    expect(decodeUtf8NativeSpec(crlf).content).toBe(crlf);

    const multiTrailing = 'type Query { ping: String! }\n\n\n';
    expect(decodeUtf8NativeSpec(multiTrailing).content).toBe(multiTrailing);
    expect(decodeUtf8NativeSpec(multiTrailing).filename).toBe('schema.graphql');
  });

  it('keeps OpenAPI decode strict: native GraphQL is rejected by decodeUtf8OpenApi', () => {
    expect(() => decodeUtf8OpenApi('type Query { ping: String! }\n')).toThrow(/Swagger|OpenAPI|parseable/i);
    expect(() =>
      decodeUtf8OpenApi(JSON.stringify({ mcpServers: { demo: { command: 'node' } } }))
    ).toThrow(/Swagger|OpenAPI/i);
  });
});
