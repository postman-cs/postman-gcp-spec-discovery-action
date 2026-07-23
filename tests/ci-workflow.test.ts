import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

describe('CI workflow contract', () => {
  it('GCP-CI-001: Linux and Windows gates, Node 24, read-only dist assert, actionlint + README table drift, no live GCP step', () => {
    const jobsSection = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:', '  windows:']);

    expect(ciWorkflow).toContain("node-version: '24'");
    expect(ciWorkflow.match(/npm ci/g)).toHaveLength(2);
    expect(ciWorkflow.match(/npm run bundle/g)).toHaveLength(2);
    expect(ciWorkflow).toContain('runs-on: windows-latest');
    expect(ciWorkflow).toContain('MAX_PARALLEL_GATES=2');
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain('cancel-in-progress: ${{ github.event_name == \'pull_request\' }}');
    expect(ciWorkflow).toContain('run dist       npm run verify:dist:assert');
    expect(ciWorkflow).not.toContain('npm run verify:dist\n');

    // Pinned actionlint + non-writing README table drift gate (GCP-DOCS-001 / GCP-CI-001).
    expect(ciWorkflow).toContain('download-actionlint.bash) 1.7.11');
    expect(ciWorkflow).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(ciWorkflow).toContain('run docs       node scripts/render-action-tables.mjs --check');

    // No credentialed live GCP validation may run in CI (untrusted PRs).
    expect(ciWorkflow).not.toContain('validate-live-gcp-surfaces');
    expect(ciWorkflow).not.toContain('GCP_SUBSCRIPTION_ID');
    expect(ciWorkflow).not.toContain('gcp/login');
    expect(ciWorkflow).not.toContain('GCP_CREDENTIALS');

    const windows = ciWorkflow.slice(ciWorkflow.indexOf('\n  windows:\n'));
    expect(windows).toContain('MAX_PARALLEL_GATES=2');
    expect(windows.indexOf('npm run bundle')).toBeLessThan(windows.indexOf('Run gates'));
    expect(windows).toContain('Start-Job');
    expect(windows).toContain('npm run verify:dist:assert');
    // A failed native gate must fail the job: propagate $LASTEXITCODE, not just PowerShell job state.
    expect(windows).toContain('$LASTEXITCODE');
    expect(windows).toContain('throw');
  });
});
