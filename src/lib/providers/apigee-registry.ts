import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';

import type { ProviderProbeStatus, SourceAuthority, SourceType } from '../../contracts.js';
import type { ApigeeRegistrySpecSummary, GcpDiscoveryClient } from '../gcp/clients.js';
import { inflateZip } from '../gcp/zip.js';
import { probeFailureStatus } from './probe.js';
import { decodeUtf8OpenApi, type DecodedSourceDocument } from './source-document.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

/**
 * Legacy Apigee Registry (apigeeregistry.googleapis.com) — no longer supported as a
 * replacement for API Hub. Retained fail-soft for existing customer data only.
 * Official: projects.locations.apis.versions.specs.getContents
 */

const SPEC_PATTERN = /^projects\/([^/]+)\/locations\/([^/]+)\/apis\/([^/]+)\/versions\/([^/]+)\/specs\/([^/]+)$/;

export interface ApigeeRegistryScope {
  projectId: string;
  apiId?: string;
}

export function parseApigeeRegistrySpecName(value: string): {
  projectId: string;
  location: string;
  apiName: string;
  versionId: string;
  specId: string;
} | undefined {
  const match = SPEC_PATTERN.exec(value);
  return match
    ? { projectId: match[1]!, location: match[2]!, apiName: match[3]!, versionId: match[4]!, specId: match[5]! }
    : undefined;
}

function shortName(value: string): string {
  return value.split('/').pop() ?? value;
}

function mimeBase(mimeType: string | undefined): string {
  return (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function isNonOpenApiMime(mimeType: string | undefined): boolean {
  const base = mimeBase(mimeType);
  if (!base) return false;
  return /(?:^|[+/.-])(?:proto|protobuf|graphql|wsdl|asyncapi)(?:$|[+/.-])/.test(base)
    || base.includes('vnd.apigee.proto')
    || base.includes('vnd.apigee.graphql');
}

function isGzipMime(mimeType: string | undefined): boolean {
  const base = mimeBase(mimeType);
  return base.endsWith('+gzip') || base === 'application/gzip' || base === 'application/x-gzip';
}

function supportFromMime(spec: ApigeeRegistrySpecSummary): { supported: boolean; authority: SourceAuthority; evidence: string[] } {
  const evidence = [
    `Legacy Apigee Registry spec ${shortName(spec.name)} declares mimeType ${spec.mimeType ?? 'unspecified'} (no-longer-supported surface; not a replacement for API Hub)`
  ];
  if (isNonOpenApiMime(spec.mimeType)) {
    return {
      supported: false,
      authority: 'unsupported-format',
      evidence: [...evidence, 'Only OpenAPI/Swagger Apigee Registry specs are exportable']
    };
  }
  return { supported: true, authority: 'stored-authoritative', evidence };
}

function tryDecodeOpenApiBytes(bytes: Buffer): DecodedSourceDocument | undefined {
  try {
    return decodeUtf8OpenApi(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function decodeRegistryContents(bytes: Buffer, mimeType: string | undefined): DecodedSourceDocument {
  if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8a) {
    let inflated: Buffer;
    try {
      inflated = gunzipSync(bytes, { maxOutputLength: 10 * 1024 * 1024 });
    } catch {
      throw new Error('Legacy Apigee Registry spec contents are gzip-compressed and could not be inflated within bounds');
    }
    const decoded = tryDecodeOpenApiBytes(inflated);
    if (!decoded) throw new Error('Legacy Apigee Registry gzip contents are not a valid OpenAPI document');
    return decoded;
  }

  if (bytes.byteLength >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    const found: DecodedSourceDocument[] = [];
    for (const [path, entry] of inflateZip(bytes)) {
      if (path.includes('\0') || path.startsWith('/') || path.includes('..') || /^[A-Za-z]:/.test(path)) {
        throw new Error('Legacy Apigee Registry multi-file bundle contains an unsafe entry name');
      }
      if (!/\.(?:json|ya?ml)$/i.test(path)) continue;
      const decoded = tryDecodeOpenApiBytes(entry);
      if (decoded) found.push(decoded);
    }
    if (found.length === 1) return found[0]!;
    if (found.length === 0) {
      throw new Error('Legacy Apigee Registry multi-file bundle has no OpenAPI document');
    }
    throw new Error(`Legacy Apigee Registry multi-file bundle has ${found.length} OpenAPI documents; refusing to merge or guess`);
  }

  if (isGzipMime(mimeType)) {
    throw new Error('Legacy Apigee Registry spec mimeType indicates compression that remains unsupported without a single OpenAPI document');
  }
  if (isNonOpenApiMime(mimeType)) {
    throw new Error('Legacy Apigee Registry spec contents are a non-OpenAPI mime type');
  }

  const decoded = tryDecodeOpenApiBytes(bytes);
  if (!decoded) throw new Error('Legacy Apigee Registry spec contents are not a valid OpenAPI document');
  return decoded;
}

export class ApigeeRegistryProvider implements SpecProvider {
  public readonly type = 'apigee-registry' as const;

  public constructor(
    private readonly client: GcpDiscoveryClient,
    private readonly scope: ApigeeRegistryScope
  ) {}

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeApigeeRegistry(this.scope.projectId);
      return 'available';
    } catch (error) {
      return probeFailureStatus(error);
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const explicit = this.scope.apiId ? parseApigeeRegistrySpecName(this.scope.apiId) : undefined;
    if (explicit) {
      if (explicit.projectId !== this.scope.projectId) {
        throw new Error('api-id must belong to the configured project-id Apigee Registry instance');
      }
      const spec = await this.client.getApigeeRegistrySpec(this.scope.apiId!);
      return [this.toCandidate(spec)];
    }
    if (this.scope.apiId) return [];

    const specs = await this.client.listApigeeRegistrySpecs(this.scope.projectId);
    return specs.map((spec) => this.toCandidate(spec));
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const parsed = parseApigeeRegistrySpecName(candidate.id);
    if (!parsed || parsed.projectId !== this.scope.projectId) {
      throw new Error('Apigee Registry candidate has an invalid spec resource name');
    }
    const { bytes, mimeType } = await this.client.getApigeeRegistrySpecContents(candidate.id);
    const decoded = decodeRegistryContents(bytes, mimeType ?? candidate.meta.mimeType);
    return {
      ...decoded,
      evidence: [
        `Exported legacy Apigee Registry spec contents for ${shortName(candidate.id)}`,
        'Legacy Apigee Registry is no longer supported; prefer API Hub for new registrations'
      ]
    };
  }

  private toCandidate(spec: ApigeeRegistrySpecSummary): SpecCandidate {
    const support = supportFromMime(spec);
    const sourceType: SourceType = 'apigee-registry-spec';
    return withAuthority({
      id: spec.name,
      name: spec.filename || shortName(spec.name),
      providerType: this.type,
      sourceType,
      authority: support.authority,
      apiId: spec.name,
      projectId: this.scope.projectId,
      tags: spec.labels,
      supported: support.supported,
      evidence: support.evidence,
      meta: {
        location: spec.name.split('/')[3] ?? '',
        apiName: spec.name.split('/apis/')[1]?.split('/')[0] ?? '',
        versionId: spec.name.split('/versions/')[1]?.split('/')[0] ?? '',
        specId: shortName(spec.name),
        mimeType: spec.mimeType ?? '',
        createTime: spec.createTime ?? ''
      }
    });
  }
}
