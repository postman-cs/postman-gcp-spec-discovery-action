import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');

describe('README action tables', () => {
  it('GCP-DOCS-001: README names the ten v1 providers and the non-goals', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    for (const provider of ['api-gateway', 'cloud-endpoints', 'apigee', 'api-hub', 'apigee-registry', 'app-integration', 'connectors-custom', 'apigee-portal', 'vertex-extensions', 'dialogflow-tools', 'ces-toolsets', 'iac-local']) {
      expect(readme).toContain(`\`${provider}\``);
    }
    expect(readme).toContain('no-longer-supported');
    // Non-goals must be documented so users do not expect them.
    for (const nonGoal of ['Cloud Run', 'Functions', 'shadow-API', 'gRPC']) {
      expect(readme).toContain(nonGoal);
    }
    expect(readme).toContain('manual review');
  });
});
