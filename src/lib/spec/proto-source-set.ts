import type { SourceAuthority } from '../../contracts.js';
import { decodeBoundedBase64Utf8 } from '../providers/source-document.js';
import { parseAndValidateNativeFamily } from './native-formats.js';

/**
 * Shared protobuf entrypoint selection for cloud source sets
 * (API Gateway grpcServices[].source[] and Service Management PROTO_FILE).
 *
 * Complete provider-owned sets with sibling imports are retained as a full
 * inventory. Missing imports, multiple roots, unsafe/colliding paths, and
 * descriptor-only data remain unsupported. Never concatenates or converts.
 *
 * Provider input count, per-member/aggregate UTF-8 bytes, and importer-aware
 * closure depth are bounded to bootstrap/PRD definition-bundle ceilings.
 */

export interface ProtoSourceFileInput {
  /** Original returned path (API Gateway File.path / ConfigFile.filePath). */
  path?: string;
  /** Base64 file bytes. */
  contentsBase64?: string;
}

/**
 * Bootstrap/PRD definition-bundle ceilings for provider protobuf source sets.
 * maxFiles counts the service/rpc root plus dependencies (101 total including root).
 * The shared 10 MiB base64 decoder may remain stricter than maxBytesPerFile.
 */
export const PROTO_SOURCE_SET_LIMITS = {
  maxFiles: 101,
  maxDepth: 20,
  maxBytesPerFile: 25 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024
} as const;

export type ProtoSourceSetLimits = {
  maxFiles: number;
  maxDepth: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
};

/** Test-only overrides; production callers omit these. Values cannot exceed PRD defaults. */
export type ProtoSourceSetLimitOverrides = Partial<ProtoSourceSetLimits>;

export function resolveProtoSourceSetLimits(
  overrides?: ProtoSourceSetLimitOverrides
): ProtoSourceSetLimits {
  const clamp = (value: number | undefined, ceiling: number, floor: number): number => {
    const raw = value === undefined ? ceiling : Math.floor(value);
    if (!Number.isFinite(raw)) return ceiling;
    return Math.min(Math.max(raw, floor), ceiling);
  };
  return {
    maxFiles: clamp(overrides?.maxFiles, PROTO_SOURCE_SET_LIMITS.maxFiles, 1),
    maxDepth: clamp(overrides?.maxDepth, PROTO_SOURCE_SET_LIMITS.maxDepth, 0),
    maxBytesPerFile: clamp(overrides?.maxBytesPerFile, PROTO_SOURCE_SET_LIMITS.maxBytesPerFile, 1),
    maxTotalBytes: clamp(overrides?.maxTotalBytes, PROTO_SOURCE_SET_LIMITS.maxTotalBytes, 1)
  };
}

export interface ProtoSourceSetOptions {
  /** True when a descriptor set is present without usable .proto sources. */
  descriptorOnly?: boolean;
  /** Evidence prefix lines (config identity, etc.). */
  evidencePrefix?: string[];
  /** Injectable ceilings for tests; cannot raise production PRD defaults. */
  limits?: ProtoSourceSetLimitOverrides;
}

export interface ProtoSourceMember {
  content: string;
  originalPath: string;
  normalizedPath: string;
  role: 'root' | 'dependency';
}

export interface ProtoSourceExport {
  content: string;
  originalPath: string;
  rootPath: string;
  completeness: 'full';
  members: ProtoSourceMember[];
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
  byteLength: number;
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
 * Locale-independent path identity key (NFC + fixed-locale case fold).
 * Used only for collision detection; never replaces emitted provider paths.
 */
export function caseFoldPathKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

/**
 * Path-safe relative key. Rejects absolute paths, empty segments, and `..`.
 * Returns NFC form when the path can be used as an authoritative source key.
 */
export function normalizeProtoSourcePath(path: string | undefined): string | undefined {
  if (!path || !path.trim()) return undefined;
  const normalized = path.trim().replace(/\\/g, '/').normalize('NFC');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0')) {
    return undefined;
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return undefined;
  }
  return parts.join('/');
}

function dirnameOfNormalized(normalizedPath: string): string {
  const idx = normalizedPath.lastIndexOf('/');
  return idx === -1 ? '' : normalizedPath.slice(0, idx);
}

