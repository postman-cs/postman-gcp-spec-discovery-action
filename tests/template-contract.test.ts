import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const templatePath = join(repoRoot, 'templates/postman-gcp-onboard.yml');
const template = readFileSync(templatePath, 'utf8');

describe('GCP spoke template contract', () => {
  it('GCP-TEMPLATE-001: is valid YAML with the expected trigger and guard shape', () => {
    const parsed = parse(template) as {
      on?: Record<string, unknown>;
      permissions?: Record<string, string>;
      jobs?: { onboard?: { steps?: Array<Record<string, unknown>> } };
    };
    expect(parsed.jobs?.onboard?.steps?.length).toBeGreaterThanOrEqual(4);
    expect(parsed.permissions).toMatchObject({ 'id-token': 'write' });
  });

  it('GCP-TEMPLATE-002: never interpolates resolution-json directly into a run body (command-injection guard)', () => {
    // GCP-derived resolution JSON must be bound to an env var and quoted, never
    // spliced into shell source where a resource name with a quote could inject.
    const parsed = parse(template) as {
      jobs?: { onboard?: { steps?: Array<{ run?: string; env?: Record<string, string> }> } };
    };
    const steps = parsed.jobs?.onboard?.steps ?? [];
    for (const step of steps) {
      if (typeof step.run === 'string') {
        expect(step.run).not.toContain('steps.spec.outputs.resolution-json');
      }
    }
    const guard = steps.find((step) => typeof step.run === 'string' && step.run.includes('RESOLUTION_JSON'));
    expect(guard?.env?.RESOLUTION_JSON).toBe('${{ steps.spec.outputs.resolution-json }}');
    expect(guard?.run).toContain('printf \'%s\' "$RESOLUTION_JSON"');
  });

  it('GCP-TEMPLATE-003: pins the composite onboarding action to its current major alias', () => {
    // The spoke consumes the composite by rolling-major ref; keep it aligned with
    // the composite's published major so distributed workflows resolve.
    expect(template).toContain('postman-cs/postman-api-onboarding-action@v2');
    expect(template).toContain('postman-cs/postman-gcp-spec-discovery-action@v1');
  });
});
