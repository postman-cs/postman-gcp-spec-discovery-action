#!/usr/bin/env node
/* global AbortController, clearTimeout, process, setTimeout */
/**
 * Sanitized verifier for live GCS discovery → composite onboarding →
 * `.postman/resources.yaml`, with guarded workspace teardown.
 *
 * Inputs come only from environment variables. Receipts never include secrets,
 * project IDs, resource IDs/names, non-public URLs, spec bodies, or raw remote
 * errors.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const RECEIPT_SCHEMA_VERSION = 1;
export const DEFAULT_RESOURCES_RELATIVE = '.postman/resources.yaml';
export const DEFAULT_RECEIPT_RELATIVE = 'validation/.live-runs/gcs-onboarding-receipt.json';
export const DEFAULT_LIVE_RUNS_DIR = 'validation/.live-runs';
export const PINNED_RELEASE_TAG = 'v1.1.6';
export const EXPECTED_PROVIDER_TYPE = 'connectors-custom';
export const EXPECTED_SOURCE_TYPE = 'connectors-custom-spec';
export const EXPECTED_RESOLUTION_STATUS = 'resolved';
export const POSTMAN_API_HOST = 'https://api.getpostman.com';
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_ABSENCE_RETRY_COUNT = 5;
export const DEFAULT_ABSENCE_RETRY_DELAY_MS = 200;

export const CI_PROVIDER = 'github-actions';
export const RUNNER_KIND = 'github-hosted';
export const GCP_CREDENTIAL_CLASS = 'workload-identity-federation';
export const POSTMAN_CREDENTIAL_CLASS = 'sandbox-service-account-pmak';

/** Sanitized failure classes only — never raw remote text. */
export const FAILURE_CLASSES = Object.freeze([
  'input-invalid',
  'path-confinement',
  'symlink-rejected',
  'resources-missing',
  'resources-malformed',
  'resources-assertion-failed',
  'discovery-handoff-failed',
  'release-identity-invalid',
  'onboarding-failed',
  'foreign-workspace-name',
  'workspace-delete-failed',
  'workspace-absence-unproven',
  'api-timeout',
  'api-error',
  'teardown-failed',
  'receipt-write-failed'
]);

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SAFE_UID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PUBLIC_GITHUB_RUN_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainMapping(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function confinePathWithinRoot(rootPath, targetPath, fieldName = 'path') {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const error = new Error(`${fieldName}-outside-root`);
    error.failureClass = 'path-confinement';
    throw error;
  }
  return resolved;
}

export function assertNotSymlink(targetPath, fieldName = 'path') {
  if (!existsSync(targetPath)) return;
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    const error = new Error(`${fieldName}-symlink`);
    error.failureClass = 'symlink-rejected';
    throw error;
  }
}

function assertSafePrivatePath(liveRoot, targetPath, fieldName) {
  const root = path.resolve(liveRoot);
  const target = confinePathWithinRoot(root, targetPath, fieldName);
  let current = root;
  const relative = path.relative(root, target);
  for (const segment of relative ? relative.split(path.sep) : []) {
    assertNotSymlink(current, `${fieldName}-parent`);
    current = path.join(current, segment);
  }
  assertNotSymlink(current, fieldName);
  return target;
}

