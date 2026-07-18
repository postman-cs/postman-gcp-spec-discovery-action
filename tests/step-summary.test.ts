import { describe, expect, it } from 'vitest';

import { renderAmbiguityStepSummary } from '../src/lib/logging/step-summary.js';

describe('ambiguity step summary', () => {
  it('GCP-SUMMARY-001: golden markdown with GCP heading, probes, and redacted resource ids', () => {
    const markdown = renderAmbiguityStepSummary({
      status: 'unresolved',
      sourceType: 'manual-review',
      narrowingTier: 'naming-heuristic',
      candidates: [
        {
          rank: 1,
          serviceName: 'payments-a',
          resourceId:
            '/subscriptions/aaaaaaaa-1111-2222-3333-444444444444/resourceGroups/payments-rg/providers/Microsoft.ApiManagement/service/svc/apis/payments-a',
          providerType: 'api-gateway',
          confidence: 30,
          supported: true,
          evidence: ['Display name matches']
        },
        {
          rank: 2,
          serviceName: 'payments-b',
          resourceId:
            '/subscriptions/aaaaaaaa-1111-2222-3333-444444444444/resourceGroups/payments-rg/providers/Microsoft.ApiManagement/service/svc/apis/payments-b',
          providerType: 'api-gateway',
          confidence: 30,
          supported: true,
          evidence: ['Display name matches']
        }
      ],
      probes: [
        { provider: 'api-gateway', status: 'available' },
        { provider: 'cloud-endpoints', status: 'skipped:iam' },
        { provider: 'iac-local', status: 'skipped:error' }
      ]
    });

    expect(markdown).toContain('## Postman GCP spec discovery');
    expect(markdown).toContain('`unresolved`');
    expect(markdown).toContain('`manual-review`');
    expect(markdown).toContain('`naming-heuristic`');
    expect(markdown).toContain('`payments-a`');
    expect(markdown).toContain('`available`');
    expect(markdown).toContain('`skipped:iam`');
    expect(markdown).toContain('`skipped:error`');
    // Subscription UUID must be redacted out of the resource column
    expect(markdown).not.toContain('aaaaaaaa-1111-2222-3333-444444444444');
  });
});
