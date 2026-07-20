import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  type ParsedNode,
  type YAMLMap,
  type YAMLSeq
} from 'yaml';

import { decodeSourceDocument } from '../providers/source-document.js';
import type { SpecCandidate } from '../providers/types.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';

const MAX_SCAN_FILES = 200;
const MAX_SCAN_DEPTH = 6;
/** Referenced raw OpenAPI files: matches the source-document 10 MiB ceiling. */
const MAX_REFERENCED_OPENAPI_BYTES = 10 * 1024 * 1024;
/**
 * Candidate IaC files: finite ceiling large enough for one 10 MiB decoded source
 * as base64 (~13.3 MiB) plus YAML/Terraform envelope.
 */
const MAX_CANDIDATE_IAC_BYTES = 16 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const CANDIDATE_EXTENSIONS = new Set(['.tf', '.json', '.yaml', '.yml']);
const PULUMI_API_CONFIG_TYPES = new Set(['gcp:apigateway:ApiConfig', 'google-native:apigateway/v1:Config']);

export interface IacFingerprint {
  resourceIds: string[];
  serviceNames: string[];
  projectIds: string[];
  evidence: string[];
}

export interface IacScanResult {
  candidates: SpecCandidate[];
  fingerprint: IacFingerprint;
  scannedFiles: string[];
}

interface TerraformBlock {
  type: string;
  name: string;
  body: string;
}

export async function scanGCPIac(repoRoot: string, outputDir: string): Promise<IacScanResult> {
  const resolvedRoot = await realpath(path.resolve(repoRoot)).catch(() => path.resolve(repoRoot));
  const outputRoot = path.resolve(resolvedRoot, outputDir);
  const scannedFiles = await collectIacFiles(resolvedRoot, resolvedRoot, outputRoot);
  const candidates = new Map<string, SpecCandidate>();
  const fingerprint: IacFingerprint = { resourceIds: [], serviceNames: [], projectIds: [], evidence: [] };

  for (const relativePath of scannedFiles) {
    const extension = path.extname(relativePath).toLowerCase();
    const content = await readUtf8WithinByteCeiling(
      path.join(resolvedRoot, relativePath),
      MAX_CANDIDATE_IAC_BYTES
    );
    if (!content) continue;
    if (extension === '.tf') {
      for (const block of extractTerraformResourceBlocks(content)) {
        if (block.type === 'google_api_gateway_api_config') {
          const apiName = literalAssignment(block.body, 'api');
          if (apiName) fingerprint.serviceNames.push(apiName);
          for (const reference of gatewayOpenApiDocumentPaths(block.body)) {
            await addReferencedDocument(resolvedRoot, relativePath, block, reference, candidates, fingerprint);
          }
        }
        if (block.type === 'google_endpoints_service') {
          const serviceName = literalAssignment(block.body, 'service_name');
          if (serviceName) fingerprint.serviceNames.push(serviceName);
          for (const reference of fileFunctionAssignments(block.body, 'openapi_config')) {
            await addReferencedDocument(resolvedRoot, relativePath, block, reference, candidates, fingerprint);
          }
          const inline = heredocAssignment(block.body, 'openapi_config');
          if (inline) addInlineDocument(relativePath, block, inline, candidates, fingerprint);
        }
        const project = literalAssignment(block.body, 'project');
        if (project) fingerprint.projectIds.push(project);
      }
      continue;
    }
    if (extension === '.yaml' || extension === '.yml') {
      extractPulumiYamlDocuments(relativePath, content, candidates, fingerprint);
    }
  }

  return {
    candidates: [...candidates.values()],
    fingerprint: {
      resourceIds: [...new Set(fingerprint.resourceIds)],
      serviceNames: [...new Set(fingerprint.serviceNames)],
      projectIds: [...new Set(fingerprint.projectIds)],
      evidence: [...new Set(fingerprint.evidence)]
    },
    scannedFiles
  };
}

/**
 * Fail-soft bounded read: skip before read/parse when pre-read size exceeds
 * `maxBytes`, or when the path is unreadable / not a regular file.
 */
