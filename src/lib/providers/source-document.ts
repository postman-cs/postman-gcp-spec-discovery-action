import { TextDecoder } from 'node:util';

import type { SpecFormat } from '../../contracts.js';
import {
  nativeFilename,
  parseAndValidateNativeFamily,
  parseAndValidateNativeSpec,
  type NativeExportFilename
} from '../spec/native-formats.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 4;

export type NativeSpecFamily = 'openapi' | 'asyncapi' | 'graphql' | 'protobuf' | 'wsdl' | 'mcp';

export interface DecodedSourceDocument {
  content: string;
  format: SpecFormat;
  filename: NativeExportFilename;
}

/**
 * Historical trailing-newline normalizer. Decode/export paths must not call this —
 * they materialize the exact decoded source text. Kept for callers that intentionally
 * want a single-trailing-LF comparison view.
 */
export function normalizeSourceText(text: string): string {
  return `${text.replace(/(?:\r?\n)+$/, '')}\n`;
}

function assertUtf8Size(text: string): void {
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) {
    throw new Error('Configuration source file exceeds 10 MiB');
  }
}

/**
 * OpenAPI-only UTF-8 decode. OpenAPI providers must call this (or decodeSourceDocument)
 * so non-OpenAPI native inputs are never accepted accidentally.
 * Validates on a trimmed view; materializes the exact input text.
 */
export function decodeUtf8OpenApi(text: string): DecodedSourceDocument {
  assertUtf8Size(text);
  const parsed = parseAndValidateOpenApi(text);
  return {
    content: text,
    format: parsed.isJson ? 'openapi-json' : 'openapi-yaml',
    filename: parsed.isJson ? 'index.json' : 'index.yaml'
  };
}

/** OpenAPI-only base64 decode used by API Gateway, Cloud Endpoints, and similar. */
export function decodeSourceDocument(contents: string | undefined): DecodedSourceDocument {
  const text = decodeBoundedBase64Utf8(contents);
  return decodeUtf8OpenApi(text);
}

/**
 * Native UTF-8 decode for bootstrap-supported formats. Used by API Hub stored-original
 * routes when the declared type (or content detection) identifies a native family.
 * Validates on a bounded/trimmed view; materializes the exact input text.
 */
export function decodeUtf8NativeSpec(
  text: string,
  expectedFormat?: SpecFormat
): DecodedSourceDocument {
  assertUtf8Size(text);
  const validated = parseAndValidateNativeSpec(text, expectedFormat);
  return {
    content: text,
    format: validated.format,
    filename: nativeFilename(validated.format)
  };
}

export function decodeUtf8NativeFamily(text: string, family: NativeSpecFamily): DecodedSourceDocument {
  assertUtf8Size(text);
  const validated = parseAndValidateNativeFamily(text, family);
  return {
    content: text,
    format: validated.format,
    filename: nativeFilename(validated.format)
  };
}

export function decodeNativeSourceDocument(
  contents: string | undefined,
  family?: NativeSpecFamily
): DecodedSourceDocument {
  const text = decodeBoundedBase64Utf8(contents);
  return family ? decodeUtf8NativeFamily(text, family) : decodeUtf8NativeSpec(text);
}

/** Bounded strict base64 → UTF-8 decode shared by portal wire contents and native source docs. */
export function decodeBoundedBase64Utf8(contents: string | undefined): string {
  if (!contents) throw new Error('Configuration source file has no contents');
  if (contents.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(contents)) {
    throw new Error('Configuration source file is not valid base64 or exceeds 10 MiB');
  }
  const bytes = Buffer.from(contents, 'base64');
  const expected = contents.replace(/=+$/, '');
  if (bytes.toString('base64').replace(/=+$/, '') !== expected) {
    throw new Error('Configuration source file is not valid base64');
  }
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new Error('Configuration source file exceeds 10 MiB');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error('Configuration source file is not valid UTF-8', { cause: error });
  }
}