export function writeAtomicJson(filePath, value, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertNotSymlink(dir, 'json-parent');
  if (existsSync(filePath)) assertNotSymlink(filePath, 'json-path');
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(4).toString('hex')}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(tempPath, 'w', mode);
  try {
    writeSync(fd, payload, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
  return filePath;
}

export function resolveRunUrl(env = process.env) {
  const explicit = trim(env.GITHUB_RUN_URL || env.LIVE_GCS_RUN_URL);
  if (explicit) return explicit;
  const server = trim(env.GITHUB_SERVER_URL) || 'https://github.com';
  const repo = trim(env.GITHUB_REPOSITORY);
  const runId = trim(env.GITHUB_RUN_ID);
  if (!repo || !runId) return '';
  return `${server.replace(/\/+$/, '')}/${repo}/actions/runs/${runId}`;
}

function parseSafeWorkspaceUid(value) {
  const uid = trim(value);
  if (!uid) return '';
  if (!SAFE_UID_RE.test(uid)) {
    const error = new Error('input-invalid');
    error.failureClass = 'input-invalid';
    throw error;
  }
  return uid;
}

/**
 * Reconcile optional composite-output UID with resources.yaml UID.
 * Mismatch fails closed with no delete candidate.
 */
export function reconcileWorkspaceUids(outputUid, resourcesUid) {
  const output = trim(outputUid);
  const resources = trim(resourcesUid);
  if (output && resources && output !== resources) {
    return { mismatch: true, workspaceUid: '' };
  }
  return { mismatch: false, workspaceUid: resources || output || '' };
}

export function readVerifierInputs(env = process.env) {
  const runId = trim(env.GITHUB_RUN_ID);
  const runAttempt = trim(env.GITHUB_RUN_ATTEMPT);
  const runUrl = resolveRunUrl(env);
  const releaseTag = trim(env.RELEASE_TAG || env.LIVE_GCS_RELEASE_TAG) || PINNED_RELEASE_TAG;
  // Runtime-observed only — never substitute a hardcoded expected SHA.
  const releaseCommit = trim(env.RELEASE_COMMIT || env.LIVE_GCS_RELEASE_COMMIT);
  const discoveryStatus = trim(env.RESOLUTION_STATUS || env.DISCOVERY_STATUS);
  const discoveryProvider = trim(env.PROVIDER_TYPE || env.DISCOVERY_PROVIDER);
  const discoverySource = trim(env.SOURCE_TYPE || env.DISCOVERY_SOURCE);
  const specPath = trim(env.SPEC_PATH || env.DISCOVERY_SPEC_PATH);
  const expectedWorkspaceName = trim(env.PROJECT_NAME || env.EXPECTED_WORKSPACE_NAME);
  const onboardingOutcome = trim(env.ONBOARD_OUTCOME || env.ONBOARDING_OUTCOME);
  const postmanApiKey = trim(env.POSTMAN_API_KEY);
  const resourcesPath = trim(env.RESOURCES_PATH) || DEFAULT_RESOURCES_RELATIVE;
  const receiptPath = trim(env.RECEIPT_PATH) || DEFAULT_RECEIPT_RELATIVE;
  const workspaceUid = parseSafeWorkspaceUid(env.WORKSPACE_UID || env.COMPOSITE_WORKSPACE_UID);

  const missing = [];
  if (!runId) missing.push('GITHUB_RUN_ID');
  if (!runAttempt) missing.push('GITHUB_RUN_ATTEMPT');
  if (!runUrl) missing.push('GITHUB_RUN_URL');
  if (!releaseCommit) missing.push('RELEASE_COMMIT');
  if (!discoveryStatus) missing.push('RESOLUTION_STATUS');
  if (!discoveryProvider) missing.push('PROVIDER_TYPE');
  if (!discoverySource) missing.push('SOURCE_TYPE');
  if (!specPath) missing.push('SPEC_PATH');
  if (!expectedWorkspaceName) missing.push('PROJECT_NAME');
  if (!onboardingOutcome) missing.push('ONBOARD_OUTCOME');
  if (!postmanApiKey) missing.push('POSTMAN_API_KEY');
  if (missing.length) {
    const error = new Error('input-invalid');
    error.failureClass = 'input-invalid';
    error.missing = missing;
    throw error;
  }
  if (!PUBLIC_GITHUB_RUN_URL_RE.test(runUrl)) {
    const error = new Error('input-invalid-run-url');
    error.failureClass = 'input-invalid';
    throw error;
  }
  if (!COMMIT_RE.test(releaseCommit)) {
    const error = new Error('release-identity-invalid');
    error.failureClass = 'release-identity-invalid';
    throw error;
  }

  return {
    runId,
    runAttempt: Number(runAttempt),
    runUrl,
    releaseTag,
    releaseCommit,
    discoveryStatus,
    discoveryProvider,
    discoverySource,
    specPath,
    expectedWorkspaceName,
    onboardingOutcome,
    postmanApiKey,
    resourcesPath,
    receiptPath,
    workspaceUid
  };
}

function emptyArtifactAssertions() {
  return {
    resourcesYamlPresent: false,
    resourcesYamlValid: false,
    workspaceUidPresent: false,
    specUidPresent: false,
    baselineCollectionUidPresent: false,
    smokeCollectionUidPresent: false,
    contractCollectionUidPresent: false,
    discoveredSpecMapped: false,
    discoveryHandoffValid: false,
    releaseIdentityValid: false
  };
}

export function sanitizeReceipt(partial) {
  const artifactAssertions = {
    ...emptyArtifactAssertions(),
    ...(isPlainMapping(partial.artifactAssertions) ? partial.artifactAssertions : {})
  };
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    capturedAt: typeof partial.capturedAt === 'string' ? partial.capturedAt : new Date().toISOString(),
    releaseTag: String(partial.releaseTag ?? ''),
    releaseCommit: String(partial.releaseCommit ?? ''),
    runId: String(partial.runId ?? ''),
    runAttempt: Number(partial.runAttempt ?? 0),
    runUrl: String(partial.runUrl ?? ''),
    ciProvider: CI_PROVIDER,
    runnerKind: RUNNER_KIND,
    gcpCredentialClass: GCP_CREDENTIAL_CLASS,
    postmanCredentialClass: POSTMAN_CREDENTIAL_CLASS,
    discoveryProvider: String(partial.discoveryProvider ?? ''),
    discoverySource: String(partial.discoverySource ?? ''),
    artifactAssertions,
    onboardingStatus: String(partial.onboardingStatus ?? 'unknown'),
    teardownStatus: String(partial.teardownStatus ?? 'pending')
  };
  if (partial.failureClass) {
    const failureClass = String(partial.failureClass);
    if (FAILURE_CLASSES.includes(failureClass)) {
      receipt.failureClass = failureClass;
    } else {
      receipt.failureClass = 'api-error';
    }
  }
  return receipt;
}

