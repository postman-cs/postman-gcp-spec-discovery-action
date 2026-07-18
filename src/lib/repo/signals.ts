import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { findIaCFiles } from './scan.js';

export interface RepoSignals {
  serviceHints: string[];
  explicitApiIdHints: string[];
  inferredApiIdHints: string[];
  evidence: string[];
}

export interface CollectRepoSignalsInput {
  repoRoot: string;
  expectedServiceName?: string;
  expectedApiIds?: string[];
  repoSlug?: string;
  iacFingerprint?: {
    resourceIds: string[];
    serviceNames: string[];
    evidence: string[];
  };
}

const IAC_EXTENSIONS = ['.json', '.yaml', '.yml', '.tf', '.env', '.ts', '.js'];
const MAX_FILE_BYTES = 512 * 1024;

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractConfigNames(content: string): string[] {
  const values: string[] = [];
  const gateway = /projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/global\/apis\/[a-z0-9-]+\/configs\/[a-z0-9-]+/gi;
  const endpoints = /services\/[a-z0-9.-]+\/configs\/[a-z0-9._-]+/gi;
  values.push(...content.match(gateway) ?? [], ...content.match(endpoints) ?? []);
  return unique(values);
}

function extractServiceHints(content: string): string[] {
  const values: string[] = [];
  const assignments = /\b(?:api_id|api|service_name|display_name)\s*=\s*["']([a-z0-9][a-z0-9._-]+)["']/gi;
  for (const match of content.matchAll(assignments)) values.push(match[1]!);
  const endpointHosts = /\b([a-z0-9][a-z0-9.-]+\.endpoints\.[a-z][a-z0-9-]{4,28}[a-z0-9]\.cloud\.goog)\b/gi;
  for (const match of content.matchAll(endpointHosts)) values.push(match[1]!);
  return unique(values);
}

export async function collectRepoSignals(input: CollectRepoSignalsInput): Promise<RepoSignals> {
  const serviceHints = [
    input.expectedServiceName ?? '',
    input.repoSlug?.split('/').pop() ?? '',
    ...(input.iacFingerprint?.serviceNames ?? [])
  ];
  const inferredApiIds = [...(input.iacFingerprint?.resourceIds ?? [])];
  const evidence = [...(input.iacFingerprint?.evidence ?? [])];

  for (const file of await findIaCFiles(input.repoRoot, IAC_EXTENSIONS)) {
    const content = await readFile(file, 'utf8').catch(() => undefined);
    if (content === undefined || Buffer.byteLength(content) > MAX_FILE_BYTES) continue;
    const ids = extractConfigNames(content);
    if (ids.length > 0) {
      inferredApiIds.push(...ids);
      evidence.push(`Found Google Cloud API config reference(s) in ${path.relative(input.repoRoot, file)}`);
    }
    const hints = extractServiceHints(content);
    if (hints.length > 0) {
      serviceHints.push(...hints);
      evidence.push(`Found Google Cloud API service hint(s) in ${path.relative(input.repoRoot, file)}`);
    }
  }

  return {
    serviceHints: unique(serviceHints),
    explicitApiIdHints: unique(input.expectedApiIds ?? []),
    inferredApiIdHints: unique(inferredApiIds),
    evidence: unique(evidence)
  };
}
