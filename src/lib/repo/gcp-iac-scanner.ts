import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SpecCandidate } from '../providers/types.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';

const MAX_SCAN_FILES = 200;
const MAX_SCAN_DEPTH = 6;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const CANDIDATE_EXTENSIONS = new Set(['.tf', '.json', '.yaml', '.yml']);

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
    if (path.extname(relativePath).toLowerCase() !== '.tf') continue;
    const content = await readFile(path.join(resolvedRoot, relativePath), 'utf8').catch(() => undefined);
    if (!content) continue;
    for (const block of extractTerraformResourceBlocks(content)) {
      if (block.type === 'google_api_gateway_api_config') {
        const apiName = literalAssignment(block.body, 'api');
        if (apiName) fingerprint.serviceNames.push(apiName);
        for (const reference of literalAssignments(block.body, 'path')) {
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
  const content = await readFile(resolved, 'utf8').catch(() => undefined);
  if (!content) return;
  try {
    const parsed = parseAndValidateOpenApi(content);
    const id = `${terraformPath}#${block.type}.${block.name}:${relative}`;
    candidates.set(relative, {
      id,
      name: block.name,
      providerType: 'iac-local',
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