function normalizePosix(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/g, '');
}

function candidateSpecKeys(specPath) {
  const normalized = normalizePosix(specPath).replace(/^\/+/, '');
  const keys = new Set([normalized, `../${normalized}`]);
  if (normalized.startsWith('../')) keys.add(normalized.slice(3));
  return keys;
}

function resolveResourceMaps(state) {
  const cloud = isPlainMapping(state.cloudResources) ? state.cloudResources : {};
  const canonical = isPlainMapping(state.canonical) ? state.canonical : {};
  const local = isPlainMapping(state.localResources) ? state.localResources : {};
  return {
    specs: {
      ...(isPlainMapping(cloud.specs) ? cloud.specs : {}),
      ...(isPlainMapping(canonical.specs) ? canonical.specs : {})
    },
    collections: {
      ...(isPlainMapping(cloud.collections) ? cloud.collections : {}),
      ...(isPlainMapping(canonical.collections) ? canonical.collections : {})
    },
    localSpecs: isPlainMapping(local.specs) ? local.specs : {},
    localCollections: Array.isArray(local.collections) ? local.collections : []
  };
}

function findUid(map, predicate) {
  for (const [key, value] of Object.entries(map)) {
    if (!predicate(normalizePosix(key))) continue;
    const uid = trim(value);
    if (uid && SAFE_UID_RE.test(uid)) return { key, uid };
  }
  return null;
}

export function parseResourcesYamlMapping(rawYaml) {
  let parsed;
  try {
    parsed = parseYaml(rawYaml);
  } catch {
    const error = new Error('resources-malformed');
    error.failureClass = 'resources-malformed';
    throw error;
  }
  if (!isPlainMapping(parsed)) {
    const error = new Error('resources-malformed');
    error.failureClass = 'resources-malformed';
    throw error;
  }
  return parsed;
}

/** Stage 1: extract a safe workspace UID as soon as the workspace field is readable. */
export function extractWorkspaceUidFromResources(parsedOrRaw) {
  const parsed =
    typeof parsedOrRaw === 'string' ? parseResourcesYamlMapping(parsedOrRaw) : parsedOrRaw;
  if (!isPlainMapping(parsed)) return '';
  const workspace = isPlainMapping(parsed.workspace) ? parsed.workspace : null;
  const workspaceUid = trim(workspace?.id ?? workspace?.uid ?? '');
  if (!workspaceUid || !SAFE_UID_RE.test(workspaceUid)) return '';
  return workspaceUid;
}