async function readUtf8WithinByteCeiling(
  absolutePath: string,
  maxBytes: number
): Promise<string | undefined> {
  const stat = await lstat(absolutePath).catch(() => undefined);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return undefined;
  if (stat.size > maxBytes) return undefined;
  return readFile(absolutePath, 'utf8').catch(() => undefined);
}

async function collectIacFiles(
  root: string,
  current: string,
  outputRoot: string,
  depth = 0,
  count = { value: 0 }
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH || count.value >= MAX_SCAN_FILES) return [];
  const results: string[] = [];
  const entries = (await readdir(current).catch(() => [] as string[])).sort();
  for (const entry of entries) {
    if (count.value >= MAX_SCAN_FILES) break;
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = path.join(current, entry);
    if (fullPath === outputRoot || fullPath.startsWith(`${outputRoot}${path.sep}`)) continue;
    const stat = await lstat(fullPath).catch(() => undefined);
    if (!stat || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      results.push(...await collectIacFiles(root, fullPath, outputRoot, depth + 1, count));
      continue;
    }
    if (!stat.isFile() || !CANDIDATE_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
    count.value += 1;
    results.push(path.relative(root, fullPath).split(path.sep).join('/'));
  }
  return results;
}

function extractTerraformResourceBlocks(content: string): TerraformBlock[] {
  const blocks: TerraformBlock[] = [];
  const header = /resource\s+"(google_api_gateway_api_config|google_endpoints_service)"\s+"([A-Za-z0-9_-]+)"\s*\{/g;
  for (let match = header.exec(content); match; match = header.exec(content)) {
    const start = header.lastIndex;
    const end = matchingBrace(content, start);
    if (end === undefined) continue;
    blocks.push({ type: match[1]!, name: match[2]!, body: content.slice(start, end) });
    header.lastIndex = end + 1;
  }
  return blocks;
}

/**
 * Exact provider field path: openapi_documents { document { path = "..." } }.
 * Unrelated `path` attributes elsewhere in the resource never become candidates.
 */
function gatewayOpenApiDocumentPaths(body: string): string[] {
  const paths: string[] = [];
  for (const openapiDocumentsBody of namedBlocks(body, 'openapi_documents')) {
    for (const documentBody of namedBlocks(openapiDocumentsBody, 'document')) {
      paths.push(...literalAssignments(documentBody, 'path'));
    }
  }
  return paths;
}

function namedBlocks(content: string, blockName: string): string[] {
  const bodies: string[] = [];
  let index = 0;
  while (index < content.length) {
    const header = findBlockHeader(content, blockName, index);
    if (!header) break;
    const end = matchingBrace(content, header.bodyStart);
    if (end === undefined) {
      index = header.bodyStart;
      continue;
    }
    bodies.push(content.slice(header.bodyStart, end));
    index = end + 1;
  }
  return bodies;
}

function findBlockHeader(
  content: string,
  blockName: string,
  from: number
): { bodyStart: number } | undefined {
  let index = from;
  while (index < content.length) {
    const skipped = skipTrivia(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (isIdentifierAt(content, index, blockName)) {
      const afterName = index + blockName.length;
      if (isIdentifierChar(content[afterName])) {
        index += 1;
        continue;
      }
      const afterTrivia = skipTrivia(content, afterName);
      if (content[afterTrivia] === '{') {
        return { bodyStart: afterTrivia + 1 };
      }
    }
    if (content[index] === '"' || content[index] === "'") {
      index = skipString(content, index);
      continue;
    }
    index += 1;
  }
  return undefined;
}

function isIdentifierAt(content: string, index: number, name: string): boolean {
  if (!content.startsWith(name, index)) return false;
  if (index > 0 && isIdentifierChar(content[index - 1]!)) return false;
  return true;
}

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function skipTrivia(content: string, start: number): number {
  let index = start;
  while (index < content.length) {
    const char = content[index]!;
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      index += 1;
      continue;
    }
    if (char === '#' || (char === '/' && content[index + 1] === '/')) {
      index = skipLineComment(content, index);
      continue;
    }
    if (char === '/' && content[index + 1] === '*') {
      index = skipBlockComment(content, index);
      continue;
    }
    break;
  }
  return index;
}

function skipLineComment(content: string, start: number): number {
  let index = start;
  while (index < content.length && content[index] !== '\n') index += 1;
  return index;
}

function skipBlockComment(content: string, start: number): number {
  let index = start + 2;
  while (index < content.length) {
    if (content[index] === '*' && content[index + 1] === '/') return index + 2;
    index += 1;
  }
  return content.length;
}

function skipString(content: string, start: number): number {
  const quote = content[start];
  let index = start + 1;
  let escaped = false;
  while (index < content.length) {
    const char = content[index]!;
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === quote) {
      return index + 1;
    }
    index += 1;
  }
  return content.length;
}

