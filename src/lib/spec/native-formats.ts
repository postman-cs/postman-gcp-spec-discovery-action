import { parse } from 'yaml';

import type { SpecFormat } from '../../contracts.js';
import { parseAndValidateOpenApi, type ValidatedOpenApi } from './validate-openapi.js';

/** Bound content inspection to avoid unbounded YAML/XML walks on huge files. */
const MAX_INSPECT_CHARS = 256_000;

export type NativeSpecKind =
  | 'openapi'
  | 'asyncapi'
  | 'wsdl'
  | 'protobuf'
  | 'graphql-sdl'
  | 'graphql-introspection'
  | 'mcp';

export type NativeSerialization = 'json' | 'yaml' | 'xml' | 'text';

export interface NativeFormatDetection {
  kind: NativeSpecKind;
  format: SpecFormat;
  serialization: NativeSerialization;
  version?: ValidatedOpenApi['version'] | string;
}

export interface NativeValidationResult extends NativeFormatDetection {
  document?: Record<string, unknown>;
}

/** Stable artifact filenames for preserved native exports. */
export type NativeExportFilename =
  | 'index.json'
  | 'index.yaml'
  | 'asyncapi.json'
  | 'asyncapi.yaml'
  | 'schema.graphql'
  | 'introspection.json'
  | 'service.proto'
  | 'service.wsdl'
  | 'mcp.json';

export function nativeFilename(format: SpecFormat): NativeExportFilename {
  switch (format) {
    case 'openapi-json':
      return 'index.json';
    case 'openapi-yaml':
      return 'index.yaml';
    case 'asyncapi-json':
      return 'asyncapi.json';
    case 'asyncapi-yaml':
      return 'asyncapi.yaml';
    case 'graphql-sdl':
      return 'schema.graphql';
    case 'graphql-introspection-json':
      return 'introspection.json';
    case 'protobuf':
      return 'service.proto';
    case 'wsdl':
      return 'service.wsdl';
    case 'mcp-json':
      return 'mcp.json';
  }
}

function bound(content: string): string {
  return content.length > MAX_INSPECT_CHARS ? content.slice(0, MAX_INSPECT_CHARS) : content;
}

function trimContent(content: string): string {
  return bound(content).trim();
}

