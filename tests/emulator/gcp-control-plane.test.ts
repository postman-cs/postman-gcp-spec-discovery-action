/**
 * GCP emulator lane: proves the SHIPPED CLI bundle (dist/cli.cjs) speaks the
 * real googleapis wire protocol against a hermetic fixture -- ADC service
 * account auth, control-plane preflight, Apigee bundle export, the trusted-GCS
 * signed-URL download leg, and untrusted-host enforcement -- with zero live
 * Google traffic.
 *
 * There is deliberately no endpoint-override product seam; transport rides the
 * runtime's own env contracts (HTTPS_PROXY for gaxios, NODE_USE_ENV_PROXY=1
 * for undici fetch, NODE_EXTRA_CA_CERTS for the run-scoped CA,
 * GOOGLE_APPLICATION_CREDENTIALS for ADC). The fixture proxy refuses every
 * non-googleapis CONNECT, so green means hermetic. The lane is excluded from
 * `npm test`; CI runs it as a budgeted Linux step (no container required).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ARCHIVE_ENVIRONMENT,
  EVIL_ARCHIVE_ID,
  FIXTURE_PROJECT_ID,
  GOOD_ARCHIVE_ID,
  INACTIVE_PROJECT_ID,
  PROXY_NAME,
  PROXY_REVISION,
  startGcpFixture,
  type GcpFixture
} from './fixture/gcp-fixture.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '..', '..');
const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'dist', 'cli.cjs');

const REVISION_API_ID = `organizations/${FIXTURE_PROJECT_ID}/apis/${PROXY_NAME}/revisions/${PROXY_REVISION}`;
const ARCHIVE_API_ID = `organizations/${FIXTURE_PROJECT_ID}/environments/${ARCHIVE_ENVIRONMENT}/archiveDeployments/${GOOD_ARCHIVE_ID}`;
const EVIL_ARCHIVE_API_ID = `organizations/${FIXTURE_PROJECT_ID}/environments/${ARCHIVE_ENVIRONMENT}/archiveDeployments/${EVIL_ARCHIVE_ID}`;

let fixture: GcpFixture;
const workspaces: string[] = [];

const execFileAsync = promisify(execFile);

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

async function createWorkspace(name: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  workspaces.push(workspace);
  return workspace;
}

// The fixture servers live in this test process, so the CLI child MUST run
// asynchronously: execFileSync would block the event loop and deadlock the
// proxy (it could never accept the child's CONNECT).
async function runCli(workspace: string, env: Record<string, string>): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_ENTRYPOINT, '--result-json', 'result.json'], {
      cwd: workspace,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      // A hung transport must fail the test, not freeze the worker forever.
      timeout: 45_000,
      killSignal: 'SIGKILL',
      env: {
        // Deliberately NOT process.env: the child sees only the fixture's
        // transport contracts, proving no ambient gcloud/ADC state leaks in.
        PATH: process.env.PATH ?? '',
        HOME: os.tmpdir(),
        POSTMAN_ACTIONS_TELEMETRY: 'off',
        HTTPS_PROXY: fixture.proxyUrl,
        HTTP_PROXY: fixture.proxyUrl,
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: fixture.caPath,
        GOOGLE_APPLICATION_CREDENTIALS: fixture.serviceAccountPath,
        INPUT_MODE: 'resolve-one',
        INPUT_PROJECT_ID: FIXTURE_PROJECT_ID,
        INPUT_REPO_ROOT: workspace,
        INPUT_OUTPUT_DIR: 'discovered-specs',
        ...env
      }
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : String(failure.stdout ?? ''),
      stderr: typeof failure.stderr === 'string' ? failure.stderr : String(failure.stderr ?? '')
    };
  }
}

function readResult(workspace: string): { outputs: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(workspace, 'result.json'), 'utf8')) as {
    outputs: Record<string, string>;
  };
}

beforeAll(async () => {
  expect(existsSync(CLI_ENTRYPOINT), `missing ${CLI_ENTRYPOINT}; run npm run bundle first`).toBe(true);
  fixture = await startGcpFixture();
});

afterAll(async () => {
  await fixture?.close();
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })));
});

describe('googleapis fixture transport', () => {
  it('resolve-one exports an explicit Apigee proxy revision through the proxied control plane', async () => {
    const workspace = await createWorkspace('ws10-gcp-revision');
    const result = await runCli(workspace, { INPUT_API_ID: REVISION_API_ID });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const { outputs } = readResult(workspace);
    expect(outputs['resolution-status']).toBe('resolved');
    expect(outputs['source-type']).toBe('apigee-proxy');
    expect(outputs['provider-type']).toBe('apigee');
    expect(outputs['api-id']).toBe(REVISION_API_ID);
    expect(outputs['spec-path']).toMatch(/^discovered-specs\//);
    expect(existsSync(path.join(workspace, outputs['spec-path']!))).toBe(true);

    // Transport proof: preflight and bundle download both rode the fixture.
    expect(fixture.requests.some((r) => r.host === 'cloudresourcemanager.googleapis.com' && r.path === `/v3/projects/${FIXTURE_PROJECT_ID}`)).toBe(true);
    expect(fixture.requests.some((r) => r.host === 'apigee.googleapis.com' && r.path.endsWith(`/revisions/${PROXY_REVISION}`))).toBe(true);
    expect(fixture.deniedHosts).toEqual([]);
  });

  it('downloads an Apigee archive deployment through the trusted GCS signed-URL leg', async () => {
    const workspace = await createWorkspace('ws10-gcp-archive');
    const result = await runCli(workspace, { INPUT_API_ID: ARCHIVE_API_ID });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const { outputs } = readResult(workspace);
    expect(outputs['resolution-status']).toBe('resolved');
    expect(outputs['source-type']).toBe('apigee-archive-deployment');
    expect(outputs['provider-type']).toBe('apigee');
    expect(existsSync(path.join(workspace, outputs['spec-path']!))).toBe(true);

    // The signed-URL fetch is undici (not gaxios); NODE_USE_ENV_PROXY carried
    // it through the same proxy to the storage.googleapis.com fixture host.
    expect(fixture.requests.some((r) => r.host === 'storage.googleapis.com' && r.path === '/ws10-bucket/archive.zip')).toBe(true);
    expect(fixture.deniedHosts).toEqual([]);
  });

  it('refuses a signed URL on an untrusted host without contacting it', async () => {
    const workspace = await createWorkspace('ws10-gcp-evil');
    const result = await runCli(workspace, { INPUT_API_ID: EVIL_ARCHIVE_API_ID });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const { outputs } = readResult(workspace);
    expect(outputs['resolution-status']).toBe('unresolved');
    expect(outputs['resolution-json']).toContain('not a trusted GCS endpoint');
    // The evil host was never dialed: enforcement fired before any egress and
    // the proxy would have refused (and recorded) the attempt anyway.
    expect(fixture.deniedHosts).toEqual([]);
  });

  it('fails preflight for a project that is not active', async () => {
    const workspace = await createWorkspace('ws10-gcp-inactive');
    const result = await runCli(workspace, { INPUT_PROJECT_ID: INACTIVE_PROJECT_ID });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('not active');
  });
});