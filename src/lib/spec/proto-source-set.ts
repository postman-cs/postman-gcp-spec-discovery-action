import type { SourceAuthority } from '../../contracts.js';
import { decodeBoundedBase64Utf8 } from '../providers/source-document.js';
import { parseAndValidateNativeFamily } from './native-formats.js';

/**
 * Shared single-file protobuf entrypoint selection for cloud source sets
 * (API Gateway grpcServices[].source[] and Service Management PROTO_FILE).
 *
 * Bootstrap cannot load sibling .proto closures, so this never concatenates
 * files and only exports when exactly one service/rpc-bearing entrypoint has
 * no unresolved local / sibling imports.
 */

export interface ProtoSourceFileInput {
  /** Original returned path (API Gateway File.path / ConfigFile.filePath). */
  path?: string;
  /** Base64 file bytes. */
  contentsBase64?: string;
}

export interface ProtoSourceSetOptions {
  /** True when a descriptor set is present without usable .proto sources. */
  descriptorOnly?: boolean;
  /** Evidence prefix lines (config identity, etc.). */
  evidencePrefix?: string[];
}

export interface ProtoSourceExport {
  content: string;
  originalPath: string;
  evidence: string[];
}

export type ProtoSourceSetResolution =
  | { status: 'exportable'; export: ProtoSourceExport }
  | { status: 'unsupported'; authority: SourceAuthority; evidence: string[] };

const WELL_KNOWN_IMPORT_PREFIXES = [
  'google/protobuf/',
  'google/api/',
  'google/rpc/',
  'google/type/',
  'google/longrunning/'
] as const;

interface DecodedProtoEntry {
  originalPath: string;
  normalizedPath: string;
  content: string;
  serviceBearing: boolean;
  imports: string[];
}

function isWellKnownImport(value: string): boolean {
  return WELL_KNOWN_IMPORT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function extractProtoImports(content: string): string[] {
  const imports: string[] = [];
  const pattern = /^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/gm;
  for (const match of content.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) imports.push(value);
  }
  return imports;
}

/**
 * Path-safe relative key. Rejects absolute paths, empty segments, and `..`.
 * Returns undefined when the path cannot be used as an authoritative source key.
 */
export function normalizeProtoSourcePath(path: string | undefined): string | undefined {
  if (!path || !path.trim()) return undefined;
  const normalized = path.trim().replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0')) {
    return undefined;
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return undefined;
  }
  return parts.join('/');
}

function pathBasename(path: string): string {
  return path.split('/').pop() ?? path;
}

function importMatchesReturnedSource(imp: string, returned: ReadonlySet<string>): boolean {
  if (returned.has(imp)) return true;
  for (const path of returned) {
    if (path.endsWith(`/${imp}`) || pathBasename(path) === imp) return true;
  }
  return false;
}

function classifyProtobufContent(content: string): 'service' | 'message-only' | 'invalid' {
  try {
    parseAndValidateNativeFamily(content, 'protobuf');
    return 'service';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/PROTO_NO_SERVICES/i.test(detail)) return 'message-only';
    return 'invalid';
  }
}

/**
 * Resolve a returned protobuf source set to at most one bootstrap-exportable
 * single-file entrypoint. Never concatenates or rewrites bytes.
 */
