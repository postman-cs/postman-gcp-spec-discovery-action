import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { SpecFormat } from '../../contracts.js';
import { detectNativeFormat, isOpenApiFormat, parseAndValidateNativeSpec } from '../spec/native-formats.js';

const DIRECT_SPEC_CANDIDATES = [
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'api.yaml',
  'api.yml',
  'api.json',
  'oas.yaml',
  'oas.yml',
  'oas.json',
  'swagger.yaml',
  'swagger.yml',
  'swagger.json',
  'asyncapi.yaml',
  'asyncapi.yml',
  'asyncapi.json',
  'schema.graphql',
  'schema.graphqls',
  'schema.gql',
  'introspection.json',
  'service.proto',
  'schema.proto',
  'service.wsdl',
  'api.wsdl',
  'mcp.json',
  'spec/openapi.yaml',
  'spec/openapi.yml',
  'spec/openapi.json',
  'api/openapi.yaml',
  'api/openapi.yml',
  'api/openapi.json',
  'docs/openapi.yaml',
  'docs/openapi.yml',
  'docs/openapi.json',
  'spec/asyncapi.yaml',
  'spec/asyncapi.yml',
  'spec/asyncapi.json',
  'spec/schema.graphql',
  'spec/service.proto',
  'spec/service.wsdl',
  'spec/mcp.json'
];

const COMMON_SCAN_DIRS = [
  '.',
  'api',
  'apis',
  'api-docs',
  'docs',
  'reference',
  'public',
  'spec',
  'specs',
  'contracts',
  'services',
  'packages',
  'apps',
  'proto',
  'protos',
  'graphql',
  'schemas'
];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.terraform',
  'dist',
  'build',
  'discovered-specs',
  'vendor',
  'test',
  'tests',
  '__pycache__',
  '.venv',
  'venv',
  '.pulumi'
]);

const MAX_SPEC_SCAN_FILES = 200;
const MAX_SPEC_SCAN_DEPTH = 6;

export interface RepoSpecMatch {
  path: string;
  format: SpecFormat;
  evidence?: string[];
  /** Set when two or more valid documents tie at the same precedence score. */
  ambiguousPaths?: string[];
}

function isLikelyNativeSpec(content: string): SpecFormat | undefined {
  const detected = detectNativeFormat(content);
  if (!detected) return undefined;
  try {
    const validated = parseAndValidateNativeSpec(content, detected.format);
    return validated.format;
  } catch {
    return undefined;
  }
}

export async function findExistingRepoSpec(repoRoot: string): Promise<string | undefined> {
  const match = await findExistingRepoSpecTyped(repoRoot);
  return match?.path;
}

export async function findExistingRepoSpecTyped(repoRoot: string): Promise<RepoSpecMatch | undefined> {
  const candidates = await collectSpecCandidates(repoRoot);
  const valid: Array<{ path: string; score: number; format: SpecFormat }> = [];
  for (const candidate of candidates) {
    const fullPath = path.resolve(repoRoot, candidate);
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile()) {
        continue;
      }
      const content = await readFile(fullPath, 'utf8');
      const format = isLikelyNativeSpec(content);
      if (format) {
        valid.push({
          path: candidate.replace(/\\/g, '/'),
          score: specCandidateScore(candidate),
          format
        });
      }
    } catch {
      // Continue search.
    }
  }
  if (valid.length === 0) return undefined;

  valid.sort(
    (left, right) =>
      right.score - left.score ||
      Number(isOpenApiFormat(right.format)) - Number(isOpenApiFormat(left.format)) ||
      left.path.localeCompare(right.path)
  );
  const top = valid[0]!;
  const tied = valid.filter((match) => match.score === top.score);
  if (tied.length > 1) {
    // OpenAPI precedence: a unique OpenAPI document at the top score beats native peers.
    const openApiTied = tied.filter((match) => isOpenApiFormat(match.format));
    if (openApiTied.length === 1) {
      const preferred = openApiTied[0]!;
      return {
        path: preferred.path,
        format: preferred.format,
        evidence: [`Resolved from repository specification ${preferred.path}`]
      };
    }
    return {
      path: top.path,
      format: top.format,
      ambiguousPaths: tied.map((match) => match.path),
      evidence: [`Repository contains ${tied.length} equally ranked specification documents; refusing to guess between them`]
    };
  }
  return {
    path: top.path,
    format: top.format,
    evidence: [`Resolved from repository specification ${top.path}`]
  };
}

function isSpecLikeFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (/^(openapi|swagger|api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(lower)) return true;
  if (/^(asyncapi)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(lower)) return true;
  if (/\.(?:wsdl|proto|graphql|graphqls|gql)$/.test(lower)) return true;
  if (/^(schema|service|api)\.(?:graphql|graphqls|gql|proto|wsdl)$/.test(lower)) return true;
  if (/^(introspection|mcp|server)\.json$/.test(lower)) return true;
  return false;
}

async function collectSpecCandidates(repoRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  for (const candidate of DIRECT_SPEC_CANDIDATES) {
    candidates.add(candidate);
  }

  const count = { value: 0 };
  for (const dir of COMMON_SCAN_DIRS) {
    const root = path.resolve(repoRoot, dir);
    const fileStat = await stat(root).catch(() => undefined);
    if (!fileStat) continue;
    if (fileStat.isFile()) {
      const relative = path.relative(repoRoot, root);
      if (isSpecLikeFilename(path.basename(relative))) {
        candidates.add(relative);
      }
      continue;
    }
    if (!fileStat.isDirectory()) continue;
    for (const file of await walkSpecCandidates(repoRoot, root, count)) {
      candidates.add(file);
    }
    if (count.value >= MAX_SPEC_SCAN_FILES) break;
  }

  return [...candidates].sort(
    (left, right) => specCandidateScore(right) - specCandidateScore(left) || left.localeCompare(right)
  );
}

async function walkSpecCandidates(repoRoot: string, current: string, count: { value: number }, depth = 0): Promise<string[]> {
  if (depth > MAX_SPEC_SCAN_DEPTH || count.value >= MAX_SPEC_SCAN_FILES) return [];
  const results: string[] = [];
  const entries = await readdir(current).catch(() => [] as string[]);
  for (const entry of entries) {
    if (count.value >= MAX_SPEC_SCAN_FILES) break;
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = path.join(current, entry);
    const info = await stat(fullPath).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      results.push(...await walkSpecCandidates(repoRoot, fullPath, count, depth + 1));
      continue;
    }
    if (info.isFile() && isSpecLikeFilename(entry)) {
      count.value += 1;
      results.push(path.relative(repoRoot, fullPath));
    }
  }
  return results;
}

function specCandidateScore(candidate: string): number {
  const normalized = candidate.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(normalized);
  let score = 0;
  if (DIRECT_SPEC_CANDIDATES.includes(normalized)) score += 200;
  // OpenAPI filenames outrank other native families (OpenAPI precedence).
  if (/^(openapi|swagger)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 90;
  else if (/^(asyncapi)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 88;
  else if (/^(api|oas)(?:[.-]v?\d+(?:\.\d+)*)?\.(?:ya?ml|json)$/.test(basename)) score += 85;
  else if (/^(schema|service|api)\.(?:graphql|graphqls|gql|proto|wsdl)$/.test(basename)) score += 70;
  else if (/\.(?:wsdl|proto|graphql|graphqls|gql)$/.test(basename)) score += 70;
  else if (/^(introspection|mcp|server)\.json$/.test(basename)) score += 65;
  if (/^(api|apis|spec|specs|contracts|reference|public|proto|protos|graphql|schemas)\//.test(normalized)) score += 20;
  if (/^(services|packages|apps)\/[^/]+\//.test(normalized)) score += 15;
  return score;
}
