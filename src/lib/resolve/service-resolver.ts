import type { AmbiguousCandidateView, ProviderType, SourceType } from '../../contracts.js';
import type { RepoSignals } from '../repo/signals.js';
import { sanitizeLogMessage } from '../logging/sanitize.js';

export interface GCPCandidateInput {
  id: string; // full Google resource name (or repo-relative IaC candidate ID)
  name: string;
  providerType: ProviderType;
  sourceType?: SourceType;
  apiId?: string;
  tags: Record<string, string>;
  supported: boolean;
  evidence?: string[];
}

export interface RankedServiceCandidate {
  serviceName: string;
  resourceId: string;
  apiId?: string;
  providerType: ProviderType;
  sourceType?: SourceType;
  confidence: number;
  supported: boolean;
  ambiguous?: boolean;
  evidence: string[];
}

function includesIgnoreCase(value: string, candidates: string[]): boolean {
  const v = value.toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase() === v);
}

function shortApiId(value: string): string {
  return value.split('/').pop() ?? value;
}

function scoreCandidate(candidate: GCPCandidateInput, signals: RepoSignals): { score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];

  const candidateApiIds = [candidate.apiId ?? '', shortApiId(candidate.apiId ?? ''), candidate.id, shortApiId(candidate.id)].filter(Boolean);
  if (candidateApiIds.some((id) => includesIgnoreCase(id, signals.explicitApiIdHints))) {
    score += 100;
    evidence.push(`Matched explicit API ID ${shortApiId(candidate.apiId ?? candidate.id)}`);
  } else if (candidateApiIds.some((id) => includesIgnoreCase(id, signals.inferredApiIdHints))) {
    score += 25;
    evidence.push(`Matched inferred API ID ${shortApiId(candidate.apiId ?? candidate.id)}`);
  }

  const serviceHints = signals.serviceHints.map((hint) => hint.toLowerCase());
  if (serviceHints.some((hint) => hint && candidate.name.toLowerCase().includes(hint))) {
    score += 30;
    evidence.push(`Display name "${candidate.name}" matches service hint`);
  }

  // Only canonical ownership tags carry selection-grade weight; an incidental
  // tag like environment="payments-live" must not out-rank the intended match.
  const canonicalTagKeys = ['postman-project-name', 'postman-repo', 'name'];
  const canonicalTagValues = Object.entries(candidate.tags)
    .filter(([key]) => canonicalTagKeys.includes(key.toLowerCase()))
    .map(([, value]) => value.toLowerCase());
  const allTagValues = Object.values(candidate.tags).map((value) => value.toLowerCase());
  if (serviceHints.some((hint) => hint && canonicalTagValues.some((tag) => tag === hint))) {
    // Exact equality on a canonical ownership tag is the strongest tag signal and
    // must outrank substring containment so "payments-live" cannot tie with
    // "payments-live-site".
    score += 60;
    evidence.push('Canonical ownership tag exactly matches service hint');
  } else if (serviceHints.some((hint) => hint && allTagValues.some((tag) => tag === hint))) {
    // Exact match on a non-canonical tag is corroborating but not authoritative:
    // it stays below MINIMUM_RESOLVED_CONFIDENCE (40) so it reorders candidates
    // but can never authorize an export on its own.
    score += 39;
    evidence.push('Resource tag exactly matches service hint');
  } else if (serviceHints.some((hint) => hint && allTagValues.some((tag) => tag.includes(hint)))) {
    score += 39;
    evidence.push('Resource tags match service hint');
  }

  if (candidate.sourceType?.endsWith('-generated-spec')) {
    score = Math.max(0, score - 1);
    evidence.push('Generated specification ranks below stored specification sources');
  }

  return { score, evidence };
}

function toRanked(candidate: GCPCandidateInput, signals: RepoSignals, score: number, evidence: string[]): RankedServiceCandidate {
  const mergedEvidence = [...signals.evidence, ...(candidate.evidence ?? []), ...evidence];
  const serviceName =
    (candidate.tags['postman-project-name'] ?? '').trim() ||
    (candidate.tags.name ?? '').trim() ||
    candidate.name;
  return {
    serviceName,
    resourceId: candidate.id,
    apiId: candidate.apiId,
    providerType: candidate.providerType,
    sourceType: candidate.sourceType,
    confidence: score,
    supported: candidate.supported,
    evidence: mergedEvidence.length > 0 ? mergedEvidence : ['No strong resolver evidence found']
  };
}

/**
 * Deterministic ranking of every GCP candidate.
 * Sort: confidence descending, then full resource ID ascending. This is the single source
 * of truth for candidate ordering; resolveServiceCandidate() consumes it so the ranked view
 * surfaced for ambiguity can never diverge from resolution.
 */
export function rankServiceCandidates(
  candidates: GCPCandidateInput[],
  signals: RepoSignals
): RankedServiceCandidate[] {
  const ranked = candidates.map((candidate) => {
    const scored = scoreCandidate(candidate, signals);
    return toRanked(candidate, signals, scored.score, scored.evidence);
  });
  ranked.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      (left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0)
  );
  return ranked;
}

export function resolveServiceCandidate(
  candidates: GCPCandidateInput[],
  signals: RepoSignals
): RankedServiceCandidate | undefined {
  const ranked = rankServiceCandidates(candidates, signals);
  if (ranked.length === 0) return undefined;
  const best = ranked[0];
  // Equal top confidence across more than one candidate is ambiguous.
  const tied = ranked.filter((candidate) => candidate.confidence === best.confidence);
  if (tied.length > 1 && best.confidence > 0) {
    best.ambiguous = true;
    best.evidence = [
      ...best.evidence,
      `Ambiguous match: ${tied.map((candidate) => shortApiId(candidate.resourceId)).join(' and ')} have equal confidence ${best.confidence}`
    ];
  }
  return best;
}

/** Serialize ranked candidates into the public AmbiguousCandidateView shape. */
export function toAmbiguousViews(ranked: RankedServiceCandidate[]): AmbiguousCandidateView[] {
  return ranked.map((candidate, index) => ({
    rank: index + 1,
    serviceName: sanitizeLogMessage(candidate.serviceName),
    resourceId: summarizeResourceName(candidate.resourceId),
    ...(candidate.apiId ? { apiId: summarizeResourceName(candidate.apiId) } : {}),
    providerType: candidate.providerType,
    confidence: candidate.confidence,
    supported: candidate.supported,
    evidence: candidate.evidence.map(sanitizeLogMessage)
  }));
}

function summarizeResourceName(value: string): string {
  const segments = value.split('/').filter(Boolean);
  return sanitizeLogMessage(segments.length > 2 ? `.../${segments.slice(-2).join('/')}` : value);
}
