#!/usr/bin/env node
/* global console, process, URL */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const cases = ['gateway-explicit-api-id', 'gateway-discovery', 'endpoints-explicit-api-id', 'endpoints-discovery', 'apigee-discovery', 'discover-many', 'iac-single', 'ambiguity'];

export function parseFlags(argv) {
  return { provision: argv.includes('--provision'), teardown: argv.includes('--teardown') };
}

export function requiredEnv(env) {
  const projectId = String(env.GCP_PROJECT_ID ?? '').trim();
  if (!projectId) throw new Error('GCP_PROJECT_ID is required');
  return {
    projectId,
    location: String(env.GCP_LOCATION ?? '').trim() || 'global',
    apigeeOrg: String(env.GCP_APIGEE_ORG ?? projectId).trim(),
    apigeeEnv: String(env.GCP_APIGEE_ENV ?? 'test-env').trim()
  };
}

export function shouldDeleteGatewayResource({ manifest, resourceName, marker }) {
  return Boolean(manifest?.runMarker && manifest?.gatewayName && resourceName === manifest.gatewayName && marker === manifest.runMarker);
}

export function shouldDeleteApigeeProxy({ manifest, proxyName, marker }) {
  return Boolean(manifest?.runMarker && manifest?.proxyName && proxyName === manifest.proxyName && marker === manifest.runMarker);
}

export function classifyProbeError(message) {
  const text = String(message ?? '');
  if (/\b(400|401|403)\b|invalid argument|unauthenticated|permission denied|forbidden/i.test(text)) return 'fatal';
  return 'retryable';
}

export function isResourceNotFoundError(error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /\b404\b|not found|does not exist/i.test(text);
}

export function toEvidenceResult(name, status, resolution) {
  return { name, status, sourceType: resolution?.sourceType ?? '', providerType: resolution?.providerType ?? '', specFormat: resolution?.specFormat ?? '' };
}

export function buildEvidence(results) {
  const passed = results.filter((result) => result.status === 'pass').length;
  return { schemaVersion: 1, capturedAt: new Date().toISOString().slice(0, 10), cases: results.length, passed, failed: results.length - passed, results };
}