/**
 * Resolve an import to a returned provider member by exact identity only:
 * 1) exact provider-root key (normalized import path), or
 * 2) exact key relative to the importing member's normalized directory.
 * Never guesses by basename or path suffix.
 */
function resolveImportToReturnedSource(
  imp: string,
  importerNormalizedPath: string,
  byNormalized: ReadonlyMap<string, DecodedProtoEntry>
): DecodedProtoEntry | undefined {
  const asRootKey = normalizeProtoSourcePath(imp);
  if (asRootKey) {
    const exact = byNormalized.get(asRootKey);
    if (exact) return exact;
  }

  const importerDir = dirnameOfNormalized(importerNormalizedPath);
  const joined = importerDir ? `${importerDir}/${imp}` : imp;
  const relativeKey = normalizeProtoSourcePath(joined);
  if (relativeKey && relativeKey !== asRootKey) {
    const relative = byNormalized.get(relativeKey);
    if (relative) return relative;
  }

  return undefined;
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

function unsupportedLimit(
  evidence: string[],
  detail: string
): Extract<ProtoSourceSetResolution, { status: 'unsupported' }> {
  return {
    status: 'unsupported',
    authority: 'unsupported-format',
    evidence: [...evidence, detail]
  };
}

/**
 * Importer-aware closure: carry hop depth, dedupe before limit checks so cycles
 * and duplicate edges are allowed once, then enforce unique file/depth/byte ceilings.
 */
function collectClosure(
  root: DecodedProtoEntry,
  byNormalized: ReadonlyMap<string, DecodedProtoEntry>,
  limits: ProtoSourceSetLimits
):
  | { members: ProtoSourceMember[] }
  | { missing: string }
  | { limitExceeded: string } {
  if (root.byteLength > limits.maxBytesPerFile) {
    return {
      limitExceeded: `Protobuf source ${root.normalizedPath} exceeds maxBytesPerFile=${limits.maxBytesPerFile}`
    };
  }
  if (root.byteLength > limits.maxTotalBytes) {
    return {
      limitExceeded: `Protobuf source set decoded UTF-8 bytes exceed maxTotalBytes=${limits.maxTotalBytes}`
    };
  }

  const ordered: ProtoSourceMember[] = [
    {
      content: root.content,
      originalPath: root.originalPath,
      normalizedPath: root.normalizedPath,
      role: 'root'
    }
  ];
  const seen = new Set<string>([root.normalizedPath]);
  let totalBytes = root.byteLength;
  const queue: Array<{ imp: string; importerPath: string; depth: number }> = root.imports.map(
    (imp) => ({
      imp,
      importerPath: root.normalizedPath,
      depth: 1
    })
  );

  while (queue.length > 0) {
    const { imp, importerPath, depth } = queue.shift()!;
    if (isWellKnownImport(imp)) continue;
    const matched = resolveImportToReturnedSource(imp, importerPath, byNormalized);
    if (!matched) {
      return { missing: imp };
    }
    // Dedupe before depth/file/byte enforcement so cycles never false-positive.
    if (seen.has(matched.normalizedPath)) continue;

    if (depth > limits.maxDepth) {
      return {
        limitExceeded: `Protobuf import closure depth exceeded maxDepth=${limits.maxDepth} at ${matched.normalizedPath}`
      };
    }
    // maxFiles includes the root; next unique member would exceed the ceiling.
    if (seen.size >= limits.maxFiles) {
      return {
        limitExceeded: `Protobuf import closure exceeds maxFiles=${limits.maxFiles} (including root) at ${matched.normalizedPath}`
      };
    }
    if (
      matched.byteLength > limits.maxBytesPerFile ||
      totalBytes + matched.byteLength > limits.maxTotalBytes
    ) {
      return {
        limitExceeded: `Protobuf import closure decoded UTF-8 bytes exceed maxTotalBytes=${limits.maxTotalBytes} (or maxBytesPerFile=${limits.maxBytesPerFile}) at ${matched.normalizedPath}`
      };
    }

    seen.add(matched.normalizedPath);
    totalBytes += matched.byteLength;
    ordered.push({
      content: matched.content,
      originalPath: matched.originalPath,
      normalizedPath: matched.normalizedPath,
      role: 'dependency'
    });
    for (const nextImp of matched.imports) {
      queue.push({
        imp: nextImp,
        importerPath: matched.normalizedPath,
        depth: depth + 1
      });
    }
  }

  // Keep root first; path-sort dependencies only.
  const rootMember = ordered.find((member) => member.role === 'root')!;
  const deps = ordered
    .filter((member) => member.role === 'dependency')
    .sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
  return { members: [rootMember, ...deps] };
}

/**
 * Resolve a returned protobuf source set to a bootstrap-exportable entrypoint.
 * Complete sibling-import closures are returned as a full member inventory.
 * Never concatenates or rewrites bytes.
 */
export function resolveProtoSourceSet(
  inputs: ProtoSourceFileInput[],
  options: ProtoSourceSetOptions = {}
): ProtoSourceSetResolution {
  const evidence = [...(options.evidencePrefix ?? [])];
  const limits = resolveProtoSourceSetLimits(options.limits);

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

  // Reject before any decode when the provider set already exceeds the file ceiling.
  if (inputs.length > limits.maxFiles) {
    return unsupportedLimit(
      evidence,
      `Protobuf source set has ${inputs.length} files which exceeds maxFiles=${limits.maxFiles} (including root); refusing unbounded decode`
    );
  }

  const decoded: DecodedProtoEntry[] = [];
  /** Identity key (NFC + case fold) -> first accepted NFC path. */
  const identitySeen = new Map<string, string>();
  let totalDecodedBytes = 0;

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
    const identityKey = caseFoldPathKey(normalizedPath);
    const prior = identitySeen.get(identityKey);
    if (prior) {
      return {
        status: 'unsupported',
        authority: 'unsupported-format',
        evidence: [
          ...evidence,
          `Protobuf source paths collide at ${normalizedPath} (identity ${prior}); refusing to merge or guess`
        ]
      };
    }
    identitySeen.set(identityKey, normalizedPath);

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

    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > limits.maxBytesPerFile) {
      return unsupportedLimit(
        evidence,
        `Protobuf source ${normalizedPath} exceeds maxBytesPerFile=${limits.maxBytesPerFile}`
      );
    }
    if (totalDecodedBytes + byteLength > limits.maxTotalBytes) {
      return unsupportedLimit(
        evidence,
        `Protobuf source set decoded UTF-8 bytes exceed maxTotalBytes=${limits.maxTotalBytes}`
      );
    }
    totalDecodedBytes += byteLength;

    const kind = classifyProtobufContent(content);
    if (kind === 'invalid') {
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
      imports: extractProtoImports(content),
      byteLength
    });
  }

  decoded.sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
  const serviceBearing = decoded.filter((entry) => entry.serviceBearing);
  const byNormalized = new Map(decoded.map((entry) => [entry.normalizedPath, entry]));

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
  const closure = collectClosure(primary, byNormalized, limits);
  if ('missing' in closure) {
    return {
      status: 'unsupported',
      authority: 'unsupported-format',
      evidence: [
        ...evidence,
        `Protobuf entrypoint ${primary.normalizedPath} has unresolved local import ${closure.missing}`
      ]
    };
  }
  if ('limitExceeded' in closure) {
    return unsupportedLimit(evidence, closure.limitExceeded);
  }

  const closurePaths = new Set(closure.members.map((member) => member.normalizedPath));
  const ignored = decoded
    .filter((entry) => !closurePaths.has(entry.normalizedPath))
    .map((entry) => entry.normalizedPath);
  if (ignored.length > 0) {
    evidence.push(
      `Selected sole service/rpc-bearing protobuf entrypoint ${primary.normalizedPath}; ignored non-imported sources (${ignored.join(', ')})`
    );
  } else if (closure.members.length > 1) {
    evidence.push(
      `Selected sole service/rpc-bearing protobuf entrypoint ${primary.normalizedPath} with ${closure.members.length - 1} provider dependency(ies)`
    );
  } else {
    evidence.push(`Selected sole service/rpc-bearing protobuf entrypoint ${primary.normalizedPath}`);
  }

  return {
    status: 'exportable',
    export: {
      content: primary.content,
      originalPath: primary.originalPath,
      rootPath: primary.normalizedPath,
      completeness: 'full',
      members: closure.members,
      evidence
    }
  };
}
