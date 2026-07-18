import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAction, type CoreLike } from '../src/index.js';
import { runCli } from '../src/cli.js';
import type { GCPDependencies } from '../src/runtime.js';
import { contractOutputNames } from '../src/contracts.js';
import type { SpecCandidate, SpecProvider } from '../src/lib/providers/types.js';
import type { GcpDiscoveryClient } from '../src/lib/gcp/clients.js';

const repoRoot = resolve(import.meta.dirname, '..');

const CLI_ONLY_INPUTS = [
  'repo-url',
  'git-provider',
  'ref',
  'sha',
  'repo-root',
  'api-filter',
  'max-candidates',
  'dry-run',
  'preflight-checks',
  'preflight-permission-probe',
  'request-timeout-ms',
  'max-attempts'
];

function actionManifestInputs(): string[] {
  const manifest = parse(readFileSync(resolve(repoRoot, 'action.yml'), 'utf8')) as {
    inputs?: Record<string, unknown>;
  };
  return Object.keys(manifest.inputs ?? {});
}

function cliInputNames(): string[] {
  const source = readFileSync(resolve(repoRoot, 'src/cli.ts'), 'utf8');
  const match = source.match(/const CLI_INPUT_NAMES = \[([^\]]*)\]/);
  if (!match) throw new Error('CLI_INPUT_NAMES array not found in src/cli.ts');
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1] as string);
}

const VALID_OPENAPI = `${JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Payments', version: '1.0.0' },
  paths: { '/payments': { get: { responses: { '200': { description: 'ok' } } } } }
})}\n`;

function stubProvider(): SpecProvider {
  const armId = 'projects/sample-project-123/locations/global/apis/payments/configs/v1';
  const candidate: SpecCandidate = {
    id: armId,
    name: 'payments',
    providerType: 'api-gateway',
    apiId: armId,
    projectId: 'sample-project-123',
    tags: { 'postman-repo': 'org--payments' },
    supported: true,
    evidence: [],
    meta: {}
  };
  return {
    type: 'api-gateway',
    probe: vi.fn(async () => 'available' as const),
    listCandidates: vi.fn(async () => [candidate]),
    exportSpec: vi.fn(async () => ({
      content: VALID_OPENAPI,
      format: 'openapi-json' as const,
      filename: 'index.json' as const,
      evidence: ['stub export']
    }))
  };
}

describe('action.yml <-> CLI flag parity', () => {
  it('every action.yml input has a CLI flag, and CLI extras stay on the allowlist', () => {
    const cli = new Set(cliInputNames());
    const manifest = new Set(actionManifestInputs());
    expect([...manifest].filter((name) => !cli.has(name))).toEqual([]);
    const extras = cliInputNames().filter((name) => !manifest.has(name) && !CLI_ONLY_INPUTS.includes(name));
    expect(extras).toEqual([]);
    expect(CLI_ONLY_INPUTS.filter((name) => !cli.has(name))).toEqual([]);
    expect(CLI_ONLY_INPUTS.filter((name) => manifest.has(name))).toEqual([]);
  });
});

describe('adapter parity', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('GCP-ENTRY-001: action shell and CLI-shaped env produce byte-equal outputs for all 22 outputs', async () => {
    // Hermetic repo root: empty temp dir so neither adapter picks up repo
    // specs/IaC from the action checkout or CI workspace, and both adapters
    // see identical ambient env (CI sets GITHUB_WORKSPACE; locally unset).
    vi.stubEnv('POSTMAN_ACTIONS_TELEMETRY', 'off');
    const emptyRepoRoot = process.cwd();
    const resultPath = `.gcp-parity-${process.pid}-${Date.now()}.json`;
    const client = new Proxy({}, { get: () => vi.fn(async () => undefined) }) as GcpDiscoveryClient;
    const runtimeDeps = (provider: SpecProvider): Omit<GCPDependencies, 'core'> => ({
      client,
      writeSpecFile: vi.fn(async () => undefined),
      providers: [provider]
    });

    try {
      const actionOutputs: Record<string, string> = {};
      const id = 'projects/sample-project-123/locations/global/apis/payments/configs/v1';
      const inputVals: Record<string, string> = { 'api-id': id, 'project-id': 'sample-project-123' };
      const core: CoreLike = {
        getInput: (name: string) => inputVals[name] ?? '',
        group: async (_n, fn) => fn(),
        info: () => undefined,
        warning: () => undefined,
        setOutput: (name, value) => {
          actionOutputs[name] = value;
        },
        setFailed: () => undefined
      };
      await runAction(core, runtimeDeps(stubProvider()));

      let stdout = '';
      await runCli(
        [
          '--api-id', id,
          '--project-id', 'sample-project-123',
          '--repo-root', emptyRepoRoot,
          '--result-json', resultPath
        ],
        {
          env: { ...process.env, GITHUB_WORKSPACE: emptyRepoRoot, POSTMAN_ACTIONS_TELEMETRY: 'off' },
          writeStdout: (chunk) => { stdout += chunk; },
          dependencies: runtimeDeps(stubProvider())
        }
      );
      const cliResult = JSON.parse(stdout) as { outputs: Record<string, string> };

      expect(Object.keys(actionOutputs).sort()).toEqual([...contractOutputNames].sort());
      for (const name of contractOutputNames) {
        expect(cliResult.outputs[name] ?? '', `output ${name}`).toBe(actionOutputs[name] ?? '');
      }
    } finally {
      rmSync(resolve(emptyRepoRoot, resultPath), { force: true });
    }
  });
});