function looksLikeJson(trimmed: string): boolean {
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function looksLikeXml(trimmed: string): boolean {
  return trimmed.startsWith('<');
}

function parseObjectDocument(content: string): { document: Record<string, unknown>; isJson: boolean } | undefined {
  const trimmed = trimContent(content);
  if (!trimmed) return undefined;
  const isJson = looksLikeJson(trimmed);
  try {
    const parsed = isJson ? JSON.parse(trimmed) : parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return { document: parsed as Record<string, unknown>, isJson };
  } catch {
    return undefined;
  }
}

function openApiVersionOf(document: Record<string, unknown>): ValidatedOpenApi['version'] | undefined {
  const swagger = typeof document.swagger === 'string' ? document.swagger : '';
  const openapi = typeof document.openapi === 'string' ? document.openapi : '';
  if (swagger.startsWith('2')) return 'swagger-2.0';
  if (openapi.startsWith('3.1')) return 'openapi-3.1';
  if (openapi.startsWith('3.')) return 'openapi-3.0';
  return undefined;
}

function stripXmlPreamble(xml: string): string {
  return xml
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .trim();
}

function xmlRootInfo(xml: string): { localName: string; qualified: string; head: string } | undefined {
  const body = stripXmlPreamble(trimContent(xml));
  const match = body.match(/<\s*([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\b([^>]*)>/);
  if (!match) return undefined;
  const qualified = match[1]!;
  const localName = (qualified.includes(':') ? qualified.split(':').pop()! : qualified).toLowerCase();
  const head = `${qualified} ${match[2] ?? ''}`.toLowerCase();
  return { localName, qualified, head };
}

function isWsdlXml(xml: string): boolean {
  const root = xmlRootInfo(xml);
  if (!root) return false;
  if (root.localName !== 'definitions' && root.localName !== 'description') return false;
  return /wsdl/i.test(root.head) || /schemas\.xmlsoap\.org\/wsdl|www\.w3\.org\/ns\/wsdl/i.test(trimContent(xml));
}

const GRAPHQL_DEFINITION_RE =
  /^\s*(?:"""[\s\S]*?"""\s*)?(?:extend\s+)?(?:(?:type|interface|enum|union|scalar|input)\s+[A-Za-z_]|schema\s*\{|directive\s+@)/m;

function isGraphqlSdl(content: string): boolean {
  const trimmed = trimContent(content);
  if (!trimmed || looksLikeJson(trimmed) || looksLikeXml(trimmed)) return false;
  // Reject YAML mapping keys (`type:`, `enum:`) that would otherwise match bare keywords.
  if (/^\s*(?:openapi|swagger|asyncapi)\s*:/m.test(trimmed)) return false;
  return GRAPHQL_DEFINITION_RE.test(trimmed);
}

function looksLikeIntrospection(record: Record<string, unknown>): boolean {
  if (record.__schema && typeof record.__schema === 'object' && !Array.isArray(record.__schema)) return true;
  const data = record.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const nested = (data as Record<string, unknown>).__schema;
  return Boolean(nested && typeof nested === 'object' && !Array.isArray(nested));
}

/**
 * Conservative MCP detection aligned with bootstrap: mcpServers client config,
 * modelcontextprotocol $schema, or registry server.json (name + remotes/packages).
 */
function looksLikeMcp(record: Record<string, unknown>): boolean {
  if (record.mcpServers && typeof record.mcpServers === 'object' && !Array.isArray(record.mcpServers)) return true;
  if (typeof record.$schema === 'string' && /modelcontextprotocol/i.test(record.$schema)) return true;
  return typeof record.name === 'string' && (Array.isArray(record.remotes) || Array.isArray(record.packages));
}

/** Structural near-match: syntax / message / service shape (may lack usable RPCs). */
function isProtobufSource(content: string): boolean {
  const trimmed = trimContent(content);
  if (!trimmed || looksLikeJson(trimmed) || looksLikeXml(trimmed)) return false;
  if (/^\s*(?:openapi|swagger|asyncapi)\s*:/m.test(trimmed)) return false;
  if (/^\s*syntax\s*=\s*["']proto[23]["']\s*;/m.test(trimmed)) return true;
  if (/\bmessage\s+[A-Za-z_]\w*\s*\{/.test(trimmed)) return true;
  if (/\bservice\s+[A-Za-z_]\w*\s*\{[\s\S]*\brpc\b/.test(trimmed)) return true;
  return false;
}

/**
 * Bootstrap-usable gRPC parity: at least one `service` with an `rpc`.
 * Message-only / syntax-only documents are near-matches, not exportable contracts.
 */
function hasProtobufServiceRpc(content: string): boolean {
  return /\bservice\s+[A-Za-z_]\w*\s*\{[\s\S]*\brpc\b/.test(trimContent(content));
}

function asyncApiVersionOf(document: Record<string, unknown>): string | undefined {
  return typeof document.asyncapi === 'string' && document.asyncapi.trim() ? document.asyncapi.trim() : undefined;
}

function hasAsyncApiChannels(document: Record<string, unknown>): boolean {
  const channels = document.channels;
  if (channels && typeof channels === 'object' && !Array.isArray(channels)) {
    return Object.keys(channels as Record<string, unknown>).length > 0;
  }
  const operations = document.operations;
  if (operations && typeof operations === 'object' && !Array.isArray(operations)) {
    return Object.keys(operations as Record<string, unknown>).length > 0;
  }
  return false;
}

function mcpServersHasObjectEntry(mcpServers: Record<string, unknown>): boolean {
  for (const value of Object.values(mcpServers)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return true;
  }
  return false;
}

function arrayHasObjectEntry(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

/**
 * Bootstrap-usable MCP: at least one object server entry under mcpServers, or a
 * registry name plus object remotes/packages. Empty shells, non-object entries,
 * and `$schema`+name alone are near-matches (MCP_NO_SERVERS).
 */
function hasUsableMcpServers(document: Record<string, unknown>): boolean {
  const mcpServers = document.mcpServers;
  if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
    return mcpServersHasObjectEntry(mcpServers as Record<string, unknown>);
  }
  if (typeof document.name !== 'string' || !document.name.trim()) return false;
  return arrayHasObjectEntry(document.remotes) || arrayHasObjectEntry(document.packages);
}

/**
 * Content-based native format detection with bounded text assumptions.
 * Returns undefined when the document does not match a bootstrap-supported family.
 * Conservative: arbitrary JSON/XML/text never matches.
 */
export function detectNativeFormat(content: string): NativeFormatDetection | undefined {
  const trimmed = trimContent(content);
  if (!trimmed) return undefined;

  if (looksLikeXml(trimmed)) {
    if (isWsdlXml(trimmed)) {
      return { kind: 'wsdl', format: 'wsdl', serialization: 'xml' };
    }
    return undefined;
  }

  const parsed = parseObjectDocument(trimmed);
  if (parsed) {
    if (parsed.isJson && looksLikeIntrospection(parsed.document)) {
      return {
        kind: 'graphql-introspection',
        format: 'graphql-introspection-json',
        serialization: 'json'
      };
    }
    const asyncVersion = asyncApiVersionOf(parsed.document);
    if (asyncVersion) {
      return {
        kind: 'asyncapi',
        format: parsed.isJson ? 'asyncapi-json' : 'asyncapi-yaml',
        serialization: parsed.isJson ? 'json' : 'yaml',
        version: asyncVersion
      };
    }
    const openapiVersion = openApiVersionOf(parsed.document);
    if (openapiVersion) {
      return {
        kind: 'openapi',
        format: parsed.isJson ? 'openapi-json' : 'openapi-yaml',
        serialization: parsed.isJson ? 'json' : 'yaml',
        version: openapiVersion
      };
    }
    if (parsed.isJson && looksLikeMcp(parsed.document) && hasUsableMcpServers(parsed.document)) {
      return { kind: 'mcp', format: 'mcp-json', serialization: 'json' };
    }
  }

  if (isProtobufSource(trimmed) && hasProtobufServiceRpc(trimmed)) {
    return { kind: 'protobuf', format: 'protobuf', serialization: 'text' };
  }
  if (isGraphqlSdl(trimmed)) {
    return { kind: 'graphql-sdl', format: 'graphql-sdl', serialization: 'text' };
  }
  return undefined;
}

function assertExpectedFormat(actual: SpecFormat, expected?: SpecFormat): void {
  if (expected && actual !== expected) {
    throw new Error(`Specification is wrong kind: expected ${expected}, detected ${actual}`);
  }
}

function validateAsyncApi(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  const isJson = looksLikeJson(trimmed);
  let parsed: unknown;
  try {
    parsed = isJson ? JSON.parse(trimmed) : parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Specification is not parseable JSON or YAML: ${detail}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Specification did not parse to an object document');
  }
  const document = parsed as Record<string, unknown>;
  const version = asyncApiVersionOf(document);
  if (!version) {
    throw new Error('Specification is not an AsyncAPI document');
  }
  if (!hasAsyncApiChannels(document)) {
    throw new Error('AsyncAPI document has no channels or operations');
  }
  const format: SpecFormat = isJson ? 'asyncapi-json' : 'asyncapi-yaml';
  assertExpectedFormat(format, expected);
  return {
    kind: 'asyncapi',
    format,
    serialization: isJson ? 'json' : 'yaml',
    version,
    document
  };
}

function validateWsdl(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!looksLikeXml(trimmed) || !xmlRootInfo(trimmed)) {
    throw new Error('Specification is not parseable XML');
  }
  if (!isWsdlXml(trimmed)) {
    throw new Error('XML document is not a WSDL 1.1/2.0 root');
  }
  assertExpectedFormat('wsdl', expected);
  return { kind: 'wsdl', format: 'wsdl', serialization: 'xml' };
}

function validateProtobuf(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!isProtobufSource(trimmed)) {
    throw new Error('Specification is not protobuf source (syntax, message, or service required)');
  }
  if (!hasProtobufServiceRpc(trimmed)) {
    throw new Error(
      'PROTO_NO_SERVICES: .proto defines no service methods; gRPC contract tests require at least one rpc'
    );
  }
  assertExpectedFormat('protobuf', expected);
  return { kind: 'protobuf', format: 'protobuf', serialization: 'text' };
}

function validateGraphqlSdl(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!isGraphqlSdl(trimmed)) {
    throw new Error('Specification is not GraphQL SDL (type or schema definition required)');
  }
  assertExpectedFormat('graphql-sdl', expected);
  return { kind: 'graphql-sdl', format: 'graphql-sdl', serialization: 'text' };
}

function validateGraphqlIntrospection(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!looksLikeJson(trimmed)) {
    throw new Error('Specification is not GraphQL introspection JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Specification is not parseable JSON: ${detail}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Specification did not parse to an object document');
  }
  const document = parsed as Record<string, unknown>;
  if (!looksLikeIntrospection(document)) {
    throw new Error('Specification is not GraphQL introspection JSON (missing __schema)');
  }
  assertExpectedFormat('graphql-introspection-json', expected);
  return {
    kind: 'graphql-introspection',
    format: 'graphql-introspection-json',
    serialization: 'json',
    document
  };
}

function validateMcp(content: string, expected?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) throw new Error('Specification content is empty');
  if (!looksLikeJson(trimmed)) {
    throw new Error('Specification is not MCP JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Specification is not parseable JSON: ${detail}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Specification did not parse to an object document');
  }
  const document = parsed as Record<string, unknown>;
  if (!looksLikeMcp(document) || !hasUsableMcpServers(document)) {
    throw new Error(
      'Specification is not an MCP server description (usable mcpServers object entries, or name plus object remotes/packages required)'
    );
  }
  assertExpectedFormat('mcp-json', expected);
  return { kind: 'mcp', format: 'mcp-json', serialization: 'json', document };
}

function validateOpenApi(content: string, expected?: SpecFormat): NativeValidationResult {
  const validated = parseAndValidateOpenApi(content);
  const format: SpecFormat = validated.isJson ? 'openapi-json' : 'openapi-yaml';
  assertExpectedFormat(format, expected);
  return {
    kind: 'openapi',
    format,
    serialization: validated.isJson ? 'json' : 'yaml',
    version: validated.version,
    document: validated.document
  };
}

/**
 * Parse and validate a bootstrap-supported native specification document.
 *
 * Rejects empty, malformed, wrong-kind, and arbitrary JSON/XML/text. OpenAPI
 * keeps the nonempty `paths` + HTTP operation contract. Bytes are not mutated
 * here; callers materialize the exact decoded source text on export.
 */
export function parseAndValidateNativeSpec(content: string, expectedFormat?: SpecFormat): NativeValidationResult {
  const trimmed = trimContent(content);
  if (!trimmed) {
    throw new Error('Specification content is empty');
  }

  if (expectedFormat === 'openapi-json' || expectedFormat === 'openapi-yaml') {
    return validateOpenApi(content, expectedFormat);
  }
  if (expectedFormat === 'asyncapi-json' || expectedFormat === 'asyncapi-yaml') {
    return validateAsyncApi(content, expectedFormat);
  }
  if (expectedFormat === 'wsdl') {
    return validateWsdl(content, expectedFormat);
  }
  if (expectedFormat === 'protobuf') {
    return validateProtobuf(content, expectedFormat);
  }
  if (expectedFormat === 'graphql-sdl') {
    return validateGraphqlSdl(content, expectedFormat);
  }
  if (expectedFormat === 'graphql-introspection-json') {
    return validateGraphqlIntrospection(content, expectedFormat);
  }
  if (expectedFormat === 'mcp-json') {
    return validateMcp(content, expectedFormat);
  }

  const detected = detectNativeFormat(content);
  if (!detected) {
    if (looksLikeXml(trimmed)) {
      throw new Error('XML document is not a WSDL 1.1/2.0 root');
    }
    if (looksLikeJson(trimmed) || /:\s*\S/.test(trimmed)) {
      try {
        if (looksLikeJson(trimmed)) JSON.parse(trimmed);
        else parse(trimmed);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Specification is not parseable JSON or YAML: ${detail}`, { cause: error });
      }
    }
    if (isProtobufSource(trimmed) && !hasProtobufServiceRpc(trimmed)) {
      throw new Error(
        'PROTO_NO_SERVICES: .proto defines no service methods; gRPC contract tests require at least one rpc'
      );
    }
    if (looksLikeJson(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && looksLikeMcp(parsed as Record<string, unknown>)) {
          throw new Error(
            'Specification is not an MCP server description (usable mcpServers object entries, or name plus object remotes/packages required)'
          );
        }
      } catch (error) {
        if (error instanceof Error && /MCP server description/i.test(error.message)) throw error;
      }
    }
    if (/^\s*package\s+[\w.]+/m.test(trimmed) || /\bproto\b/i.test(trimmed)) {
      throw new Error('Specification is not protobuf source (syntax, message, or service required)');
    }
    if (/^\s*#/.test(trimmed) || /\b(type|schema|query)\b/i.test(trimmed)) {
      throw new Error('Specification is not GraphQL SDL (type or schema definition required)');
    }
    throw new Error('Specification is not a supported native format');
  }

  switch (detected.kind) {
    case 'openapi':
      return validateOpenApi(content, expectedFormat);
    case 'asyncapi':
      return validateAsyncApi(content, expectedFormat);
    case 'wsdl':
      return validateWsdl(content, expectedFormat);
    case 'protobuf':
      return validateProtobuf(content, expectedFormat);
    case 'graphql-sdl':
      return validateGraphqlSdl(content, expectedFormat);
    case 'graphql-introspection':
      return validateGraphqlIntrospection(content, expectedFormat);
    case 'mcp':
      return validateMcp(content, expectedFormat);
  }
}

/**
 * Validate content against a declared API Hub / catalog family when the exact
 * SpecFormat serialization is not known in advance (e.g. OpenAPI YAML vs JSON).
 */
export function parseAndValidateNativeFamily(
  content: string,
  family: 'openapi' | 'asyncapi' | 'graphql' | 'protobuf' | 'wsdl' | 'mcp'
): NativeValidationResult {
  switch (family) {
    case 'openapi': {
      const result = validateOpenApi(content);
      return result;
    }
    case 'asyncapi': {
      const result = validateAsyncApi(content);
      return result;
    }
    case 'graphql': {
      const detected = detectNativeFormat(content);
      if (detected?.kind === 'graphql-introspection') {
        return validateGraphqlIntrospection(content);
      }
      return validateGraphqlSdl(content);
    }
    case 'protobuf':
      return validateProtobuf(content);
    case 'wsdl':
      return validateWsdl(content);
    case 'mcp':
      return validateMcp(content);
  }
}

export function isOpenApiFormat(format: SpecFormat): boolean {
  return format === 'openapi-json' || format === 'openapi-yaml';
}
