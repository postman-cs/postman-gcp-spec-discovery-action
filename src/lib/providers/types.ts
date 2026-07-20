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

export interface SpecExportResult {
  content: string;
  format: SpecFormat;
  filename: NativeExportFilename;
  evidence: string[];
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