/** Stage 2: spec/collection mapping assertions (workspace UID already extracted). */
export function assertResourceMappings(parsed, inputs, workspaceUid) {
  const maps = resolveResourceMaps(parsed);
  const specKeys = candidateSpecKeys(inputs.specPath);
  const cloudSpec = findUid(
    maps.specs,
    (key) => specKeys.has(key) || [...specKeys].some((candidate) => key.endsWith(candidate))
  );
  const localSpecListed =
    Object.keys(maps.localSpecs).some((key) => specKeys.has(normalizePosix(key))) ||
    maps.localCollections.some((entry) => typeof entry === 'string' && specKeys.has(normalizePosix(entry)));

  if (!cloudSpec) {
    const error = new Error('resources-assertion-failed');
    error.failureClass = 'resources-assertion-failed';
    error.workspaceUid = workspaceUid;
    throw error;
  }

  const projectName = inputs.expectedWorkspaceName;
  const baseline = findUid(
    maps.collections,
    (key) =>
      key.endsWith(`/collections/${projectName}`) ||
      key.endsWith(`/collections/[Baseline] ${projectName}`)
  );
  const smoke = findUid(maps.collections, (key) => key.endsWith(`/collections/[Smoke] ${projectName}`));
  const contract = findUid(
    maps.collections,
    (key) => key.endsWith(`/collections/[Contract] ${projectName}`)
  );

  if (!baseline || !smoke || !contract) {
    const error = new Error('resources-assertion-failed');
    error.failureClass = 'resources-assertion-failed';
    error.workspaceUid = workspaceUid;
    throw error;
  }

  return {
    workspaceUid,
    specUid: cloudSpec.uid,
    baselineCollectionUid: baseline.uid,
    smokeCollectionUid: smoke.uid,
    contractCollectionUid: contract.uid,
    discoveredSpecMapped: true,
    localOrCloudSpecMapped: Boolean(cloudSpec) && (localSpecListed || Boolean(cloudSpec))
  };
}

export function assertResourcesYaml(rawYaml, inputs) {
  const parsed = parseResourcesYamlMapping(rawYaml);
  const workspaceUid = extractWorkspaceUidFromResources(parsed);
  if (!workspaceUid) {
    const error = new Error('resources-assertion-failed');
    error.failureClass = 'resources-assertion-failed';
    throw error;
  }
  return assertResourceMappings(parsed, inputs, workspaceUid);
}

export function assertDiscoveryAndRelease(inputs) {
  const discoveryHandoffValid =
    inputs.discoveryStatus === EXPECTED_RESOLUTION_STATUS &&
    inputs.discoveryProvider === EXPECTED_PROVIDER_TYPE &&
    inputs.discoverySource === EXPECTED_SOURCE_TYPE;
  const releaseIdentityValid =
    inputs.releaseTag === PINNED_RELEASE_TAG && COMMIT_RE.test(inputs.releaseCommit);

  if (!releaseIdentityValid) {
    const error = new Error('release-identity-invalid');
    error.failureClass = 'release-identity-invalid';
    throw error;
  }
  if (!discoveryHandoffValid) {
    const error = new Error('discovery-handoff-failed');
    error.failureClass = 'discovery-handoff-failed';
    throw error;
  }
  return { discoveryHandoffValid, releaseIdentityValid };
}

function classifyFetchFailure(error) {
  const name = error && typeof error === 'object' ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /aborted|timeout|timed out/i.test(message)
  ) {
    return 'api-timeout';
  }
  return 'api-error';
}

