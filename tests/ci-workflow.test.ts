import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
/** Bounded wait for offline `npx --no-install commitlint` under full-suite parallel load. */
const COMMITLINT_SUBPROCESS_TIMEOUT_MS = 15_000;
const ciWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, { devDependencies?: Record<string, string> }>;
};

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function jobText(workflow: string, jobId: string): string {
  const jobsBody = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Ordered gate names launched via `run <name> ...` (excludes the `run()` helper definition). */
function linuxQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/^\s+run ([a-zA-Z0-9_-]+)\s+/gm)].map((m) => m[1]!);
}

/** Same local command the Linux CI queue uses; Windows uses npx.cmd. Offline / --no-install only. */
function runLockfileCommitlint(message: string) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return spawnSync(npx, ['--no-install', 'commitlint'], {
    cwd: root,
    encoding: 'utf8',
    input: message.endsWith('\n') ? message : `${message}\n`,
    env: {
      ...process.env,
      npm_config_offline: 'true',
      NPM_CONFIG_OFFLINE: 'true',
    },
    shell: process.platform === 'win32',
    timeout: COMMITLINT_SUBPROCESS_TIMEOUT_MS,
  });
}

const linux = jobText(ciWorkflow, 'gate');
const windows = jobText(ciWorkflow, 'windows');

describe('CI workflow contract', () => {
  it('GCP-CI-001: exact two jobs, Node 24, no NPM auth secret, no live GCP step', () => {
    const jobsSection = ciWorkflow.slice(ciWorkflow.indexOf('\njobs:\n'));
    const jobMatches = jobsSection.match(/^ {2}[a-zA-Z0-9_-]+:$/gm) ?? [];
    expect(jobMatches).toEqual(['  gate:', '  windows:']);

    expect(ciWorkflow).toContain("node-version: '24'");
    expect(linux.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(1);
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(ciWorkflow).toContain('runs-on: windows-latest');
    expect(ciWorkflow).toContain(
      'group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    expect(ciWorkflow).not.toMatch(/NODE_AUTH_TOKEN\s*:/);
    expect(ciWorkflow).not.toContain('secrets.NPM_TOKEN');
    expect(ciWorkflow).not.toContain('NPM_TOKEN');

    expect(ciWorkflow).not.toContain('validate-live-gcp-surfaces');
    expect(ciWorkflow).not.toContain('GCP_SUBSCRIPTION_ID');
    expect(ciWorkflow).not.toContain('gcp/login');
    expect(ciWorkflow).not.toContain('GCP_CREDENTIALS');
  });

  it('GCP-CI-002: Linux full-history checkout, one bundle before Run gates, bounded PID queue', () => {
    expect(linux).toContain('fetch-depth: 0');
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));

    const runGates = namedStep(linux, 'Run gates');
    expect(runGates.length).toBeGreaterThan(0);
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');
    expect(runGates).toContain('declare -A pid=()');
    expect(runGates).toContain('unset \'pid[$n]\'');

    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'typecheck',
      'test',
      'dist',
      'actionlint',
      'docs',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run dist       npm run verify:dist:assert');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('run docs       node scripts/render-action-tables.mjs --check');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx --no-install commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');
    expect(runGates).not.toMatch(/\bnpx\s+commitlint\b/);

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('npm run bundle');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
    expect(runGates).toContain('exit $fail');
  });

  it('GCP-CI-003: actionlint 1.7.11 at RUNNER_TEMP with no Go toolchain', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash',
    );
    expect(install).toMatch(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/);
    expect(install.match(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/)?.[0]).toHaveLength(40);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).not.toContain('/main/scripts/download-actionlint.bash');

    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(ciWorkflow).not.toMatch(/\bgo install\b/);
  });

  it('GCP-CI-004: Windows exact cache pin, guarded miss npm ci, node-run test, no queue', () => {
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);

    expect(windows).toContain("node-version: '24'");
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    expect(windows).toContain('id: windows-node-modules');
    expect(windows).toContain(
      'uses: actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4.2.0',
    );
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain(
      "key: Windows/node-24/exact-${{ hashFiles('package-lock.json') }}",
    );
    expect(windows).not.toContain('restore-keys');
    expect(windows).not.toContain('restore-key');

    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');
    expect(windows.match(/npm ci --prefer-offline --no-audit --no-fund/g) ?? []).toHaveLength(1);
    expect(windows.match(/^\s*- run: npm ci\s*$/gm) ?? []).toHaveLength(0);

    expect(windows.match(/^\s*- run: node --run test\s*$/gm) ?? []).toHaveLength(1);
    expect(windows).not.toMatch(/^\s*- run: npm test(?:\s|$)/m);

    expect(windows).not.toContain('Run gates');
    expect(windows).not.toContain('shell: pwsh');
    expect(windows).not.toContain('$MAX_PARALLEL_GATES');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toContain('Wait-Job');
    expect(windows).not.toContain('Receive-Job');
    expect(windows).not.toMatch(/@\{ Name = '/);

    expect(windows).not.toContain('npm run bundle');
    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('npm run verify:dist');
    expect(windows).not.toContain('actionlint');
    expect(windows).not.toContain('commitlint');
  });

  it('GCP-CI-006: Linux and Windows jobs stay independent with no needs edges', () => {
    expect(linux).not.toMatch(/^\s*needs:/m);
    expect(windows).not.toMatch(/^\s*needs:/m);
    expect(ciWorkflow).not.toMatch(/^\s*needs:/m);

    const upload = namedStep(linux, 'Upload expected dist on mismatch');
    expect(upload.length).toBeGreaterThan(0);
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('uses: actions/upload-artifact@v7');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
  });

  it(
    'GCP-CI-005: package/lock own commitlint and npx --no-install loads repo config',
    () => {
      expect(pkg.devDependencies?.['@commitlint/cli']).toBe('^21.2.1');
      expect(pkg.devDependencies?.['@commitlint/config-conventional']).toBe('^21.2.0');

      const lockRootDev = lock.packages?.['']?.devDependencies;
      expect(lockRootDev?.['@commitlint/cli']).toBe('^21.2.1');
      expect(lockRootDev?.['@commitlint/config-conventional']).toBe('^21.2.0');

      const valid = runLockfileCommitlint('feat: prove lockfile-owned commitlint');
      expect(valid.error, `${valid.stdout}${valid.stderr}`).toBeUndefined();
      expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);

      const invalid = runLockfileCommitlint('Not a conventional commit');
      expect(invalid.error, `${invalid.stdout}${invalid.stderr}`).toBeUndefined();
      expect(invalid.status, `${invalid.stdout}${invalid.stderr}`).not.toBe(0);
      expect(`${invalid.stdout}${invalid.stderr}`).toMatch(/type-empty|subject-empty/);

      // body-max-line-length is disabled only in this repo's commitlint.config.js
      // (conventional defaults would fail a 150-char body line).
      const longBody = runLockfileCommitlint(`feat: short\n\n${'x'.repeat(150)}`);
      expect(longBody.error, `${longBody.stdout}${longBody.stderr}`).toBeUndefined();
      expect(longBody.status, `${longBody.stdout}${longBody.stderr}`).toBe(0);
    },
    35_000,
  );
});
