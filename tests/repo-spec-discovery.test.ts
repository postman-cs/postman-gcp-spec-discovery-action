import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findExistingRepoSpecTyped } from '../src/lib/repo/specs.js';

const VALID_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Payments', version: '1.0.0' },
  paths: { '/payments': { get: { responses: { '200': { description: 'ok' } } } } }
});

const INVALID_SPEC = JSON.stringify({ openapi: '3.0.3' });

const VALID_ASYNCAPI = JSON.stringify({
  asyncapi: '2.6.0',
  info: { title: 'Events', version: '1.0.0' },
  channels: { ping: { publish: { message: { payload: { type: 'string' } } } } }
});

const VALID_GRAPHQL = 'type Query { ping: String! }\n';
const VALID_PROTO = 'syntax = "proto3";\npackage demo;\nmessage Ping { string id = 1; }\nservice Greeter {\n  rpc SayHello (Ping) returns (Ping);\n}\n';
const VALID_WSDL = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" name="Orders">
  <portType name="OrdersPort"/>
</definitions>
`;
const VALID_MCP = JSON.stringify({
  mcpServers: { demo: { command: 'node', args: ['server.js'] } }
});
const VALID_INTROSPECTION = JSON.stringify({
  __schema: { queryType: { name: 'Query' }, types: [{ kind: 'OBJECT', name: 'Query', fields: [] }] }
});

async function repoRootWith(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gcp-repo-spec-'));
  for (const [relPath, content] of Object.entries(entries)) {
    const full = join(root, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return root;
}

describe('repository spec discovery validation (GCP-REPOSPEC)', () => {
  it('GCP-REPOSPEC-001: a marker-only document that fails full validation is not selected', async () => {
    const root = await repoRootWith({ 'openapi.json': INVALID_SPEC });
    expect(await findExistingRepoSpecTyped(root)).toBeUndefined();
  });

  it('GCP-REPOSPEC-002: one valid document resolves with evidence', async () => {
    const root = await repoRootWith({ 'openapi.json': VALID_SPEC });
    const match = await findExistingRepoSpecTyped(root);
    expect(match?.path).toBe('openapi.json');
    expect(match?.format).toBe('openapi-json');
    expect(match?.ambiguousPaths).toBeUndefined();
  });

  it('GCP-REPOSPEC-003: two equally ranked valid documents surface as ambiguous instead of guessing', async () => {
    const root = await repoRootWith({
      'apis/payments/openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: A\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n',
      'apis/billing/openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: B\n  version: 1.0.0\npaths:\n  /b:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    });
    const match = await findExistingRepoSpecTyped(root);
    expect(match?.ambiguousPaths?.length).toBe(2);
  });

  it('GCP-REPOSPEC-004: a higher-precedence valid document beats a lower-precedence one without ambiguity', async () => {
    const root = await repoRootWith({
      'openapi.json': VALID_SPEC,
      'apis/payments/openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: A\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    });
    const match = await findExistingRepoSpecTyped(root);
    expect(match?.path).toBe('openapi.json');
    expect(match?.ambiguousPaths).toBeUndefined();
  });

  it('GCP-REPOSPEC-005: discovers AsyncAPI, GraphQL SDL, protobuf, WSDL, MCP, and introspection JSON', async () => {
    for (const [path, content, format] of [
      ['asyncapi.json', VALID_ASYNCAPI, 'asyncapi-json'],
      ['schema.graphql', VALID_GRAPHQL, 'graphql-sdl'],
      ['service.proto', VALID_PROTO, 'protobuf'],
      ['service.wsdl', VALID_WSDL, 'wsdl'],
      ['mcp.json', VALID_MCP, 'mcp-json'],
      ['introspection.json', VALID_INTROSPECTION, 'graphql-introspection-json']
    ] as const) {
      const root = await repoRootWith({ [path]: content });
      const match = await findExistingRepoSpecTyped(root);
      expect(match, path).toMatchObject({ path, format });
    }
  });

  it('GCP-REPOSPEC-006: false-positive filenames with non-native content are ignored', async () => {
    const root = await repoRootWith({
      'schema.graphql': 'type: object\nproperties:\n  id: { type: string }\n',
      'service.proto': 'this is not protobuf\n',
      'mcp.json': JSON.stringify({ foo: 'bar' }),
      'service.wsdl': '<root><not-wsdl/></root>\n',
      'asyncapi.json': JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} })
    });
    expect(await findExistingRepoSpecTyped(root)).toBeUndefined();
  });

  it('GCP-REPOSPEC-007: OpenAPI precedence beats equally ranked native peers', async () => {
    const root = await repoRootWith({
      'apis/payments/openapi.yaml':
        'openapi: 3.0.3\ninfo:\n  title: A\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n',
      'apis/payments/schema.graphql': VALID_GRAPHQL
    });
    const match = await findExistingRepoSpecTyped(root);
    expect(match?.path).toBe('apis/payments/openapi.yaml');
    expect(match?.format).toBe('openapi-yaml');
    expect(match?.ambiguousPaths).toBeUndefined();
  });
});
