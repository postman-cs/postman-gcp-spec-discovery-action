import type { ProviderProbeStatus } from '../../contracts.js';

export function probeFailureStatus(error: unknown): ProviderProbeStatus {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:401|403)\b|permission[_ -]?denied|forbidden|unauthenticated/i.test(message)
    ? 'skipped:iam'
    : 'skipped:error';
}