function matchingBrace(content: string, start: number): number | undefined {
  let depth = 1;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '#' || (char === '/' && content[index + 1] === '/')) {
      index = skipLineComment(content, index) - 1;
      continue;
    }
    if (char === '/' && content[index + 1] === '*') {
      index = skipBlockComment(content, index) - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function literalAssignment(body: string, key: string): string | undefined {
  return literalAssignments(body, key)[0];
}

function literalAssignments(body: string, key: string): string[] {
  const expression = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"\\n]+)"`, 'g');
  return [...body.matchAll(expression)]
    .map((match) => match[1]!)
    .filter((value) => !value.includes('${') && !/^[a-z]+:\/\//i.test(value));
}

function fileFunctionAssignments(body: string, key: string): string[] {
  const expression = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*file(?:base64)?\\(\\s*"([^"\\n]+)"\\s*\\)`, 'g');
  return [...body.matchAll(expression)]
    .map((match) => match[1]!)
    .filter((value) => !value.includes('${'));
}

function heredocAssignment(body: string, key: string): string | undefined {
  const expression = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*<<-?([A-Za-z0-9_]+)\\r?\\n([\\s\\S]*?)\\r?\\n\\s*\\1(?:\\r?\\n|$)`);
  const match = expression.exec(body);
  return match && !match[2]!.includes('${') ? match[2] : undefined;
}

async function addReferencedDocument(
  root: string,
  terraformPath: string,
  block: TerraformBlock,
  reference: string,
  candidates: Map<string, SpecCandidate>,
  fingerprint: IacFingerprint
): Promise<void> {
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(terraformPath), reference.split(path.sep).join('/')));
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return;
  const absolute = path.join(root, relative);
  const resolved = await realpath(absolute).catch(() => undefined);
  if (!resolved || !(resolved === root || resolved.startsWith(`${root}${path.sep}`))) return;
  const content = await readUtf8WithinByteCeiling(resolved, MAX_REFERENCED_OPENAPI_BYTES);
  if (!content) return;
  try {
    const parsed = parseAndValidateOpenApi(content);
    const id = `${terraformPath}#${block.type}.${block.name}:${relative}`;
    candidates.set(relative, {
      id,
      name: block.name,
      providerType: 'iac-local',
      sourceType: 'iac-embedded',
      authority: 'stored-authoritative',
      tags: {},
      supported: true,
      evidence: [`Terraform ${block.type}.${block.name} references confined OpenAPI file ${relative}`],
      meta: {
        relativePath: relative,
        inlineContent: `${content.replace(/(?:\r?\n)+$/, '')}\n`,
        inlineFormat: parsed.isJson ? 'openapi-json' : 'openapi-yaml'
      }
    });
    fingerprint.resourceIds.push(id);
    fingerprint.serviceNames.push(block.name);
    fingerprint.evidence.push(`GCP IaC references ${relative}`);
  } catch {
    fingerprint.evidence.push(`GCP IaC reference ${relative} is not a valid OpenAPI document`);
  }
}