async function postmanRequest(deps, apiKey, method, workspaceUid) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const error = new Error('api-error');
    error.failureClass = 'api-error';
    throw error;
  }
  if (!SAFE_UID_RE.test(workspaceUid)) {
    const error = new Error('input-invalid');
    error.failureClass = 'input-invalid';
    throw error;
  }
  const timeoutMs = Number(deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${POSTMAN_API_HOST}/workspaces/${workspaceUid}`, {
      method,
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json'
      },
      signal: deps.signal ?? controller.signal
    });
    return response;
  } catch (error) {
    const failureClass = classifyFetchFailure(error);
    const wrapped = new Error(failureClass);
    wrapped.failureClass = failureClass;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyWorkspaceName(deps, apiKey, workspaceUid, expectedName) {
  const response = await postmanRequest(deps, apiKey, 'GET', workspaceUid);
  if (response.status === 404) {
    return { exists: false, nameMatches: false };
  }
  if (!response.ok) {
    const error = new Error('api-error');
    error.failureClass = 'api-error';
    throw error;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    const error = new Error('api-error');
    error.failureClass = 'api-error';
    throw error;
  }
  const workspace = isPlainMapping(body?.workspace) ? body.workspace : isPlainMapping(body) ? body : null;
  const name = trim(workspace?.name);
  return { exists: true, nameMatches: name === expectedName };
}

export async function deleteWorkspace(deps, apiKey, workspaceUid) {
  const response = await postmanRequest(deps, apiKey, 'DELETE', workspaceUid);
  if (response.status === 404) return { deleted: false, alreadyAbsent: true };
  if (!response.ok) {
    const error = new Error('workspace-delete-failed');
    error.failureClass = 'workspace-delete-failed';
    throw error;
  }
  return { deleted: true, alreadyAbsent: false };
}

export async function verifyWorkspaceAbsent(deps, apiKey, workspaceUid) {
  const retryCount = Math.max(1, Number(deps.absenceRetryCount ?? DEFAULT_ABSENCE_RETRY_COUNT));
  const delayMs = Math.max(0, Number(deps.absenceRetryDelayMs ?? DEFAULT_ABSENCE_RETRY_DELAY_MS));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    const response = await postmanRequest(deps, apiKey, 'GET', workspaceUid);
    if (response.status === 404) return true;
    if (!response.ok && response.status !== 200) {
      const error = new Error('api-error');
      error.failureClass = 'api-error';
      throw error;
    }
    if (attempt < retryCount && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  const error = new Error('workspace-absence-unproven');
  error.failureClass = 'workspace-absence-unproven';
  throw error;
}

export async function teardownVerifiedWorkspace(deps, apiKey, workspaceUid, expectedName) {
  const identity = await verifyWorkspaceName(deps, apiKey, workspaceUid, expectedName);
  if (!identity.exists) {
    return { status: 'pass', deleted: false, alreadyAbsent: true };
  }
  if (!identity.nameMatches) {
    const error = new Error('foreign-workspace-name');
    error.failureClass = 'foreign-workspace-name';
    throw error;
  }
  await deleteWorkspace(deps, apiKey, workspaceUid);
  await verifyWorkspaceAbsent(deps, apiKey, workspaceUid);
  return { status: 'pass', deleted: true, alreadyAbsent: false };
}

async function guardedCleanup(deps, apiKey, workspaceUid, expectedName) {
  if (!workspaceUid || !apiKey || !expectedName) return { status: 'skipped' };
  try {
    return await teardownVerifiedWorkspace(deps, apiKey, workspaceUid, expectedName);
  } catch (error) {
    return {
      status: 'fail',
      failureClass: FAILURE_CLASSES.includes(error?.failureClass) ? error.failureClass : 'teardown-failed'
    };
  }
}

function resolvePaths(root, inputs) {
  const resourcesAbsolute = confinePathWithinRoot(root, inputs.resourcesPath, 'resources-path');
  assertNotSymlink(resourcesAbsolute, 'resources-path');
  const liveRoot = path.join(root, DEFAULT_LIVE_RUNS_DIR);
  const receiptAbsolute = path.isAbsolute(inputs.receiptPath)
    ? path.resolve(inputs.receiptPath)
    : path.resolve(root, inputs.receiptPath);
  const confinedReceipt = assertSafePrivatePath(liveRoot, receiptAbsolute, 'receipt-path');
  return { resourcesAbsolute, receiptAbsolute: confinedReceipt, liveRoot };
}

export async function verifyLiveGcsOnboarding(options = {}) {
  const env = options.env ?? process.env;
  const root = path.resolve(options.root ?? process.cwd());
  const deps = {
    fetchImpl: options.fetchImpl ?? options.fetch ?? globalThis.fetch,
    fetchTimeoutMs: options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    absenceRetryCount: options.absenceRetryCount ?? DEFAULT_ABSENCE_RETRY_COUNT,
    absenceRetryDelayMs: options.absenceRetryDelayMs ?? DEFAULT_ABSENCE_RETRY_DELAY_MS,
    sleep: options.sleep,
    signal: options.signal,
    now: options.now ?? (() => new Date().toISOString())
  };

  const artifactAssertions = emptyArtifactAssertions();
  let inputs;
  let workspaceUid = '';
  let teardownStatus = 'pending';
  let onboardingStatus = 'unknown';
  let failureClass;
  let teardownCompleted = false;
  let refuseDelete = false;

  const finish = async (ok) => {
    const receipt = sanitizeReceipt({
      capturedAt: deps.now(),
      releaseTag: inputs?.releaseTag ?? '',
      releaseCommit: inputs?.releaseCommit ?? '',
      runId: inputs?.runId ?? '',
      runAttempt: inputs?.runAttempt ?? 0,
      runUrl: inputs?.runUrl ?? '',
      discoveryProvider: inputs?.discoveryProvider ?? '',
      discoverySource: inputs?.discoverySource ?? '',
      artifactAssertions,
      onboardingStatus,
      teardownStatus,
      failureClass: ok ? undefined : failureClass
    });

    let receiptPath = '';
    try {
      if (inputs) {
        const paths = resolvePaths(root, inputs);
        receiptPath = paths.receiptAbsolute;
        writeAtomicJson(receiptPath, receipt, { mode: 0o600 });
      } else if (options.receiptPathFallback) {
        receiptPath = confinePathWithinRoot(root, options.receiptPathFallback, 'receipt-path');
        writeAtomicJson(receiptPath, receipt, { mode: 0o600 });
      }
    } catch (error) {
      failureClass = error?.failureClass && FAILURE_CLASSES.includes(error.failureClass)
        ? error.failureClass
        : 'receipt-write-failed';
      const failed = sanitizeReceipt({ ...receipt, failureClass, teardownStatus });
      return { ok: false, exitCode: 1, receipt: failed, receiptPath, failureClass };
    }

    return {
      ok,
      exitCode: ok ? 0 : 1,
      receipt,
      receiptPath,
      failureClass: ok ? undefined : failureClass,
      workspaceUid: workspaceUid || undefined
    };
  };

  try {
    inputs = readVerifierInputs(env);
  } catch (error) {
    failureClass = error?.failureClass || 'input-invalid';
    return finish(false);
  }

  try {
    const handoff = assertDiscoveryAndRelease(inputs);
    artifactAssertions.discoveryHandoffValid = handoff.discoveryHandoffValid;
    artifactAssertions.releaseIdentityValid = handoff.releaseIdentityValid;
  } catch (error) {
    failureClass = error?.failureClass || 'discovery-handoff-failed';
    onboardingStatus = inputs.onboardingOutcome === 'success' ? 'failed' : inputs.onboardingOutcome;
    return finish(false);
  }

  onboardingStatus = inputs.onboardingOutcome;
  if (inputs.onboardingOutcome !== 'success') {
    failureClass = 'onboarding-failed';
  }

  let resourcesAbsolute;
  try {
    ({ resourcesAbsolute } = resolvePaths(root, inputs));
  } catch (error) {
    failureClass = error?.failureClass || 'path-confinement';
    return finish(false);
  }

  const outputUid = inputs.workspaceUid;

  try {
    if (!existsSync(resourcesAbsolute)) {
      if (inputs.onboardingOutcome === 'success') {
        failureClass = 'resources-missing';
      }
      // Recoverable partial state: composite workspace output alone can drive guarded cleanup.
      const reconciled = reconcileWorkspaceUids(outputUid, '');
      workspaceUid = reconciled.workspaceUid;
    } else {
      artifactAssertions.resourcesYamlPresent = true;
      assertNotSymlink(resourcesAbsolute, 'resources-path');
      const raw = readFileSync(resourcesAbsolute, 'utf8');
      const parsed = parseResourcesYamlMapping(raw);
      // Stage 1 — preserve UID for finally cleanup even if stage 2 fails.
      const resourcesUid = extractWorkspaceUidFromResources(parsed);
      if (resourcesUid) {
        artifactAssertions.workspaceUidPresent = true;
      }
      const reconciled = reconcileWorkspaceUids(outputUid, resourcesUid);
      if (reconciled.mismatch) {
        failureClass = 'resources-assertion-failed';
        refuseDelete = true;
        workspaceUid = '';
      } else {
        workspaceUid = reconciled.workspaceUid;
        // Stage 2 — mapping assertions.
        const asserted = assertResourceMappings(parsed, inputs, resourcesUid || workspaceUid);
        artifactAssertions.resourcesYamlValid = true;
        artifactAssertions.specUidPresent = true;
        artifactAssertions.baselineCollectionUidPresent = true;
        artifactAssertions.smokeCollectionUidPresent = true;
        artifactAssertions.contractCollectionUidPresent = true;
        artifactAssertions.discoveredSpecMapped = asserted.discoveredSpecMapped;
        if (asserted.workspaceUid) {
          artifactAssertions.workspaceUidPresent = true;
          workspaceUid = asserted.workspaceUid;
        }
      }
    }
  } catch (error) {
    if (!failureClass) {
      failureClass = error?.failureClass || 'resources-assertion-failed';
    }
    if (error?.failureClass === 'resources-malformed') {
      artifactAssertions.resourcesYamlPresent = true;
      // YAML unreadable for resources UID; composite output may still allow cleanup.
      if (!refuseDelete && !workspaceUid && outputUid) {
        workspaceUid = outputUid;
      }
    } else if (error?.workspaceUid && !refuseDelete) {
      const preserved = trim(error.workspaceUid);
      if (preserved && SAFE_UID_RE.test(preserved)) {
        const reconciled = reconcileWorkspaceUids(outputUid, preserved);
        if (reconciled.mismatch) {
          failureClass = 'resources-assertion-failed';
          refuseDelete = true;
          workspaceUid = '';
        } else {
          workspaceUid = reconciled.workspaceUid;
          artifactAssertions.workspaceUidPresent = true;
        }
      }
    } else if (!refuseDelete && !workspaceUid && outputUid) {
      workspaceUid = outputUid;
    }
  }

  try {
    if (workspaceUid && !refuseDelete) {
      const teardown = await teardownVerifiedWorkspace(
        deps,
        inputs.postmanApiKey,
        workspaceUid,
        inputs.expectedWorkspaceName
      );
      teardownStatus = teardown.status;
      teardownCompleted = true;
    } else if (refuseDelete) {
      teardownStatus = 'skipped';
    } else if (!failureClass) {
      failureClass = 'resources-assertion-failed';
      teardownStatus = 'skipped';
    } else {
      teardownStatus = 'skipped';
    }
  } catch (error) {
    failureClass = error?.failureClass || 'teardown-failed';
    teardownStatus = 'fail';
  } finally {
    if (workspaceUid && !teardownCompleted && !refuseDelete) {
      const cleanup = await guardedCleanup(
        deps,
        inputs.postmanApiKey,
        workspaceUid,
        inputs.expectedWorkspaceName
      );
      if (cleanup.status === 'pass') {
        teardownStatus = 'pass';
      } else if (cleanup.status === 'fail') {
        teardownStatus = 'fail';
        failureClass = failureClass || cleanup.failureClass || 'teardown-failed';
      }
    }
  }

  const ok =
    !failureClass &&
    artifactAssertions.resourcesYamlValid &&
    artifactAssertions.discoveryHandoffValid &&
    artifactAssertions.releaseIdentityValid &&
    teardownStatus === 'pass' &&
    onboardingStatus === 'success';

  if (!ok && !failureClass) failureClass = 'resources-assertion-failed';
  return finish(ok);
}

export async function runCli(options = {}) {
  const result = await verifyLiveGcsOnboarding({
    receiptPathFallback: DEFAULT_RECEIPT_RELATIVE,
    ...options
  });
  if (!result.ok) {
    process.exitCode = result.exitCode || 1;
  }
  return result;
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (entrypoint && path.resolve(entrypoint) === path.resolve(here)) {
  runCli().catch(() => {
    process.exitCode = 1;
  });
}
