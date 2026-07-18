import type { ProviderType, ResolutionResult, SpecFormat } from '../../contracts.js';
import type { RankedServiceCandidate } from './service-resolver.js';

export interface SourceSelectionInput {
  existingSpecPath?: string;
  existingSpecFormat?: SpecFormat;
  existingSpecEvidence?: string[];
  candidate?: RankedServiceCandidate;
  fallbackServiceName?: string;
}

const MINIMUM_RESOLVED_CONFIDENCE = 40;

function isResolvedCandidate(candidate: RankedServiceCandidate | undefined): candidate is RankedServiceCandidate {
  return Boolean(candidate && !candidate.ambiguous && candidate.supported && candidate.confidence >= MINIMUM_RESOLVED_CONFIDENCE);
}

function sourceTypeFor(providerType: ProviderType): ResolutionResult['sourceType'] {
  switch (providerType) {
    case 'api-gateway':
      return 'api-gateway-config';
    case 'cloud-endpoints':
      return 'cloud-endpoints-config';
    case 'apigee':
      return 'apigee-proxy';
    case 'api-hub':
      return 'api-hub-spec';
    case 'app-integration':
      return 'app-integration-trigger';
    case 'connectors-custom':
      return 'connectors-custom-spec';
    case 'apigee-portal': return 'apigee-portal-doc';
    case 'vertex-extensions': return 'vertex-extension-manifest';
    case 'dialogflow-tools': return 'dialogflow-tool-schema';
    case 'ces-toolsets': return 'ces-toolset-schema';
    case 'iac-local':
      return 'iac-embedded';
  }
}

function manualReviewEvidence(input: SourceSelectionInput): string[] {
  const evidence = [...(input.candidate?.evidence ?? [])];
  return evidence.length > 0 ? evidence : ['No matching source found'];
}

/**
 * Choose the winning source for resolve-one:
 *  1. an existing repository spec always wins;
 *  2. otherwise an unambiguous, supported candidate at or above the minimum confidence;
 *  3. otherwise manual review with the best observed confidence.
 */
export function chooseSource(input: SourceSelectionInput): ResolutionResult {
  const bestObservedConfidence = input.candidate?.confidence ?? 0;

  if (input.existingSpecPath) {
    return {
      status: 'resolved',
      sourceType: 'repo-spec',
      serviceName: input.candidate?.serviceName ?? input.fallbackServiceName ?? 'unknown-service',
      confidence: input.candidate ? Math.max(80, bestObservedConfidence) : 70,
      specPath: input.existingSpecPath,
      ...(input.candidate?.apiId ? { apiId: input.candidate.apiId } : {}),
      specFormat: input.existingSpecFormat,
      evidence: [
        ...(input.existingSpecEvidence?.length ? input.existingSpecEvidence : ['Resolved from existing repository specification']),
        ...(input.candidate?.evidence ?? [])
      ]
    };
  }

  const resolved = isResolvedCandidate(input.candidate) ? input.candidate : undefined;
  if (resolved) {
    return {
      status: 'resolved',
      sourceType: sourceTypeFor(resolved.providerType),
      serviceName: resolved.serviceName,
      confidence: resolved.confidence,
      ...(resolved.apiId ? { apiId: resolved.apiId } : {}),
      providerType: resolved.providerType,
      evidence: resolved.evidence
    };
  }

  return {
    status: 'unresolved',
    sourceType: 'manual-review',
    serviceName: input.fallbackServiceName ?? 'unknown-service',
    confidence: bestObservedConfidence,
    ...(input.candidate?.apiId ? { apiId: input.candidate.apiId } : {}),
    evidence: manualReviewEvidence(input)
  };
}