function defaultRunner(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function gcloud(runner, args) { return runner('gcloud', args); }
function accessToken(runner) { return String(gcloud(runner, ['auth', 'print-access-token'])).trim(); }
function rest(runner, token, method, url, body) {
  const args = ['-fsS', '-X', method, '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json'];
  if (body !== undefined) args.push('--data-binary', typeof body === 'string' ? body : JSON.stringify(body));
  return runner('curl', [...args, url]);
}

function restUploadZip(runner, token, url, zipPath) {
  return runner('curl', ['-fsS', '-X', 'POST', '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/octet-stream', '--data-binary', `@${zipPath}`, url]);
}

function swagger2Document({ title, host, backend }) {
  const lines = ['swagger: "2.0"', 'info:', `  title: ${title}`, '  version: 1.0.0'];
  if (host) lines.push(`host: ${host}`);
  if (backend) lines.push('x-google-backend:', '  address: https://httpbin.org');
  lines.push('schemes:', '  - https', 'paths:', '  /health:', '    get:', '      operationId: getHealth', '      responses:', "        '200':", '          description: healthy');
  return `${lines.join('\n')}\n`;
}

function runCli(runner, cliPath, args, workspace) {
  runner(process.execPath, [cliPath, ...args], { cwd: workspace });
  return JSON.parse(String(readFileSyncSafe(path.join(workspace, 'result.json'))));
}

function readFileSyncSafe(filePath) {
  if (!existsSync(filePath)) throw new Error(`CLI produced no result file at ${filePath}`);
  return readFileSync(filePath, 'utf8');
}

async function seedIac(workspace) {
  await mkdir(path.join(workspace, 'infra'), { recursive: true });
  await cp(path.join(repoRoot, 'validation/fixtures/gcp/iac-single/main.tf'), path.join(workspace, 'infra/main.tf'));
  await cp(path.join(repoRoot, 'validation/fixtures/gcp/openapi.yaml'), path.join(workspace, 'infra/openapi.yaml'));
}

async function seedAmbiguity(workspace) {
  await mkdir(path.join(workspace, 'infra'), { recursive: true });
  const source = await readFile(path.join(repoRoot, 'validation/fixtures/gcp/iac-single/main.tf'), 'utf8');
  await writeFile(path.join(workspace, 'infra/alpha.tf'), source.replaceAll('postman-live-api', 'postman-alpha-api'));
  await writeFile(path.join(workspace, 'infra/bravo.tf'), source.replaceAll('postman-live-api', 'postman-bravo-api'));
  await cp(path.join(repoRoot, 'validation/fixtures/gcp/openapi.yaml'), path.join(workspace, 'infra/openapi.yaml'));
}

async function provision({ runner, token, env, manifest }) {
  gcloud(runner, ['services', 'enable', 'apigateway.googleapis.com', 'servicemanagement.googleapis.com', 'servicecontrol.googleapis.com', '--project', env.projectId]);
  const spec = path.join(repoRoot, 'validation/fixtures/gcp/openapi.yaml');
  const managed = await mkdtemp(path.join(os.tmpdir(), 'gcp-managed-'));
  let endpointsConfigId = '';
  try {
    // API Gateway and Cloud Endpoints accept OpenAPI 2.0 (Swagger) documents only.
    const gatewaySpecPath = path.join(managed, 'gateway.yaml');
    await writeFile(gatewaySpecPath, swagger2Document({ title: manifest.gatewayName, backend: true }));
    gcloud(runner, ['api-gateway', 'apis', 'create', manifest.gatewayName, '--project', env.projectId, '--labels', `postman-run-marker=${manifest.runMarker}`]);
    gcloud(runner, ['api-gateway', 'api-configs', 'create', manifest.gatewayConfigName, '--api', manifest.gatewayName, '--openapi-spec', gatewaySpecPath, '--project', env.projectId, '--labels', `postman-run-marker=${manifest.runMarker}`]);
    const endpointsPath = path.join(managed, 'endpoints.yaml');
    await writeFile(endpointsPath, swagger2Document({ title: manifest.endpointsService, host: manifest.endpointsService }));
    gcloud(runner, ['endpoints', 'services', 'deploy', endpointsPath, '--project', env.projectId]);
    endpointsConfigId = String(gcloud(runner, ['endpoints', 'configs', 'list', '--service', manifest.endpointsService, '--project', env.projectId, '--format', 'value(id)', '--limit', '1'])).trim().split('\n')[0] ?? '';
    const proxyZip = await mkdtemp(path.join(os.tmpdir(), 'gcp-apigee-'));
    await mkdir(path.join(proxyZip, 'apiproxy/resources/oas'), { recursive: true });
    await mkdir(path.join(proxyZip, 'apiproxy/proxies'), { recursive: true });
    await writeFile(path.join(proxyZip, 'apiproxy', `${manifest.proxyName}.xml`), `<APIProxy name="${manifest.proxyName}"><Description>postman-run-marker=${manifest.runMarker}</Description></APIProxy>`);
    await writeFile(path.join(proxyZip, 'apiproxy/proxies/default.xml'), '<ProxyEndpoint name="default"><HTTPProxyConnection><BasePath>/live</BasePath></HTTPProxyConnection><RouteRule name="none"/></ProxyEndpoint>');
    await writeFile(path.join(proxyZip, 'apiproxy/resources/oas/openapi.yaml'), await readFile(spec));
    const zip = path.join(proxyZip, 'proxy.zip');
    runner('zip', ['-qr', zip, 'apiproxy'], { cwd: proxyZip });
    try {
      restUploadZip(runner, token, `https://apigee.googleapis.com/v1/organizations/${env.apigeeOrg}/apis?action=import&name=${manifest.proxyName}`, zip);
    } finally { await rm(proxyZip, { recursive: true, force: true }); }
  } finally { await rm(managed, { recursive: true, force: true }); }
  return { endpointsConfigId };
}

async function teardown({ runner, token, env, manifest, log }) {
  if (!shouldDeleteGatewayResource({ manifest, resourceName: manifest.gatewayName, marker: manifest.runMarker })) throw new Error('REFUSING Gateway deletion: marker or name mismatch');
  try { gcloud(runner, ['api-gateway', 'api-configs', 'delete', manifest.gatewayConfigName, '--api', manifest.gatewayName, '--project', env.projectId, '--quiet']); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
  try { gcloud(runner, ['api-gateway', 'apis', 'delete', manifest.gatewayName, '--project', env.projectId, '--quiet']); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
  try { gcloud(runner, ['endpoints', 'services', 'delete', manifest.endpointsService, '--project', env.projectId, '--quiet']); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
  if (!shouldDeleteApigeeProxy({ manifest, proxyName: manifest.proxyName, marker: manifest.runMarker })) throw new Error('REFUSING Apigee proxy deletion: marker or name mismatch');
  try { rest(runner, token, 'DELETE', `https://apigee.googleapis.com/v1/organizations/${env.apigeeOrg}/apis/${manifest.proxyName}`); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
  log('Deleted only current-run Gateway, Endpoints, and Apigee resources');
}

async function runCases({ runner, cliPath, env, manifest, endpointsConfigId, log }) {
  const results = [];
  const execute = async (name, setup, args, expectedSource) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), `gcp-live-${name}-`));
    try {
      if (setup) await setup(workspace);
      const result = runCli(runner, cliPath, [...args, '--project-id', env.projectId, '--repo-root', workspace, '--result-json', 'result.json'], workspace);
      const resolution = result.resolution ?? result.discovered?.[0];
      if (name === 'ambiguity') {
        if (result.resolution?.status !== 'unresolved' || (result.resolution.rankedCandidates?.length ?? 0) < 2) throw new Error('expected unresolved ambiguity');
      } else if (!resolution || (result.resolution && result.resolution.status !== 'resolved')) throw new Error('expected resolved result');
      if (expectedSource && resolution.sourceType !== expectedSource) throw new Error(`expected ${expectedSource}, got ${resolution.sourceType}`);
      results.push(toEvidenceResult(name, 'pass', resolution));
    } catch (error) { results.push(toEvidenceResult(name, 'fail')); log(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { await rm(workspace, { recursive: true, force: true }); }
  };
  await execute(cases[0], null, ['--api-id', `projects/${env.projectId}/locations/global/apis/${manifest.gatewayName}/configs/${manifest.gatewayConfigName}`], 'api-gateway-config');
  await execute(cases[1], null, ['--expected-service-name', manifest.gatewayName], 'api-gateway-config');
  await execute(cases[2], null, ['--api-id', `services/${manifest.endpointsService}/configs/${endpointsConfigId}`], 'cloud-endpoints-config');
  await execute(cases[3], null, ['--expected-service-name', manifest.endpointsService], 'cloud-endpoints-config');
  await execute(cases[4], null, ['--expected-service-name', manifest.proxyName], 'apigee-proxy');
  await execute(cases[5], null, ['--mode', 'discover-many'], null);
  await execute(cases[6], seedIac, ['--preflight-checks', 'false'], 'iac-embedded');
  await execute(cases[7], seedAmbiguity, ['--preflight-checks', 'false'], null);
  return results;
}

export async function runLiveValidation({ argv = process.argv.slice(2), env: rawEnv = process.env, deps = {} } = {}) {
  const flags = parseFlags(argv);
  if (!flags.provision || !flags.teardown) throw new Error('Live validation requires --provision --teardown');
  const env = requiredEnv(rawEnv);
  const runner = deps.runner ?? defaultRunner;
  const log = deps.log ?? ((line) => console.error(line));
  const suffix = randomBytes(4).toString('hex');
  const manifest = { runMarker: `postman-${suffix}`, gatewayName: `postman-live-${suffix}`, gatewayConfigName: `postman-live-config-${suffix}`, endpointsService: `postman-live-${suffix}.endpoints.${env.projectId}.cloud.goog`, proxyName: `postman-live-${suffix}` };
  const cliPath = path.join(repoRoot, 'dist/cli.cjs');
  if (!existsSync(cliPath)) throw new Error(`Missing CLI bundle at ${cliPath}; run npm run build first`);
  const token = accessToken(runner);
  let evidence;
  try {
    const { endpointsConfigId } = await provision({ runner, token, env, manifest });
    evidence = buildEvidence(await runCases({ runner, cliPath, env, manifest, endpointsConfigId, log }));
    await writeFile(path.join(repoRoot, 'validation/evidence/live-gcp-surfaces.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    if (evidence.failed) throw new Error(`${evidence.failed} live validation case(s) failed`);
  } finally { await teardown({ runner, token, env, manifest, log }); }
  return evidence;
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = path.resolve(new URL(import.meta.url).pathname);
if (entrypoint === here) runLiveValidation().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