function addInlineDocument(
  terraformPath: string,
  block: TerraformBlock,
  content: string,
  candidates: Map<string, SpecCandidate>,
  fingerprint: IacFingerprint
): void {
  try {
    const parsed = parseAndValidateOpenApi(content);
    const key = `${terraformPath}#${block.type}.${block.name}`;
    candidates.set(key, {
      id: key,
      name: block.name,
      providerType: 'iac-local',
      sourceType: 'iac-embedded',
      authority: 'stored-authoritative',
      tags: {},
      supported: true,
      evidence: [`Terraform ${block.type}.${block.name} contains literal OpenAPI configuration`],
      meta: {
        relativePath: terraformPath,
        inlineContent: `${content.replace(/(?:\r?\n)+$/, '')}\n`,
        inlineFormat: parsed.isJson ? 'openapi-json' : 'openapi-yaml'
      }
    });
    fingerprint.resourceIds.push(key);
    fingerprint.serviceNames.push(block.name);
  } catch {
    fingerprint.evidence.push(`Terraform ${block.type}.${block.name} inline config is not valid OpenAPI`);
  }
}

/**
 * Declarative Pulumi YAML only (`runtime: yaml`). Supports literal base64
 * `properties.openapiDocuments[].document.contents` on
 * `gcp:apigateway:ApiConfig` and `google-native:apigateway/v1:Config`.
 * Never executes Pulumi, never follows path/asset/fn:: references.
 */
function extractPulumiYamlDocuments(
  relativePath: string,
  content: string,
  candidates: Map<string, SpecCandidate>,
  fingerprint: IacFingerprint
): void {
  let documents;
  try {
    documents = parseAllDocuments(content, { merge: false, prettyErrors: false });
  } catch {
    return;
  }
  const nonEmpty = documents.filter((document) => document.contents != null);
  if (nonEmpty.length === 0) return;
  if (nonEmpty.length > 1) {
    fingerprint.evidence.push(`Pulumi YAML ${relativePath} has multiple documents; refusing ambiguous parse`);
    return;
  }
  const document = nonEmpty[0]!;
  if (document.errors.length > 0) return;
  const root = document.contents;
  if (!isMap(root) || mapHasMergeKey(root) || mapHasFnKey(root)) return;
  if (!isYamlRuntime(mapGet(root, 'runtime'))) return;
  const resourcesNode = mapGet(root, 'resources');
  if (!isMap(resourcesNode) || mapHasMergeKey(resourcesNode) || mapHasFnKey(resourcesNode)) return;

  for (const item of resourcesNode.items) {
    if (!isPair(item)) continue;
    const resourceName = scalarString(item.key);
    if (!resourceName || !isMap(item.value) || mapHasMergeKey(item.value) || mapHasFnKey(item.value)) continue;
    const resourceType = scalarString(mapGet(item.value, 'type'));
    if (!resourceType || !PULUMI_API_CONFIG_TYPES.has(resourceType)) continue;
    const properties = mapGet(item.value, 'properties');
    if (!isMap(properties) || mapHasMergeKey(properties) || mapHasFnKey(properties)) continue;

    const project = literalFingerprintString(mapGet(properties, 'project'));
    if (project) fingerprint.projectIds.push(project);
    const api = literalFingerprintString(mapGet(properties, 'api'))
      ?? literalFingerprintString(mapGet(properties, 'apiId'));
    if (api) fingerprint.serviceNames.push(api);
    fingerprint.serviceNames.push(resourceName);

    const openapiDocuments = mapGet(properties, 'openapiDocuments');
    if (!isSeq(openapiDocuments)) continue;
    if (seqHasFnOrMerge(openapiDocuments)) continue;

    openapiDocuments.items.forEach((entry, index) => {
      addPulumiOpenApiDocument(
        relativePath,
        resourceType,
        resourceName,
        index,
        entry,
        candidates,
        fingerprint
      );
    });
  }
}

