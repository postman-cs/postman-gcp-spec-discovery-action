import type { ProviderType, ProviderProbeStatus, SourceAuthority, SourceType, SpecFormat } from '../../contracts.js';
import { isResolvableAuthority } from '../../contracts.js';
import type { NativeExportFilename } from '../spec/native-formats.js';

export interface SpecCandidate {
  id: string; // full Google resource name, or stable repo-relative IaC candidate ID
  name: string;
  providerType: ProviderType;
  sourceType?: SourceType;
  authority: SourceAuthority;
  apiId?: string; // full API Gateway or Cloud Endpoints config resource name
  projectId?: string;
  tags: Record<string, string>;
  supported: boolean;
  evidence: string[];
  meta: Record<string, string>;
}

export type SpecExportCompleteness = 'full' | 'partial';

/** Provider-owned definition member retained for authoritative multi-file exports. */
export interface SpecExportArtifact {
  /** Normalized provider-relative POSIX path under the service directory. */
  path: string;
  role: 'root' | 'dependency';
  /** Exact decoded UTF-8 text; no newline rewrite. */
  content: string;
  /** Original provider-returned path for evidence. */
  originalPath: string;
}

export interface SpecExportResult {
  content: string;
  format: SpecFormat;
  /** Single-file canonical name, or the root's provider-relative path for multi-file sets. */
  filename: NativeExportFilename | string;
  evidence: string[];
  /** Present for provider-owned sets that declare completeness. */
  completeness?: SpecExportCompleteness;
  /** Provider-relative root identity when artifacts are present. */
  rootPath?: string;
  /**
   * Full authoritative member set for multi-file exports (`completeness:'full'`).
   * Omitted for ordinary single-file results so inventory stays empty.
   */
  artifacts?: SpecExportArtifact[];
}

export interface SpecProvider {
  readonly type: ProviderType;
  probe(): Promise<ProviderProbeStatus>;
  listCandidates(): Promise<SpecCandidate[]>;
  exportSpec(candidate: SpecCandidate): Promise<SpecExportResult>;
}

/** Authority is required on SpecCandidate; this helper exists for call-site clarity. */
export function resolveCandidateAuthority(candidate: SpecCandidate): SourceAuthority {
  return candidate.authority;
}

/** Attach authority and enforce that only resolvable authorities may be supported. */
export function withAuthority(candidate: SpecCandidate): SpecCandidate {
  return {
    ...candidate,
    supported: candidate.supported && isResolvableAuthority(candidate.authority)
  };
}
