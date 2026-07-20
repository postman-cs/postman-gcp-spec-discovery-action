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

  it('GCP-DOCS-002: README lists both CES source types for ces-toolsets', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    const providersSection = readme.slice(readme.indexOf('## Supported providers'));
    expect(providersSection).toContain('`ces-tool-schema`');
    expect(providersSection).toContain('`ces-toolset-schema`');
    expect(providersSection).toMatch(/standalone/i);
    expect(providersSection).toMatch(/toolset-scoped/i);
  });

  it('GCP-DOCS-003: providers.md states connector schema metadata is not synthesized', () => {
    const providers = readFileSync(resolve(repoRoot, 'docs/providers.md'), 'utf8');
    expect(providers).not.toContain('connectors-generated-spec');
    expect(providers).toMatch(/metadata-only/i);
    expect(providers).toMatch(/not (?:an OpenAPI source|synthesized)/i);
    expect(providers).toMatch(/apigee-registry/);
    const capabilityRow = providers
      .split('\n')
      .find((line) => line.includes('Label-capable (auto-select works)'));
    expect(capabilityRow).toBeDefined();
    expect(capabilityRow).toContain('`apigee-registry`');
  });
});