function addPulumiOpenApiDocument(
  relativePath: string,
  resourceType: string,
  resourceName: string,
  index: number,
  entry: ParsedNode | null | undefined,
  candidates: Map<string, SpecCandidate>,
  fingerprint: IacFingerprint
): void {
  if (!isMap(entry) || mapHasMergeKey(entry) || mapHasFnKey(entry)) return;
  const documentNode = mapGet(entry, 'document');
  if (!isMap(documentNode) || mapHasMergeKey(documentNode) || mapHasFnKey(documentNode)) return;

  const pathNode = mapGet(documentNode, 'path');
  const contentsNode = mapGet(documentNode, 'contents');
  if (contentsNode == null) return;
  if (isAlias(contentsNode) || isAlias(pathNode)) {
    fingerprint.evidence.push(
      `Pulumi ${resourceType}.${resourceName} openapiDocuments/${index} uses YAML alias; ignored`
    );
    return;
  }
  if (!isScalar(contentsNode) || typeof contentsNode.value !== 'string') {
    fingerprint.evidence.push(
      `Pulumi ${resourceType}.${resourceName} openapiDocuments/${index} contents is not a literal scalar; ignored`
    );
    return;
  }
  const encoded = contentsNode.value;
  if (encoded.includes('${') || /^[a-z][a-z0-9+.-]*:\/\//i.test(encoded) || encoded.includes('fn::')) {
    fingerprint.evidence.push(
      `Pulumi ${resourceType}.${resourceName} openapiDocuments/${index} contents is nonliteral; ignored`
    );
    return;
  }

  const id = `${relativePath}#${resourceType}.${resourceName}:openapiDocuments/${index}`;
  try {
    const decoded = decodeSourceDocument(encoded);
    candidates.set(id, {
      id,
      name: resourceName,
      providerType: 'iac-local',
      sourceType: 'iac-embedded',
      authority: 'stored-authoritative',
      tags: {},
      supported: true,
      evidence: [`Pulumi ${resourceType}.${resourceName} contains literal OpenAPI document`],
      meta: {
        relativePath,
        inlineContent: decoded.content,
        inlineFormat: decoded.format
      }
    });
    fingerprint.resourceIds.push(id);
    fingerprint.evidence.push(`GCP IaC embeds OpenAPI from ${relativePath}#${resourceName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid OpenAPI contents';
    if (/base64|exceeds|UTF-8/i.test(message)) {
      fingerprint.evidence.push(
        `Pulumi ${resourceType}.${resourceName} openapiDocuments/${index} contents is not valid base64 or exceeds size limit`
      );
    } else {
      fingerprint.evidence.push(
        `Pulumi ${resourceType}.${resourceName} openapiDocuments/${index} contents is not a valid OpenAPI document`
      );
    }
  }
}

function isYamlRuntime(node: ParsedNode | null | undefined): boolean {
  if (isScalar(node) && node.value === 'yaml') return true;
  if (!isMap(node) || mapHasMergeKey(node) || mapHasFnKey(node)) return false;
  return scalarString(mapGet(node, 'name')) === 'yaml';
}

function literalFingerprintString(node: ParsedNode | null | undefined): string | undefined {
  const value = scalarString(node);
  if (!value || value.includes('${') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  return value;
}

function scalarString(node: unknown): string | undefined {
  if (isAlias(node) || !isScalar(node) || typeof node.value !== 'string') return undefined;
  return node.value;
}

function mapGet(map: YAMLMap, key: string): ParsedNode | null | undefined {
  for (const item of map.items) {
    if (!isPair(item)) continue;
    if (scalarString(item.key) === key) return item.value as ParsedNode | null | undefined;
  }
  return undefined;
}

function mapHasMergeKey(map: YAMLMap): boolean {
  return map.items.some((item) => isPair(item) && scalarString(item.key) === '<<');
}

function mapHasFnKey(map: YAMLMap): boolean {
  return map.items.some((item) => {
    if (!isPair(item)) return false;
    const key = scalarString(item.key);
    return Boolean(key?.startsWith('fn::'));
  });
}

function seqHasFnOrMerge(seq: YAMLSeq): boolean {
  return seq.items.some((item) => isMap(item) && (mapHasFnKey(item) || mapHasMergeKey(item)));
}
