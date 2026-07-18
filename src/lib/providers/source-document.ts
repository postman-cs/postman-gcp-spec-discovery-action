import { TextDecoder } from 'node:util';

import type { SpecFormat } from '../../contracts.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 4;

export interface DecodedSourceDocument {
  content: string;
  format: SpecFormat;
  filename: 'index.json' | 'index.yaml';
}

export function decodeUtf8OpenApi(text: string): DecodedSourceDocument {
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw new Error('Configuration source file exceeds 10 MiB');
  const parsed = parseAndValidateOpenApi(text);
  return { content: `${text.replace(/(?:\r?\n)+$/, '')}\n`, format: parsed.isJson ? 'openapi-json' : 'openapi-yaml', filename: parsed.isJson ? 'index.json' : 'index.yaml' };
}

export function decodeSourceDocument(contents: string | undefined): DecodedSourceDocument {
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
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error('Configuration source file is not valid UTF-8', { cause: error });
  }
  return decodeUtf8OpenApi(text);
}