export function resolveProtoSourceSet(
  inputs: ProtoSourceFileInput[],
  options: ProtoSourceSetOptions = {}
): ProtoSourceSetResolution {
  const evidence = [...(options.evidencePrefix ?? [])];

  if (inputs.length === 0) {
    if (options.descriptorOnly) {
      return {
        status: 'unsupported',
        authority: 'unsupported-format',
        evidence: [
          ...evidence,
          'Protobuf descriptor set is present without .proto sources; descriptor-to-contract conversion is not supported'
        ]
      };
    }
    return {
      status: 'unsupported',
      authority: 'metadata-only',
      evidence: [...evidence, 'No protobuf source files were returned']
    };
  }

  const decoded: DecodedProtoEntry[] = [];
  const normalizedSeen = new Map<string, string>();

  for (const input of inputs) {
    const normalizedPath = normalizeProtoSourcePath(input.path);
    if (!normalizedPath) {
      return {
        status: 'unsupported',
        authority: 'unsupported-format',
        evidence: [
          ...evidence,
          `Protobuf source path is missing or unsafe (${input.path ?? '<empty>'}); refusing to guess an entrypoint`
        ]
      };
    }
    const prior = normalizedSeen.get(normalizedPath);
    if (prior) {
      return {
        status: 'unsupported',
        authority: 'unsupported-format',
        evidence: [
          ...evidence,
          `Protobuf source paths collide at ${normalizedPath}; refusing to merge or guess`
        ]
      };
    }
    normalizedSeen.set(normalizedPath, input.path ?? normalizedPath);

    let content: string;
    try {
      content = decodeBoundedBase64Utf8(input.contentsBase64);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        status: 'unsupported',
        authority: 'metadata-only',
        evidence: [...evidence, `Protobuf source ${normalizedPath} decode failed: ${detail}`]
      };
    }

    const kind = classifyProtobufContent(content);
    if (kind === 'invalid') {
      // Non-proto bytes in the source set block faithful single-file export.
      return {
        status: 'unsupported',
        authority: 'unsupported-format',
        evidence: [
          ...evidence,
          `Returned source ${normalizedPath} is not valid service/rpc-bearing protobuf`
        ]
      };
    }

    decoded.push({
      originalPath: input.path ?? normalizedPath,
      normalizedPath,
      content,
      serviceBearing: kind === 'service',
      imports: extractProtoImports(content)
    });
  }

  decoded.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
  const serviceBearing = decoded.filter((entry) => entry.serviceBearing);
  const returnedPaths = new Set(decoded.map((entry) => entry.normalizedPath));

  if (serviceBearing.length === 0) {
    if (options.descriptorOnly) {
      return {
        status: 'unsupported',
        authority: 'unsupported-format',
        evidence: [
          ...evidence,
          'Protobuf descriptor set / message-only sources lack a service/rpc entrypoint; not converted'
        ]
      };
    }
    return {
      status: 'unsupported',
      authority: 'unsupported-format',
      evidence: [
        ...evidence,
        'PROTO_NO_SERVICES: protobuf source set defines no service methods; gRPC contract tests require at least one rpc'
      ]
    };
  }

  if (serviceBearing.length > 1) {
    return {
      status: 'unsupported',
      authority: 'unsupported-format',
      evidence: [
        ...evidence,
        `Protobuf source set has ${serviceBearing.length} service/rpc-bearing entrypoints (${serviceBearing
          .map((entry) => entry.normalizedPath)
          .join(', ')}); refusing to merge or guess`
      ]
    };
  }

  const primary = serviceBearing[0]!;
  for (const imp of primary.imports) {
    if (isWellKnownImport(imp)) continue;
    if (importMatchesReturnedSource(imp, returnedPaths)) {
      return {
        status: 'unsupported',
        authority: 'unsupported-format',
        evidence: [
          ...evidence,
          `Protobuf entrypoint ${primary.normalizedPath} imports sibling source ${imp}; bootstrap cannot load proto closure`
        ]
      };
    }
    return {
      status: 'unsupported',
      authority: 'unsupported-format',
      evidence: [
        ...evidence,
        `Protobuf entrypoint ${primary.normalizedPath} has unresolved local import ${imp}`
      ]
    };
  }

  const ignored = decoded
    .filter((entry) => entry.normalizedPath !== primary.normalizedPath)
    .map((entry) => entry.normalizedPath);
  if (ignored.length > 0) {
    evidence.push(
      `Selected sole service/rpc-bearing protobuf entrypoint ${primary.normalizedPath}; ignored non-imported sources (${ignored.join(', ')})`
    );
  } else {
    evidence.push(`Selected sole service/rpc-bearing protobuf entrypoint ${primary.normalizedPath}`);
  }

  return {
    status: 'exportable',
    export: {
      content: primary.content,
      originalPath: primary.originalPath,
      evidence
    }
  };
}
