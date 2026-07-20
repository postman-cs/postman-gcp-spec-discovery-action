import { describe, expect, it } from 'vitest';

import { parseAndValidateOpenApi } from '../src/lib/spec/validate-openapi.js';

const GET_OP = { get: { responses: { '200': { description: 'ok' } } } };

describe('OpenAPI export validation', () => {
  it('GCP-APIM-005: malformed JSON, unsupported version, missing paths, and empty paths reject', () => {
    expect(() => parseAndValidateOpenApi('{not json')).toThrow(/not parseable/);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ openapi: '4.0.0', info: {}, paths: { '/a': GET_OP } }))
    ).toThrow('Specification is not Swagger 2.0 or OpenAPI 3.x');
    expect(() => parseAndValidateOpenApi(JSON.stringify({ openapi: '3.0.3', info: {} }))).toThrow(
      'Specification has no paths object'
    );
    expect(() => parseAndValidateOpenApi(JSON.stringify({ openapi: '3.0.3', info: {}, paths: {} }))).toThrow(
      'Specification has an empty paths object'
    );
  });

  it('GCP-APIM-005: nonempty paths without a recognized HTTP operation reject', () => {
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ openapi: '3.0.3', info: { title: 'p', version: '1' }, paths: { '/a': {} } }))
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(
        JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'p', version: '1' },
          paths: { '/a': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } }
        })
      )
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(
        JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'p', version: '1' },
          paths: { '/a': { $ref: '#/components/pathItems/Item' } }
        })
      )
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(
        JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'p', version: '1' },
          paths: { '/a': { 'x-internal': true, summary: 'extension only' } }
        })
      )
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(
        JSON.stringify({
          openapi: '3.0.3',
          info: { title: 'p', version: '1' },
          paths: { '/a': null, '/b': 'not-an-object' }
        })
      )
    ).toThrow(/no recognized HTTP operation/i);
  });

  it('GCP-APIM-005: recognized method keys with unusable operation values reject', () => {
    const base = { openapi: '3.0.3', info: { title: 'p', version: '1' } };
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ ...base, paths: { '/a': { get: null } } }))
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ ...base, paths: { '/a': { get: 'not-an-operation' } } }))
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ ...base, paths: { '/a': { get: [] } } }))
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ ...base, paths: { '/a': { get: {} } } }))
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ ...base, paths: { '/a': { get: { summary: 'no responses' } } } }))
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ ...base, paths: { '/a': { get: { responses: {} } } } }))
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ ...base, paths: { '/a': { get: { responses: null } } } }))
    ).toThrow(/no recognized HTTP operation/i);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ ...base, paths: { '/a': { get: { responses: [] } } } }))
    ).toThrow(/no recognized HTTP operation/i);

    const valid = parseAndValidateOpenApi(
      JSON.stringify({ ...base, paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } } })
    );
    expect(valid.version).toBe('openapi-3.0');
  });

  it('GCP-APIM-005: valid Swagger 2.0 and OpenAPI 3.0/3.1 with one HTTP operation succeed', () => {
    const swagger = parseAndValidateOpenApi(
      JSON.stringify({ swagger: '2.0', info: { title: 'l', version: '1' }, paths: { '/a': GET_OP } })
    );
    expect(swagger.version).toBe('swagger-2.0');
    expect(swagger.isJson).toBe(true);

    const openapi = parseAndValidateOpenApi(
      JSON.stringify({ openapi: '3.0.3', info: { title: 'p', version: '1' }, paths: { '/a': GET_OP } })
    );
    expect(openapi.version).toBe('openapi-3.0');

    const yaml = parseAndValidateOpenApi(
      'openapi: 3.1.0\ninfo:\n  title: y\n  version: "1"\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    );
    expect(yaml.version).toBe('openapi-3.1');
    expect(yaml.isJson).toBe(false);
  });

  it('GCP-APIM-005: parameters plus an operation and case-insensitive methods are accepted', () => {
    const withParams = parseAndValidateOpenApi(
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'p', version: '1' },
        paths: {
          '/a/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            get: { responses: { '200': { description: 'ok' } } }
          }
        }
      })
    );
    expect(withParams.version).toBe('openapi-3.0');

    const upper = parseAndValidateOpenApi(
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'p', version: '1' },
        paths: { '/a': { GET: { responses: { '200': { description: 'ok' } } } } }
      })
    );
    expect(upper.version).toBe('openapi-3.0');
  });
});
