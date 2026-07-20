#!/usr/bin/env node
/* global console, process, URL */
/**
 * POS-387 live GCP validation runner (operator-triggered; never PR CI).
 *
 * Binds a schema-v2 sanitized receipt to exact compiled dist bytes, provisions
 * run-scoped Gateway/Endpoints/Apigee proxy fixtures, exercises the compiled
 * CLI, covers every retained provider via provisioned cases / optional fixture
 * map / authenticated probe substitute, and tears down only current-run resources.
 */
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();

export const PROJECT_SCOPE_ALIAS = 'live-validation-project';
export const FIXTURES_ENV = 'GCP_LIVE_FIXTURES_JSON';
export const LEGACY_UNBOUND = 'legacy-unbound';
export const EVIDENCE_SCHEMA_VERSION = 2;

/** Mirrors src/contracts.ts RETAINED_PROVIDER_ORDER — tests assert no drift. */
export const RETAINED_PROVIDER_ORDER = Object.freeze([
  'api-gateway',
  'cloud-endpoints',
  'apigee',
  'api-hub',
  'apigee-registry',
  'app-integration',
  'connectors-custom',
  'apigee-portal',
  'vertex-extensions',
  'agent-engines',
  'dialogflow-tools',
  'ces-toolsets',
  'iac-local'
]);

export const VALIDATION_MODES = Object.freeze(['exact-bytes', 'semantic-openapi', 'manual-derived-blocked']);

export const SUBSTITUTE_REASON_CODES = Object.freeze([
  'iam-denied',
  'api-unavailable',
  'product-deprecated',
  'registry-unsupported'
]);

export const FAIL_REASON_CODES = Object.freeze([
  'missing-fixture',
  'exact-bytes-mismatch',
  'semantic-mismatch',
  'manual-derived-not-blocked',
  'unexpected-source-type',
  'cli-failed',
  'probe-inconclusive',
  'teardown-failed',
  'residue-detected',
  'absence-unprovable',
  'iam-denied',
  'dist-missing',
  'dist-dirty',
  'fixture-schema-invalid'
]);

/**
 * Provider-derived coverage matrix. Every retained provider appears at least
 * once. Apigee and API Hub expose multiple authoritative source surfaces.
 * Slots with `satisfiedBy` may be completed by provisioned historical cases.
 */
export const LIVE_COVERAGE_MATRIX = Object.freeze([
  { name: 'api-gateway', providerType: 'api-gateway', expectedSourceTypes: ['api-gateway-config'], validationMode: 'exact-bytes', satisfiedBy: ['gateway-explicit-api-id', 'gateway-discovery', 'gateway-repo-label'] },
  { name: 'cloud-endpoints', providerType: 'cloud-endpoints', expectedSourceTypes: ['cloud-endpoints-config'], validationMode: 'exact-bytes', satisfiedBy: ['endpoints-explicit-api-id', 'endpoints-discovery'] },
  { name: 'apigee-proxy', providerType: 'apigee', expectedSourceTypes: ['apigee-proxy'], validationMode: 'exact-bytes', satisfiedBy: ['apigee-discovery'] },
  { name: 'apigee-archive', providerType: 'apigee', expectedSourceTypes: ['apigee-archive-deployment'], validationMode: 'exact-bytes' },
  { name: 'api-hub-original', providerType: 'api-hub', expectedSourceTypes: ['api-hub-spec'], validationMode: 'exact-bytes' },
  { name: 'api-hub-additional', providerType: 'api-hub', expectedSourceTypes: ['api-hub-boosted-spec', 'api-hub-gateway-openapi-spec'], validationMode: 'exact-bytes' },
  { name: 'apigee-registry', providerType: 'apigee-registry', expectedSourceTypes: ['apigee-registry-spec'], validationMode: 'exact-bytes' },
  { name: 'app-integration', providerType: 'app-integration', expectedSourceTypes: ['app-integration-trigger'], validationMode: 'semantic-openapi' },
  { name: 'connectors-custom', providerType: 'connectors-custom', expectedSourceTypes: ['connectors-custom-spec'], validationMode: 'exact-bytes' },
  { name: 'apigee-portal', providerType: 'apigee-portal', expectedSourceTypes: ['apigee-portal-doc'], validationMode: 'exact-bytes' },
  { name: 'vertex-extensions', providerType: 'vertex-extensions', expectedSourceTypes: ['vertex-extension-manifest'], validationMode: 'exact-bytes' },
  { name: 'agent-engines', providerType: 'agent-engines', expectedSourceTypes: ['agent-engine-generated-spec'], validationMode: 'manual-derived-blocked' },
  { name: 'dialogflow-tools', providerType: 'dialogflow-tools', expectedSourceTypes: ['dialogflow-tool-schema'], validationMode: 'exact-bytes' },
  { name: 'ces-toolsets', providerType: 'ces-toolsets', expectedSourceTypes: ['ces-tool-schema', 'ces-toolset-schema'], validationMode: 'exact-bytes' },
  { name: 'iac-local', providerType: 'iac-local', expectedSourceTypes: ['iac-embedded'], validationMode: 'exact-bytes', satisfiedBy: ['iac-single'] }
]);

const PROVISIONED_CASE_NAMES = Object.freeze([
  'gateway-explicit-api-id',
  'gateway-discovery',
  'gateway-repo-label',
  'gateway-label-conflict',
  'endpoints-explicit-api-id',
  'endpoints-discovery',
  'apigee-discovery',
  'discover-many',
  'iac-single',
  'ambiguity'
]);

const FIXTURE_ALLOWED_KEYS = new Set([
  'provider',
  'resourceId',
  'expectedSourceType',
  'validationMode',
  'expectedSha256',
  'expectedFixturePath',
  'matrixName',
  'selectionStrategy',
  'serviceHint'
]);

export const FIXTURE_SELECTION_STRATEGIES = Object.freeze([
  'strict-api-id',
  'expected-api-ids',
  'api-hub-additional'
]);

/** Providers whose runtime `api-id` parser accepts a full resource name. */
const STRICT_API_ID_SOURCE_TYPES = Object.freeze(new Set([
  'api-gateway-config',
  'cloud-endpoints-config',
  'apigee-proxy',
  'apigee-archive-deployment',
  'api-hub-spec',
  'apigee-registry-spec',
  'apigee-portal-doc',
  'vertex-extension-manifest',
  'dialogflow-tool-schema',
  'ces-tool-schema',
  'ces-toolset-schema'
]));

/** Providers that emit candidate IDs but have no strict `--api-id` parser (return [] when api-id is set). */
const EXPECTED_API_IDS_PROVIDERS = Object.freeze(new Set([
  'app-integration',
  'connectors-custom',
  'agent-engines'
]));

const API_HUB_ADDITIONAL_SOURCE_TYPES = Object.freeze(new Set([
  'api-hub-boosted-spec',
  'api-hub-gateway-openapi-spec'
]));

const SHA256_RE = /^[a-f0-9]{64}$/;
const BINDING_HEX_RE = /^[a-f0-9]{40,64}$/;
const API_HUB_ADDITIONAL_RESOURCE_RE = /^(projects\/[^/]+\/locations\/[^/]+\/apis\/[^/]+\/versions\/[^/]+\/specs\/[^/]+)#(BOOSTED_SPEC_CONTENT|GATEWAY_OPEN_API_SPEC)$/;

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

export function verifyRemoteGatewayOwnership(manifest, described) {
  if (described?.labels?.['postman-run-marker'] !== manifest.runMarker) throw new Error('REFUSING Gateway deletion: remote marker mismatch');
  return true;
}

export function verifyRemoteEndpointsOwnership(manifest, serviceName) {
  const expectedMarker = `postman-live-${manifest.runId}`;
  if (manifest.runMarker !== expectedMarker
    || serviceName !== manifest.endpointsService
    || !serviceName.startsWith(`${expectedMarker}.`)) {
    throw new Error('REFUSING Endpoints deletion: remote name/marker is not current-run scoped');
  }
  return true;
}

export function verifyRemoteApigeeOwnership(manifest, described) {
  const name = described?.name;
  if (name !== manifest.proxyName || !name.includes(`postman-live-${manifest.runId}`)) {
    throw new Error('REFUSING Apigee proxy deletion: remote name is not run-scoped');
  }
  return true;
}

/** Resource keys tracked for partial-provisioning teardown. */
export const MANIFEST_RESOURCE_KEYS = Object.freeze(['gateway', 'endpoints', 'apigee']);

export function createEmptyResourceStates() {
  return {
    gateway: { attempted: false, created: false },
    endpoints: { attempted: false, created: false },
    apigee: { attempted: false, created: false }
  };
}

/** Ensure manifest.resources exists with per-surface attempted/created flags. */
export function ensureManifestResources(manifest) {
  if (!manifest.resources || typeof manifest.resources !== 'object') {
    manifest.resources = createEmptyResourceStates();
  }
  for (const key of MANIFEST_RESOURCE_KEYS) {
    const current = manifest.resources[key];
    if (!current || typeof current !== 'object') {
      manifest.resources[key] = { attempted: false, created: false };
      continue;
    }
    current.attempted = Boolean(current.attempted);
    current.created = Boolean(current.created);
  }
  return manifest.resources;
}

export function getResourceState(manifest, key) {
  const resources = ensureManifestResources(manifest);
  return resources[key] ?? { attempted: false, created: false };
}

export function markResourceAttempted(manifest, key) {
  const state = getResourceState(manifest, key);
  state.attempted = true;
  return state;
}

export function markResourceCreated(manifest, key) {
  const state = getResourceState(manifest, key);
  state.attempted = true;
  state.created = true;
  return state;
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

/**
 * Exact-name absence proof for attempted-but-unconfirmed resources.
 * 404/not-found proves clean; any other error (including IAM) fails teardown.
 * Never lists or deletes.
 */
export function proveExactNameAbsent(probe) {
  try {
    probe();
  } catch (error) {
    if (isResourceNotFoundError(error)) return true;
    const wrapped = new Error('absence-unprovable');
    wrapped.reasonCode = classifyProbeError(error) === 'fatal' ? 'iam-denied' : 'absence-unprovable';
    wrapped.cause = error;
    throw wrapped;
  }
  const error = new Error('residue-detected');
  error.reasonCode = 'residue-detected';
  throw error;
}

/** Assert live matrix covers every retained provider; throws on drift. */
export function assertProviderMatrixAligned(matrix = LIVE_COVERAGE_MATRIX, retained = RETAINED_PROVIDER_ORDER) {
  const covered = new Set(matrix.map((slot) => slot.providerType));
  const missing = retained.filter((provider) => !covered.has(provider));
  const foreign = [...covered].filter((provider) => !retained.includes(provider));
  if (missing.length || foreign.length) {
    throw new Error(`Live coverage matrix drifted from retained providers; missing=${missing.join(',') || 'none'} foreign=${foreign.join(',') || 'none'}`);
  }
  return true;
}

export function confinePathWithinRoot(rootPath, targetPath, fieldName = 'path') {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within repo root; received ${targetPath}`);
  }
  return resolved;
}

function extractProjectIdFromResource(resourceId) {
  const match = /^projects\/([^/]+)\//.exec(String(resourceId ?? ''));
  return match?.[1];
}

/**
 * Strict fixture schema parser. Never logs the raw env payload.
 * Accepts a JSON array or `{ fixtures: [...] }`.
 */
export function parseLiveFixtures(raw, { projectId, apigeeOrg = projectId, repoRoot: root = repoRoot } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error('fixture-schema-invalid: GCP_LIVE_FIXTURES_JSON is not valid JSON');
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.fixtures;
  if (!Array.isArray(list)) {
    throw new Error('fixture-schema-invalid: expected array or { fixtures: [] }');
  }
  if (parsed && !Array.isArray(parsed)) {
    const topKeys = Object.keys(parsed);
    if (topKeys.some((key) => key !== 'fixtures')) {
      throw new Error(`fixture-schema-invalid: unexpected top-level fields ${topKeys.filter((k) => k !== 'fixtures').join(',')}`);
    }
  }

  const seenResource = new Set();
  const seenMatrix = new Set();
  const fixtures = [];
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`fixture-schema-invalid: fixtures[${index}] must be an object`);
    }
    const keys = Object.keys(entry);
    const unexpected = keys.filter((key) => !FIXTURE_ALLOWED_KEYS.has(key));
    if (unexpected.length) {
      throw new Error(`fixture-schema-invalid: fixtures[${index}] unexpected fields ${unexpected.join(',')}`);
    }
    for (const required of ['provider', 'resourceId', 'expectedSourceType', 'validationMode']) {
      if (typeof entry[required] !== 'string' || !entry[required].trim()) {
        throw new Error(`fixture-schema-invalid: fixtures[${index}].${required} is required`);
      }
    }
    const provider = entry.provider.trim();
    if (!RETAINED_PROVIDER_ORDER.includes(provider)) {
      throw new Error(`fixture-schema-invalid: unknown provider ${provider}`);
    }
    const validationMode = entry.validationMode.trim();
    if (!VALIDATION_MODES.includes(validationMode)) {
      throw new Error(`fixture-schema-invalid: invalid validationMode ${validationMode}`);
    }
    const resourceId = entry.resourceId.trim();
    const foreign = extractProjectIdFromResource(resourceId);
    if (foreign && projectId && foreign !== projectId) {
      throw new Error(`fixture-schema-invalid: foreign project in resourceId`);
    }
    if (projectId && !foreign && !resourceId.startsWith(`organizations/${apigeeOrg}/`)) {
      throw new Error('fixture-schema-invalid: resourceId must be scoped to the selected project');
    }
    const dupKey = `${provider}::${resourceId}::${entry.expectedSourceType.trim()}`;
    if (seenResource.has(dupKey)) {
      throw new Error(`fixture-schema-invalid: duplicate fixture ${provider}/${entry.expectedSourceType.trim()}`);
    }
    seenResource.add(dupKey);

    let expectedSha256;
    if (entry.expectedSha256 !== undefined) {
      expectedSha256 = String(entry.expectedSha256).trim().toLowerCase();
      if (!SHA256_RE.test(expectedSha256)) {
        throw new Error(`fixture-schema-invalid: malformed expectedSha256`);
      }
    }

    let expectedFixturePath;
    if (entry.expectedFixturePath !== undefined) {
      expectedFixturePath = String(entry.expectedFixturePath).trim();
      if (path.isAbsolute(expectedFixturePath)) {
        throw new Error('fixture-schema-invalid: expectedFixturePath must be relative');
      }
      confinePathWithinRoot(root, expectedFixturePath, 'expectedFixturePath');
      const fixturePath = path.resolve(root, expectedFixturePath);
      if (!existsSync(fixturePath)) {
        throw new Error(`fixture-schema-invalid: expectedFixturePath does not exist`);
      }
      if (lstatSync(fixturePath).isSymbolicLink() || !confinePathWithinRoot(realpathSync(root), realpathSync(fixturePath), 'expectedFixturePath')) {
        throw new Error('fixture-schema-invalid: expectedFixturePath must not be a symlink');
      }
    }

    if (typeof entry.matrixName !== 'string' || !entry.matrixName.trim()) {
      throw new Error(`fixture-schema-invalid: fixtures[${index}].matrixName is required`);
    }
    const matrixName = entry.matrixName.trim();
    const slot = LIVE_COVERAGE_MATRIX.find((candidate) => candidate.name === matrixName);
    if (!slot || slot.providerType !== provider || !slot.expectedSourceTypes.includes(entry.expectedSourceType.trim())) {
      throw new Error(`fixture-schema-invalid: matrixName does not match provider/source variant`);
    }
    if (slot.validationMode !== validationMode) {
      throw new Error('fixture-schema-invalid: validationMode does not match matrix slot');
    }
    if (seenMatrix.has(matrixName)) {
      throw new Error(`fixture-schema-invalid: duplicate matrixName ${matrixName}`);
    }
    seenMatrix.add(matrixName);
    if (validationMode === 'exact-bytes' && !expectedSha256 && !expectedFixturePath) {
      throw new Error('fixture-schema-invalid: exact-bytes fixture requires expectedSha256 or expectedFixturePath');
    }
    if (validationMode === 'semantic-openapi' && !expectedFixturePath) {
      throw new Error('fixture-schema-invalid: semantic-openapi fixture requires expectedFixturePath');
    }

    const expectedSourceType = entry.expectedSourceType.trim();
    let serviceHint;
    if (entry.serviceHint !== undefined) {
      serviceHint = String(entry.serviceHint).trim();
      if (!serviceHint) {
        throw new Error('fixture-schema-invalid: serviceHint must be non-empty when provided');
      }
    }
    const selectionStrategy = resolveFixtureSelectionStrategy({
      provider,
      expectedSourceType,
      resourceId,
      selectionStrategy: entry.selectionStrategy,
      matrixName
    });
    const normalizedResourceId = normalizeFixtureResourceId({
      resourceId,
      expectedSourceType,
      selectionStrategy
    });

    fixtures.push({
      provider,
      resourceId: normalizedResourceId,
      expectedSourceType,
      validationMode,
      selectionStrategy,
      ...(expectedSha256 ? { expectedSha256 } : {}),
      ...(expectedFixturePath ? { expectedFixturePath } : {}),
      ...(matrixName ? { matrixName } : {}),
      ...(serviceHint ? { serviceHint } : {})
    });
  }
  return fixtures;
}

function contentTypeForApiHubAdditionalSource(sourceType) {
  if (sourceType === 'api-hub-boosted-spec') return 'BOOSTED_SPEC_CONTENT';
  if (sourceType === 'api-hub-gateway-openapi-spec') return 'GATEWAY_OPEN_API_SPEC';
  return undefined;
}

function sourceTypeForApiHubAdditionalContent(contentType) {
  if (contentType === 'BOOSTED_SPEC_CONTENT') return 'api-hub-boosted-spec';
  if (contentType === 'GATEWAY_OPEN_API_SPEC') return 'api-hub-gateway-openapi-spec';
  return undefined;
}

/**
 * Derive or validate a fixture selection strategy that cannot select arbitrary
 * unrelated candidates. Never uses bare discovery.
 */
export function deriveFixtureSelectionStrategy({ provider, expectedSourceType }) {
  if (API_HUB_ADDITIONAL_SOURCE_TYPES.has(expectedSourceType)) return 'api-hub-additional';
  if (EXPECTED_API_IDS_PROVIDERS.has(provider)) return 'expected-api-ids';
  if (STRICT_API_ID_SOURCE_TYPES.has(expectedSourceType)) return 'strict-api-id';
  throw new Error('fixture-schema-invalid: no safe selectionStrategy for provider/source');
}

export function resolveFixtureSelectionStrategy({
  provider,
  expectedSourceType,
  resourceId,
  selectionStrategy,
  matrixName
}) {
  const derived = deriveFixtureSelectionStrategy({ provider, expectedSourceType });
  let strategy = derived;
  if (selectionStrategy !== undefined) {
    strategy = String(selectionStrategy).trim();
    if (!FIXTURE_SELECTION_STRATEGIES.includes(strategy)) {
      throw new Error('fixture-schema-invalid: unknown selectionStrategy');
    }
  }

  if (strategy === 'api-hub-additional') {
    if (!API_HUB_ADDITIONAL_SOURCE_TYPES.has(expectedSourceType) || matrixName !== 'api-hub-additional') {
      throw new Error('fixture-schema-invalid: api-hub-additional strategy requires api-hub additional source/matrix');
    }
  } else if (strategy === 'strict-api-id') {
    if (EXPECTED_API_IDS_PROVIDERS.has(provider)) {
      throw new Error('fixture-schema-invalid: strict-api-id cannot select providers without an explicit parser');
    }
    if (API_HUB_ADDITIONAL_SOURCE_TYPES.has(expectedSourceType)) {
      throw new Error('fixture-schema-invalid: additional API Hub content requires api-hub-additional strategy');
    }
    if (!STRICT_API_ID_SOURCE_TYPES.has(expectedSourceType)) {
      throw new Error('fixture-schema-invalid: strict-api-id unsupported for source type');
    }
  } else if (strategy === 'expected-api-ids') {
    if (API_HUB_ADDITIONAL_SOURCE_TYPES.has(expectedSourceType)) {
      throw new Error('fixture-schema-invalid: expected-api-ids cannot deterministically select API Hub additional variants');
    }
    if (!EXPECTED_API_IDS_PROVIDERS.has(provider) && !STRICT_API_ID_SOURCE_TYPES.has(expectedSourceType)) {
      throw new Error('fixture-schema-invalid: expected-api-ids rejected for unbound selection');
    }
  } else {
    throw new Error('fixture-schema-invalid: selectionStrategy rejected');
  }

  if (selectionStrategy !== undefined && strategy !== derived) {
    // Allow explicit override only when it remains a safe strategy for the source.
    // Reject loosening toward arbitrary discovery.
    if (derived === 'api-hub-additional' && strategy !== 'api-hub-additional') {
      throw new Error('fixture-schema-invalid: selectionStrategy must remain api-hub-additional for additional content');
    }
    if (derived === 'expected-api-ids' && strategy === 'strict-api-id') {
      throw new Error('fixture-schema-invalid: cannot force strict-api-id for parser-less providers');
    }
  }

  // Resource shape guard for additional variants (full validation in normalize).
  if (strategy === 'api-hub-additional' && API_HUB_ADDITIONAL_RESOURCE_RE.test(String(resourceId ?? ''))) {
    const match = API_HUB_ADDITIONAL_RESOURCE_RE.exec(String(resourceId));
    const sourceFromResource = sourceTypeForApiHubAdditionalContent(match?.[2]);
    if (sourceFromResource && sourceFromResource !== expectedSourceType) {
      throw new Error('fixture-schema-invalid: resourceId variant does not match expectedSourceType');
    }
  }

  return strategy;
}

export function normalizeFixtureResourceId({ resourceId, expectedSourceType, selectionStrategy }) {
  const raw = String(resourceId ?? '').trim();
  if (selectionStrategy !== 'api-hub-additional') return raw;

  const contentType = contentTypeForApiHubAdditionalSource(expectedSourceType);
  if (!contentType) {
    throw new Error('fixture-schema-invalid: api-hub-additional requires boosted/gateway source type');
  }
  const variantMatch = API_HUB_ADDITIONAL_RESOURCE_RE.exec(raw);
  if (variantMatch) {
    if (variantMatch[2] !== contentType) {
      throw new Error('fixture-schema-invalid: resourceId variant does not match expectedSourceType');
    }
    return raw;
  }
  // Bare original spec name: attach the deterministic additional variant selector.
  if (!/^projects\/[^/]+\/locations\/[^/]+\/apis\/[^/]+\/versions\/[^/]+\/specs\/[^/]+$/.test(raw)) {
    throw new Error('fixture-schema-invalid: api-hub-additional resourceId must be a spec name or spec#VARIANT');
  }
  return `${raw}#${contentType}`;
}

/**
 * Build compiled-CLI args for a fixture. Never emits a strategy that can select
 * arbitrary unrelated candidates (no bare discovery).
 */
export function buildFixtureCliArgs(fixture, env = {}) {
  void env;
  const strategy = fixture.selectionStrategy
    ?? deriveFixtureSelectionStrategy({
      provider: fixture.provider,
      expectedSourceType: fixture.expectedSourceType
    });
  const resourceId = normalizeFixtureResourceId({
    resourceId: fixture.resourceId,
    expectedSourceType: fixture.expectedSourceType,
    selectionStrategy: strategy
  });

  if (strategy === 'strict-api-id' || strategy === 'api-hub-additional') {
    return {
      strategy,
      args: ['--api-id', resourceId],
      resourceId
    };
  }

  if (strategy === 'expected-api-ids') {
    const serviceHint = String(fixture.serviceHint ?? '').trim()
      || resourceId.split('/').filter(Boolean).pop()
      || '';
    if (!serviceHint) {
      throw new Error('fixture-schema-invalid: expected-api-ids requires serviceHint');
    }
    return {
      strategy,
      args: [
        '--expected-api-ids-json', JSON.stringify([resourceId]),
        '--expected-service-name', serviceHint
      ],
      resourceId,
      serviceHint
    };
  }

  throw new Error('fixture-schema-invalid: unsupported selectionStrategy');
}

export function assertFixtureResolutionMatch(resolution, fixture, slot) {
  if (!resolution) {
    const error = new Error('unexpected-source-type');
    error.reasonCode = 'unexpected-source-type';
    throw error;
  }
  const expected = fixture.expectedSourceType;
  if (fixture.selectionStrategy === 'api-hub-additional' || API_HUB_ADDITIONAL_SOURCE_TYPES.has(expected)) {
    if (resolution.sourceType !== expected || !API_HUB_ADDITIONAL_SOURCE_TYPES.has(resolution.sourceType)) {
      const error = new Error('unexpected-source-type');
      error.reasonCode = 'unexpected-source-type';
      throw error;
    }
    if (resolution.authority && resolution.authority !== 'google-generated') {
      const error = new Error('unexpected-source-type');
      error.reasonCode = 'unexpected-source-type';
      throw error;
    }
  } else if (slot?.expectedSourceTypes?.length) {
    if (!slot.expectedSourceTypes.includes(resolution.sourceType) && resolution.sourceType !== expected) {
      const error = new Error('unexpected-source-type');
      error.reasonCode = 'unexpected-source-type';
      throw error;
    }
  }
  return true;
}

/**
 * Map authenticated probe outcomes to closed substitute reason codes.
 * `available` is never a substitute — callers must fail as missing-fixture.
 */
export function classifySubstituteReason({ providerType, probeStatus, probeMessage }) {
  const status = String(probeStatus ?? '');
  if (status === 'available') return null;
  if (status === 'skipped:iam') return 'iam-denied';

  const text = String(probeMessage ?? '');
  if (/\b(401|403)\b|permission[_ -]?denied|forbidden|unauthenticated/i.test(text)) return 'iam-denied';
  if (
    /SERVICE_DISABLED|API_NOT_ENABLED|has not been used|is not enabled|not been activated|accessNotConfigured|SERVICE_UNAVAILABLE|API has not been/i.test(text)
  ) {
    return 'api-unavailable';
  }
  if (
    providerType === 'vertex-extensions'
    && /deprecated|no longer (available|supported)|shutdown|not supported for new/i.test(text)
  ) {
    return 'product-deprecated';
  }
  if (
    providerType === 'apigee-registry'
    && (/no longer supported|deprecated|not supported|REGISTRY_NOT|apigeeregistry/i.test(text) || status === 'skipped:error')
  ) {
    // Legacy Registry: skipped:error without IAM is treated as unsupported product surface.
    if (/permission|401|403|forbidden|unauthenticated/i.test(text)) return 'iam-denied';
    return 'registry-unsupported';
  }
  if (status === 'skipped:error' && /not found|404|does not exist/i.test(text) && providerType === 'apigee-registry') {
    return 'registry-unsupported';
  }
  return null;
}

export function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function sha256File(filePath) {
  return sha256Hex(readFileSync(filePath));
}

export function computeDistBinding({ root = repoRoot, runner } = {}) {
  const cliPath = path.join(root, 'dist/cli.cjs');
  const indexPath = path.join(root, 'dist/index.cjs');
  if (!existsSync(cliPath) || !existsSync(indexPath)) {
    const error = new Error('dist-missing: dist/cli.cjs and dist/index.cjs are required; run npm run build first');
    error.reasonCode = 'dist-missing';
    throw error;
  }
  const distCliSha256 = sha256File(cliPath);
  const distIndexSha256 = sha256File(indexPath);
  let actionVersion = 'unknown';
  try {
    actionVersion = String(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? 'unknown');
  } catch { /* keep unknown */ }

  let gitCommit = 'unknown';
  const exec = runner ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8' }));
  try {
    gitCommit = String(exec('git', ['rev-parse', 'HEAD'], { cwd: root })).trim() || 'unknown';
  } catch { /* git unavailable */ }

  let distDirty = false;
  try {
    const porcelain = String(exec('git', ['status', '--porcelain', '--', 'dist'], { cwd: root })).trim();
    distDirty = porcelain.length > 0;
  } catch { /* no reliable dirty check */ }

  if (distDirty) {
    const error = new Error(
      'dist-dirty: refuse live validation against unbound bytes; a clean committed candidate build is required before rerunning'
    );
    error.reasonCode = 'dist-dirty';
    throw error;
  }

  return {
    actionVersion,
    gitCommit,
    distCliSha256,
    distIndexSha256,
    cliPath,
    indexPath
  };
}

export function toEvidenceResult(name, status, fields = {}) {
  const result = {
    name,
    providerType: fields.providerType ?? '',
    sourceType: fields.sourceType ?? '',
    specFormat: fields.specFormat ?? '',
    status,
    validationMode: fields.validationMode ?? ''
  };
  if (fields.reasonCode) result.reasonCode = fields.reasonCode;
  // Strip any sensitive extras that callers might accidentally pass.
  return result;
}

export function buildEvidence({ results, binding, teardown, capturedAt, evidenceKind = 'current' }) {
  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const substituted = results.filter((result) => result.status === 'substitute').length;
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind,
    capturedAt: capturedAt ?? new Date().toISOString(),
    actionVersion: binding?.actionVersion ?? LEGACY_UNBOUND,
    gitCommit: binding?.gitCommit ?? LEGACY_UNBOUND,
    distCliSha256: binding?.distCliSha256 ?? LEGACY_UNBOUND,
    distIndexSha256: binding?.distIndexSha256 ?? LEGACY_UNBOUND,
    projectScope: PROJECT_SCOPE_ALIAS,
    totals: { cases: results.length, passed, failed, substituted },
    teardown: teardown ?? { status: 'pass' },
    results: results.map((result) => toEvidenceResult(result.name, result.status, result))
  };
}

export function isHistoricalEvidence(evidence) {
  return evidence?.evidenceKind === 'historical'
    || evidence?.actionVersion === LEGACY_UNBOUND
    || evidence?.distCliSha256 === LEGACY_UNBOUND
    || evidence?.gitCommit === LEGACY_UNBOUND;
}

function hasExactHistoricalBindings(evidence) {
  return evidence?.evidenceKind === 'historical'
    && evidence?.actionVersion === LEGACY_UNBOUND
    && evidence?.gitCommit === LEGACY_UNBOUND
    && evidence?.distCliSha256 === LEGACY_UNBOUND
    && evidence?.distIndexSha256 === LEGACY_UNBOUND;
}

function isBoundDigest(value) {
  return typeof value === 'string' && BINDING_HEX_RE.test(value) && value !== LEGACY_UNBOUND;
}

function hasJustifiedSubstitutesOnly(results) {
  for (const result of results ?? []) {
    if (result.status !== 'substitute') continue;
    if (!SUBSTITUTE_REASON_CODES.includes(result.reasonCode)) return false;
  }
  return true;
}

function hasExactResultTotals(evidence) {
  const results = Array.isArray(evidence.results) ? evidence.results : [];
  const passed = results.filter((result) => result.status === 'pass').length;
  const failed = results.filter((result) => result.status === 'fail').length;
  const substituted = results.filter((result) => result.status === 'substitute').length;
  return evidence.totals?.cases === results.length
    && evidence.totals?.passed === passed
    && evidence.totals?.failed === failed
    && evidence.totals?.substituted === substituted;
}

function hasOnlyClosedResultStates(results, allowedStates) {
  return Array.isArray(results) && results.every((result) => allowedStates.includes(result?.status));
}

/**
 * Accept either:
 * - historical migration: explicitly incomplete/unbound with only truthful old cases; or
 * - current complete: bound git/dist/action fields, complete matrix, zero failures,
 *   justified substitutes only, clean teardown.
 * Reject fake hybrids, missing matrix cases, unbound complete claims, or current
 * receipts with failed/missing-fixture/pending teardown.
 */
export function assertAcceptableLiveEvidence(evidence, matrix = LIVE_COVERAGE_MATRIX) {
  if (!evidence || evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error('evidence-unacceptable: schemaVersion 2 required');
  }
  if (evidence.projectScope !== PROJECT_SCOPE_ALIAS) {
    throw new Error('evidence-unacceptable: projectScope alias required');
  }
  const historical = isHistoricalEvidence(evidence);
  const bound = isBoundDigest(evidence.gitCommit)
    && isBoundDigest(evidence.distCliSha256)
    && isBoundDigest(evidence.distIndexSha256)
    && typeof evidence.actionVersion === 'string'
    && evidence.actionVersion.length > 0
    && evidence.actionVersion !== LEGACY_UNBOUND;

  if (historical && bound) {
    throw new Error('evidence-unacceptable: hybrid historical+bound receipt');
  }
  if (!historical && !bound) {
    throw new Error('evidence-unacceptable: current receipt requires bound git/dist/action fields');
  }
  if (!hasExactResultTotals(evidence)) {
    throw new Error('evidence-unacceptable: totals must exactly match result states');
  }

  if (historical) {
    if (!hasExactHistoricalBindings(evidence)) {
      throw new Error('evidence-unacceptable: historical receipt requires exact legacy-unbound bindings');
    }
    if (matrixSlotsMissingCoverage(evidence.results, matrix).length === 0 && (evidence.results?.length ?? 0) >= matrix.length) {
      throw new Error('evidence-unacceptable: unbound complete claim (historical cannot claim full matrix)');
    }
    if (!hasOnlyClosedResultStates(evidence.results, ['pass'])) {
      throw new Error('evidence-unacceptable: historical receipt must contain only completed passing cases');
    }
    const unknown = (evidence.results ?? []).filter((result) => !PROVISIONED_CASE_NAMES.includes(result.name)
      && !matrix.some((slot) => slot.name === result.name));
    if (unknown.length) {
      throw new Error('evidence-unacceptable: historical receipt contains unknown cases');
    }
    return { kind: 'historical' };
  }

  // Current complete receipt.
  if (evidence.evidenceKind !== 'current') {
    throw new Error('evidence-unacceptable: bound receipt must declare evidenceKind current');
  }
  if (!hasOnlyClosedResultStates(evidence.results, ['pass', 'substitute'])) {
    throw new Error('evidence-unacceptable: current receipt contains failed or pending result state');
  }
  if ((evidence.totals?.failed ?? 0) !== 0) {
    throw new Error('evidence-unacceptable: current receipt has failures');
  }
  if ((evidence.results ?? []).some((result) => result.status === 'fail'
    || result.reasonCode === 'missing-fixture')) {
    throw new Error('evidence-unacceptable: current receipt has failed or missing-fixture cases');
  }
  if (evidence.teardown?.status !== 'pass' || evidence.teardown?.reasonCode === 'teardown-failed') {
    throw new Error('evidence-unacceptable: current receipt requires clean teardown');
  }
  const missing = matrixSlotsMissingCoverage(evidence.results, matrix);
  if (missing.length) {
    throw new Error(`evidence-unacceptable: incomplete matrix coverage (${missing.join(',')})`);
  }
  if (!hasJustifiedSubstitutesOnly(evidence.results)) {
    throw new Error('evidence-unacceptable: unjustified substitute reason');
  }
  return { kind: 'current' };
}

export function matrixSlotsMissingCoverage(results, matrix = LIVE_COVERAGE_MATRIX) {
  const byName = new Map(results.map((result) => [result.name, result]));
  const missing = [];
  for (const slot of matrix) {
    const direct = byName.get(slot.name);
    if (direct && (direct.status === 'pass' || direct.status === 'substitute')) continue;
    const via = (slot.satisfiedBy ?? []).some((name) => {
      const hit = byName.get(name);
      return hit && hit.status === 'pass';
    });
    if (!via) missing.push(slot.name);
  }
  return missing;
}

function redactSecrets(text) {
  return String(text ?? '')
    .replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s'"`]+/g, '[REDACTED_URL]')
    .replace(/\b(?:projects|organizations)\/[A-Za-z0-9._/-]+/g, '[REDACTED_RESOURCE]');
}

function defaultRunner(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
  } catch (error) {
    const scrubbed = new Error(redactSecrets(error instanceof Error ? error.message : String(error)));
    scrubbed.stderr = redactSecrets(error?.stderr);
    throw scrubbed;
  }
}

function gcloud(runner, args) { return runner('gcloud', args); }
function accessToken(runner) { return String(gcloud(runner, ['auth', 'print-access-token'])).trim(); }
function rest(runner, token, method, url, body) {
  const args = ['-fsS', '-X', method, '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json'];
  if (body !== undefined) args.push('--data-binary', typeof body === 'string' ? body : JSON.stringify(body));
  return runner('curl', [...args, url]);
}

function restCapture(runner, token, method, url) {
  try {
    return { ok: true, body: rest(runner, token, method, url) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function restUploadZip(runner, token, url, zipPath) {
  return runner('curl', [
    '-fsS', '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', `@${zipPath}`,
    url
  ]);
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

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function normalizeOpenApiForCompare(content) {
  const { parseAndValidateOpenApi } = require(path.join(repoRoot, 'dist/index.cjs'));
  const validated = parseAndValidateOpenApi(String(content));
  return JSON.stringify(sortValue(validated.document));
}

export function compareExactBytes(actualContent, expectedSha256) {
  const actual = sha256Hex(typeof actualContent === 'string' ? Buffer.from(actualContent) : actualContent);
  if (actual !== expectedSha256) {
    const error = new Error('exact-bytes-mismatch');
    error.reasonCode = 'exact-bytes-mismatch';
    throw error;
  }
  return true;
}

export function compareSemanticOpenApi(actualContent, expectedContent) {
  const left = normalizeOpenApiForCompare(actualContent);
  const right = normalizeOpenApiForCompare(expectedContent);
  if (left !== right) {
    const error = new Error('semantic-mismatch');
    error.reasonCode = 'semantic-mismatch';
    throw error;
  }
  return true;
}

/**
 * Prove compiled-CLI refused local-derived Agent Engine auto-resolve/export.
 * Accepts the product shape (unresolved + local-derived + ranked agent-engines
 * candidate) and the explicit sourceType form.
 */
export function assertManualDerivedBlocked(cliResult) {
  const resolution = cliResult?.resolution;
  if (!resolution || resolution.status === 'resolved') {
    const error = new Error('manual-derived-not-blocked');
    error.reasonCode = 'manual-derived-not-blocked';
    throw error;
  }
  const ranked = Array.isArray(resolution.rankedCandidates) ? resolution.rankedCandidates : [];
  const rankedBlocked = ranked.some((candidate) => (
    candidate?.providerType === 'agent-engines'
    && candidate?.authority === 'local-derived'
    && candidate?.supported === false
  ));
  const topLevelBlocked = resolution.status === 'unresolved'
    && resolution.authority === 'local-derived'
    && (
      (resolution.providerType === 'agent-engines'
        && (resolution.sourceType === 'agent-engine-generated-spec' || resolution.sourceType === 'manual-review'))
      || resolution.sourceType === 'agent-engine-generated-spec'
      || rankedBlocked
    );
  if (!topLevelBlocked && !rankedBlocked) {
    const error = new Error('manual-derived-not-blocked');
    error.reasonCode = 'manual-derived-not-blocked';
    throw error;
  }
  return true;
}

async function seedIac(workspace) {
  await mkdir(path.join(workspace, 'infra'), { recursive: true });
  const source = await readFile(path.join(repoRoot, 'validation/fixtures/gcp/iac-single/main.tf'), 'utf8');
  await writeFile(path.join(workspace, 'infra/main.tf'), source.replaceAll('openapi.yaml', 'gateway-doc.yaml'));
  await cp(path.join(repoRoot, 'validation/fixtures/gcp/openapi.yaml'), path.join(workspace, 'infra/gateway-doc.yaml'));
}

async function seedAmbiguity(workspace) {
  await mkdir(path.join(workspace, 'infra'), { recursive: true });
  const source = await readFile(path.join(repoRoot, 'validation/fixtures/gcp/iac-single/main.tf'), 'utf8');
  await writeFile(path.join(workspace, 'infra/alpha.tf'), source.replaceAll('postman-live-api', 'postman-alpha-api').replaceAll('openapi.yaml', 'alpha-doc.yaml'));
  await writeFile(path.join(workspace, 'infra/bravo.tf'), source.replaceAll('postman-live-api', 'postman-bravo-api').replaceAll('openapi.yaml', 'bravo-doc.yaml'));
  await cp(path.join(repoRoot, 'validation/fixtures/gcp/openapi.yaml'), path.join(workspace, 'infra/alpha-doc.yaml'));
  await cp(path.join(repoRoot, 'validation/fixtures/gcp/openapi.yaml'), path.join(workspace, 'infra/bravo-doc.yaml'));
}

export async function provision({ runner, token, env, manifest }) {
  ensureManifestResources(manifest);
  gcloud(runner, ['services', 'enable', 'apigateway.googleapis.com', 'servicemanagement.googleapis.com', 'servicecontrol.googleapis.com', '--project', env.projectId]);
  const spec = path.join(repoRoot, 'validation/fixtures/gcp/openapi.yaml');
  const managed = await mkdtemp(path.join(os.tmpdir(), 'gcp-managed-'));
  let endpointsConfigId = '';
  try {
    const gatewaySpecPath = path.join(managed, 'gateway.yaml');
    await writeFile(gatewaySpecPath, swagger2Document({ title: manifest.gatewayName, backend: true }));
    // Gateway API/config set: mark attempted before create; created once the API exists.
    markResourceAttempted(manifest, 'gateway');
    gcloud(runner, ['api-gateway', 'apis', 'create', manifest.gatewayName, '--project', env.projectId, '--labels', `postman-run-marker=${manifest.runMarker}`]);
    markResourceCreated(manifest, 'gateway');
    gcloud(runner, ['api-gateway', 'api-configs', 'create', manifest.gatewayConfigName, '--api', manifest.gatewayName, '--openapi-spec', gatewaySpecPath, '--project', env.projectId, '--labels', `postman-run-marker=${manifest.runMarker},postman-project-name=${manifest.gatewayName},postman-repo=${manifest.repoLabel}`]);
    gcloud(runner, ['api-gateway', 'api-configs', 'create', `${manifest.gatewayConfigName}-b`, '--api', manifest.gatewayName, '--openapi-spec', gatewaySpecPath, '--project', env.projectId, '--labels', `postman-run-marker=${manifest.runMarker},postman-project-name=${manifest.gatewayName}-alt,postman-repo=${manifest.conflictLabel}`]);
    gcloud(runner, ['api-gateway', 'api-configs', 'create', `${manifest.gatewayConfigName}-c`, '--api', manifest.gatewayName, '--openapi-spec', gatewaySpecPath, '--project', env.projectId, '--labels', `postman-run-marker=${manifest.runMarker},postman-project-name=${manifest.gatewayName}-alt,postman-repo=${manifest.conflictLabel}`]);

    const endpointsPath = path.join(managed, 'endpoints.yaml');
    await writeFile(endpointsPath, swagger2Document({ title: manifest.endpointsService, host: manifest.endpointsService }));
    markResourceAttempted(manifest, 'endpoints');
    gcloud(runner, ['endpoints', 'services', 'deploy', endpointsPath, '--project', env.projectId]);
    markResourceCreated(manifest, 'endpoints');
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
      markResourceAttempted(manifest, 'apigee');
      restUploadZip(runner, token, `https://apigee.googleapis.com/v1/organizations/${env.apigeeOrg}/apis?action=import&name=${manifest.proxyName}`, zip);
      markResourceCreated(manifest, 'apigee');
    } finally { await rm(proxyZip, { recursive: true, force: true }); }
  } finally { await rm(managed, { recursive: true, force: true }); }
  return { endpointsConfigId };
}

/**
 * Probe URLs for retained cloud providers (compiled-CLI probe statuses are
 * primary; REST capture supplies closed-code classification detail only).
 * Apigee archive substitutes must hit the environment archiveDeployments
 * endpoint (not the generic proxy API). Org/env values are never logged.
 */
export function probeUrlForProvider(providerType, env, options = {}) {
  const projectId = env.projectId;
  const org = env.apigeeOrg;
  const probeSurface = options.probeSurface ?? providerType;
  switch (providerType) {
    case 'api-gateway':
      return `https://apigateway.googleapis.com/v1/projects/${projectId}/locations/global/apis?pageSize=1`;
    case 'cloud-endpoints':
      return `https://servicemanagement.googleapis.com/v1/services?producerProjectId=${projectId}&pageSize=1`;
    case 'apigee':
      if (probeSurface === 'apigee-archive') {
        return `https://apigee.googleapis.com/v1/organizations/${org}/environments/${env.apigeeEnv}/archiveDeployments?pageSize=1`;
      }
      return `https://apigee.googleapis.com/v1/organizations/${org}/apis?count=1`;
    case 'api-hub':
      return `https://apihub.googleapis.com/v1/projects/${projectId}/locations/-/apis?pageSize=1`;
    case 'apigee-registry':
      return `https://apigeeregistry.googleapis.com/v1/projects/${projectId}/locations/-?pageSize=1`;
    case 'app-integration':
      return `https://integrations.googleapis.com/v1/projects/${projectId}/locations/-/integrations?pageSize=1`;
    case 'connectors-custom':
      return `https://connectors.googleapis.com/v1/projects/${projectId}/locations/-/customConnectors?pageSize=1`;
    case 'apigee-portal':
      return `https://apigee.googleapis.com/v1/organizations/${org}/sites?pageSize=1`;
    case 'vertex-extensions':
      return `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/us-central1/extensions?pageSize=1`;
    case 'agent-engines':
      return `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/reasoningEngines?pageSize=1`;
    case 'dialogflow-tools':
      return `https://dialogflow.googleapis.com/v3/projects/${projectId}/locations/global/agents?pageSize=1`;
    case 'ces-toolsets':
      return `https://ces.googleapis.com/v1/projects/${projectId}/locations/global/apps?pageSize=1`;
    default:
      return null;
  }
}

export async function probeProviderSurface({ runner, token, env, providerType, probeSurface }) {
  if (providerType === 'iac-local') {
    return { probeStatus: 'available', reasonCode: null };
  }
  const url = probeUrlForProvider(providerType, env, { probeSurface: probeSurface ?? providerType });
  let probeMessage = '';
  if (url) {
    const captured = restCapture(runner, token, 'GET', url);
    if (!captured.ok) probeMessage = captured.message;
  }
  const probeStatus = probeMessage
    ? (classifySubstituteReason({ providerType, probeStatus: 'skipped:error', probeMessage }) === 'iam-denied' ? 'skipped:iam' : 'skipped:error')
    : 'available';
  const reasonCode = classifySubstituteReason({ providerType, probeStatus, probeMessage });
  return { probeStatus, reasonCode, probeMessage: probeMessage ? '[redacted]' : '' };
}

export async function teardown({ runner, env, manifest, log }) {
  const token = accessToken(runner);
  ensureManifestResources(manifest);
  const gateway = getResourceState(manifest, 'gateway');
  const endpoints = getResourceState(manifest, 'endpoints');
  const apigee = getResourceState(manifest, 'apigee');

  // Unattempted surfaces are never probed or deleted — unavailable Apigee must
  // not poison a Gateway-only permission failure that never reached Apigee.
  if (gateway.created) {
    let gatewayExists = true;
    try {
      const described = JSON.parse(gcloud(runner, ['api-gateway', 'apis', 'describe', manifest.gatewayName, '--project', env.projectId, '--format', 'json']));
      verifyRemoteGatewayOwnership(manifest, described);
    } catch (error) {
      if (isResourceNotFoundError(error)) gatewayExists = false;
      else throw error;
    }
    if (gatewayExists) {
      try { gcloud(runner, ['api-gateway', 'api-configs', 'delete', `${manifest.gatewayConfigName}-c`, '--api', manifest.gatewayName, '--project', env.projectId, '--quiet']); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
      try { gcloud(runner, ['api-gateway', 'api-configs', 'delete', `${manifest.gatewayConfigName}-b`, '--api', manifest.gatewayName, '--project', env.projectId, '--quiet']); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
      try { gcloud(runner, ['api-gateway', 'api-configs', 'delete', manifest.gatewayConfigName, '--api', manifest.gatewayName, '--project', env.projectId, '--quiet']); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
      try { gcloud(runner, ['api-gateway', 'apis', 'delete', manifest.gatewayName, '--project', env.projectId, '--quiet']); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
    }
  } else if (gateway.attempted) {
    proveExactNameAbsent(() => {
      gcloud(runner, ['api-gateway', 'apis', 'describe', manifest.gatewayName, '--project', env.projectId, '--format', 'json']);
    });
  }

  if (endpoints.created) {
    verifyRemoteEndpointsOwnership(manifest, manifest.endpointsService);
    try { gcloud(runner, ['endpoints', 'services', 'delete', manifest.endpointsService, '--project', env.projectId, '--quiet']); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
  } else if (endpoints.attempted) {
    proveExactNameAbsent(() => {
      gcloud(runner, ['endpoints', 'services', 'describe', manifest.endpointsService, '--project', env.projectId, '--format', 'json']);
    });
  }

  if (apigee.created) {
    let apigeeExists = true;
    try {
      const described = JSON.parse(rest(runner, token, 'GET', `https://apigee.googleapis.com/v1/organizations/${env.apigeeOrg}/apis/${manifest.proxyName}`));
      verifyRemoteApigeeOwnership(manifest, described);
    } catch (error) {
      if (isResourceNotFoundError(error)) apigeeExists = false;
      else throw error;
    }
    if (apigeeExists) {
      try { rest(runner, token, 'DELETE', `https://apigee.googleapis.com/v1/organizations/${env.apigeeOrg}/apis/${manifest.proxyName}`); } catch (error) { if (!isResourceNotFoundError(error)) throw error; }
    }
  } else if (apigee.attempted) {
    proveExactNameAbsent(() => {
      rest(runner, token, 'GET', `https://apigee.googleapis.com/v1/organizations/${env.apigeeOrg}/apis/${manifest.proxyName}`);
    });
  }

  // Post-delete absence proof only for confirmed-created resources.
  const residue = [];
  if (gateway.created) {
    try {
      gcloud(runner, ['api-gateway', 'apis', 'describe', manifest.gatewayName, '--project', env.projectId, '--format', 'json']);
      residue.push('gateway');
    } catch (error) {
      if (!isResourceNotFoundError(error)) throw error;
    }
  }
  if (endpoints.created) {
    try {
      gcloud(runner, ['endpoints', 'services', 'describe', manifest.endpointsService, '--project', env.projectId, '--format', 'json']);
      residue.push('endpoints');
    } catch (error) {
      if (!isResourceNotFoundError(error)) throw error;
    }
  }
  if (apigee.created) {
    try {
      rest(runner, token, 'GET', `https://apigee.googleapis.com/v1/organizations/${env.apigeeOrg}/apis/${manifest.proxyName}`);
      residue.push('apigee');
    } catch (error) {
      if (!isResourceNotFoundError(error)) throw error;
    }
  }
  if (residue.length) {
    const error = new Error('residue-detected');
    error.reasonCode = 'residue-detected';
    throw error;
  }
  log('Deleted only current-run Gateway, Endpoints, and Apigee resources; residue check passed');
  return { status: 'pass' };
}

async function runProvisionedCases({ runner, cliPath, env, manifest, endpointsConfigId, log }) {
  const results = [];
  const execute = async (name, setup, args, expectedSource, providerType, validationMode) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), `gcp-live-${name}-`));
    try {
      if (setup) await setup(workspace);
      const result = runCli(runner, cliPath, [...args, '--project-id', env.projectId, '--repo-root', workspace, '--result-json', 'result.json'], workspace);
      const resolution = result.resolution ?? result.discovered?.[0];
      if (name === 'ambiguity' || name === 'gateway-label-conflict') {
        if (result.resolution?.status !== 'unresolved' || (result.resolution.rankedCandidates?.length ?? 0) < 2) {
          throw new Error('expected unresolved ambiguity');
        }
      } else if (!resolution || (result.resolution && result.resolution.status !== 'resolved')) {
        throw new Error('expected resolved result');
      }
      if (expectedSource && resolution.sourceType !== expectedSource) {
        throw new Error(`expected ${expectedSource}, got ${resolution.sourceType}`);
      }
      results.push(toEvidenceResult(name, 'pass', {
        sourceType: resolution?.sourceType ?? (name === 'discover-many' ? '' : 'manual-review'),
        providerType: resolution?.providerType ?? providerType ?? '',
        specFormat: resolution?.specFormat ?? '',
        validationMode
      }));
    } catch (error) {
      results.push(toEvidenceResult(name, 'fail', {
        providerType: providerType ?? '',
        validationMode,
        reasonCode: 'cli-failed'
      }));
      log(`${name}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };

  await execute(PROVISIONED_CASE_NAMES[0], null, ['--api-id', `projects/${env.projectId}/locations/global/apis/${manifest.gatewayName}/configs/${manifest.gatewayConfigName}`], 'api-gateway-config', 'api-gateway', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[1], null, ['--expected-service-name', manifest.gatewayName], 'api-gateway-config', 'api-gateway', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[2], null, ['--repo-slug', manifest.repoSlug], 'api-gateway-config', 'api-gateway', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[3], null, ['--repo-slug', manifest.conflictSlug], null, '', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[4], null, ['--api-id', `services/${manifest.endpointsService}/configs/${endpointsConfigId}`], 'cloud-endpoints-config', 'cloud-endpoints', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[5], null, ['--expected-service-name', manifest.endpointsService, '--expected-api-ids-json', JSON.stringify([`services/${manifest.endpointsService}/configs/${endpointsConfigId}`])], 'cloud-endpoints-config', 'cloud-endpoints', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[6], null, ['--expected-service-name', manifest.proxyName, '--expected-api-ids-json', JSON.stringify([`organizations/${env.apigeeOrg}/apis/${manifest.proxyName}/revisions/1`])], 'apigee-proxy', 'apigee', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[7], null, ['--mode', 'discover-many'], null, 'api-gateway', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[8], seedIac, ['--preflight-checks', 'false'], 'iac-embedded', 'iac-local', 'exact-bytes');
  await execute(PROVISIONED_CASE_NAMES[9], seedAmbiguity, ['--preflight-checks', 'false'], null, '', 'exact-bytes');
  return results;
}

function fixtureForSlot(slot, fixtures) {
  return fixtures.find((fixture) => fixture.matrixName === slot.name)
    ?? fixtures.find((fixture) => fixture.provider === slot.providerType && slot.expectedSourceTypes.includes(fixture.expectedSourceType));
}

async function runFixtureCase({ runner, cliPath, env, slot, fixture, log }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `gcp-live-fix-${slot.name}-`));
  try {
    const selected = buildFixtureCliArgs(fixture, env);
    const args = [
      ...selected.args,
      '--project-id', env.projectId,
      '--repo-root', workspace,
      '--result-json', 'result.json',
      '--preflight-checks', 'false'
    ];
    const result = runCli(runner, cliPath, args, workspace);
    const resolution = result.resolution;
    const mode = fixture.validationMode || slot.validationMode;

    if (mode === 'manual-derived-blocked') {
      assertManualDerivedBlocked(result);
      return toEvidenceResult(slot.name, 'pass', {
        providerType: slot.providerType,
        sourceType: resolution?.sourceType === 'agent-engine-generated-spec'
          ? resolution.sourceType
          : (slot.expectedSourceTypes[0] ?? 'agent-engine-generated-spec'),
        specFormat: resolution?.specFormat ?? '',
        validationMode: mode
      });
    }

    if (!resolution || resolution.status !== 'resolved') {
      return toEvidenceResult(slot.name, 'fail', {
        providerType: slot.providerType,
        sourceType: resolution?.sourceType ?? '',
        validationMode: mode,
        reasonCode: 'cli-failed'
      });
    }
    assertFixtureResolutionMatch(resolution, { ...fixture, selectionStrategy: selected.strategy }, slot);

    const specRelative = resolution.specPath;
    if (!specRelative) {
      return toEvidenceResult(slot.name, 'fail', {
        providerType: slot.providerType,
        sourceType: resolution.sourceType,
        validationMode: mode,
        reasonCode: 'cli-failed'
      });
    }
    const specAbsolute = confinePathWithinRoot(workspace, specRelative, 'spec-path');
    const actualContent = readFileSync(specAbsolute);

    if (mode === 'exact-bytes') {
      if (fixture.expectedSha256) {
        compareExactBytes(actualContent, fixture.expectedSha256);
      } else if (fixture.expectedFixturePath) {
        const expected = readFileSync(confinePathWithinRoot(repoRoot, fixture.expectedFixturePath, 'expectedFixturePath'));
        compareExactBytes(actualContent, sha256Hex(expected));
      }
    } else if (mode === 'semantic-openapi') {
      if (!fixture.expectedFixturePath) {
        return toEvidenceResult(slot.name, 'fail', {
          providerType: slot.providerType,
          sourceType: resolution.sourceType,
          validationMode: mode,
          reasonCode: 'fixture-schema-invalid'
        });
      }
      const expected = readFileSync(confinePathWithinRoot(repoRoot, fixture.expectedFixturePath, 'expectedFixturePath'), 'utf8');
      compareSemanticOpenApi(actualContent.toString('utf8'), expected);
    }

    return toEvidenceResult(slot.name, 'pass', {
      providerType: slot.providerType,
      sourceType: resolution.sourceType,
      specFormat: resolution.specFormat ?? '',
      validationMode: mode
    });
  } catch (error) {
    const reasonCode = error?.reasonCode
      ?? (String(error?.message ?? '').includes('exact-bytes') ? 'exact-bytes-mismatch'
        : String(error?.message ?? '').includes('semantic') ? 'semantic-mismatch'
          : String(error?.message ?? '').includes('manual-derived') ? 'manual-derived-not-blocked'
            : String(error?.message ?? '').includes('unexpected-source') ? 'unexpected-source-type'
              : 'cli-failed');
    log(`${slot.name}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return toEvidenceResult(slot.name, 'fail', {
      providerType: slot.providerType,
      validationMode: fixture.validationMode || slot.validationMode,
      reasonCode
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export function extractCliProbeStatuses(result) {
  let outputResolution;
  try {
    outputResolution = JSON.parse(result?.outputs?.['resolution-json'] ?? 'null');
  } catch {
    outputResolution = undefined;
  }
  const probes = result?.resolution?.providerProbes
    ?? result?.providerProbes
    ?? outputResolution?.providerProbes
    ?? [];
  const map = new Map();
  for (const probe of probes) {
    if (RETAINED_PROVIDER_ORDER.includes(probe?.provider)
      && ['available', 'skipped:iam', 'skipped:error'].includes(probe?.status)) {
      map.set(probe.provider, probe.status);
    }
  }
  return map;
}

async function collectCliProbeStatuses({ runner, cliPath, env }) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'gcp-live-probe-'));
  try {
    const result = runCli(runner, cliPath, [
      '--project-id', env.projectId,
      '--repo-root', workspace,
      '--result-json', 'result.json',
      '--preflight-checks', 'false',
      '--preflight-permission-probe', 'true',
      '--dry-run', 'true'
    ], workspace);
    return extractCliProbeStatuses(result);
  } catch {
    return new Map();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runMatrixCoverage({ runner, token, cliPath, env, fixtures, provisionedResults, log }) {
  const results = [];
  const cliProbes = await collectCliProbeStatuses({ runner, cliPath, env });

  for (const slot of LIVE_COVERAGE_MATRIX) {
    const satisfied = (slot.satisfiedBy ?? []).some((name) => provisionedResults.some((result) => result.name === name && result.status === 'pass'));
    if (satisfied) continue;

    const fixture = fixtureForSlot(slot, fixtures);
    const surface = await probeProviderSurface({
      runner,
      token,
      env,
      providerType: slot.providerType,
      probeSurface: slot.name
    });

    // Agent Engines: authenticated probe alone never completes. Pair probe
    // availability/unavailability with a compiled-CLI manual-derived-blocked proof.
    if (slot.validationMode === 'manual-derived-blocked' || slot.providerType === 'agent-engines') {
      if (!fixture) {
        results.push(toEvidenceResult(slot.name, 'fail', {
          providerType: slot.providerType,
          sourceType: '',
          specFormat: '',
          validationMode: slot.validationMode,
          reasonCode: 'missing-fixture'
        }));
        continue;
      }
      const blocked = await runFixtureCase({ runner, cliPath, env, slot, fixture, log });
      if (blocked.status !== 'pass') {
        results.push(blocked);
        continue;
      }
      if (surface.probeStatus === 'available') {
        results.push(blocked);
        continue;
      }
      if (surface.reasonCode && SUBSTITUTE_REASON_CODES.includes(surface.reasonCode) && cliProbes.has(slot.providerType)) {
        results.push(toEvidenceResult(slot.name, 'substitute', {
          providerType: slot.providerType,
          sourceType: slot.expectedSourceTypes[0] ?? 'agent-engine-generated-spec',
          specFormat: '',
          validationMode: slot.validationMode,
          reasonCode: surface.reasonCode
        }));
        continue;
      }
      results.push(toEvidenceResult(slot.name, 'fail', {
        providerType: slot.providerType,
        validationMode: slot.validationMode,
        reasonCode: 'probe-inconclusive'
      }));
      continue;
    }

    if (fixture) {
      results.push(await runFixtureCase({ runner, cliPath, env, slot, fixture, log }));
      continue;
    }

    if (!cliProbes.has(slot.providerType) || surface.probeStatus === 'available' || !surface.reasonCode) {
      results.push(toEvidenceResult(slot.name, 'fail', {
        providerType: slot.providerType,
        sourceType: '',
        specFormat: '',
        validationMode: slot.validationMode,
        reasonCode: surface.probeStatus === 'available' ? 'missing-fixture' : 'probe-inconclusive'
      }));
      continue;
    }

    if (!SUBSTITUTE_REASON_CODES.includes(surface.reasonCode)) {
      results.push(toEvidenceResult(slot.name, 'fail', {
        providerType: slot.providerType,
        validationMode: slot.validationMode,
        reasonCode: 'probe-inconclusive'
      }));
      continue;
    }

    results.push(toEvidenceResult(slot.name, 'substitute', {
      providerType: slot.providerType,
      sourceType: slot.expectedSourceTypes[0] ?? '',
      specFormat: '',
      validationMode: slot.validationMode,
      reasonCode: surface.reasonCode
    }));
  }
  return results;
}

export async function runLiveValidation({ argv = process.argv.slice(2), env: rawEnv = process.env, deps = {} } = {}) {
  assertProviderMatrixAligned();
  const flags = parseFlags(argv);
  if (!flags.provision || !flags.teardown) throw new Error('Live validation requires --provision --teardown');

  const env = requiredEnv(rawEnv);
  const runner = deps.runner ?? defaultRunner;
  const log = deps.log ?? ((line) => console.error(line));

  // Never log GCP_LIVE_FIXTURES_JSON — parse only.
  const fixtures = deps.fixtures ?? parseLiveFixtures(rawEnv[FIXTURES_ENV], {
    projectId: env.projectId,
    apigeeOrg: env.apigeeOrg,
    repoRoot
  });

  const binding = deps.binding ?? computeDistBinding({ root: repoRoot, runner });
  const suffix = randomBytes(4).toString('hex');
  const manifest = {
    runId: suffix,
    runMarker: `postman-live-${suffix}`,
    gatewayName: `postman-live-${suffix}`,
    gatewayConfigName: `postman-live-config-${suffix}`,
    endpointsService: `postman-live-${suffix}.endpoints.${env.projectId}.cloud.goog`,
    proxyName: `postman-live-${suffix}`,
    repoSlug: `postman-live/${suffix}`,
    repoLabel: `postman-live--${suffix}`,
    conflictSlug: `postman-conflict/${suffix}`,
    conflictLabel: `postman-conflict--${suffix}`,
    resources: createEmptyResourceStates()
  };

  let teardownResult = { status: 'fail', reasonCode: 'teardown-failed' };
  let evidence = buildEvidence({
    results: [toEvidenceResult('runner', 'fail', { reasonCode: 'cli-failed', validationMode: '' })],
    binding,
    teardown: { status: 'pending' }
  });
  let runError;
  try {
    const token = deps.token ?? accessToken(runner);
    const { endpointsConfigId } = await (deps.provision ?? provision)({ runner, token, env, manifest });
    const provisionedResults = await (deps.runProvisionedCases ?? runProvisionedCases)({
      runner, cliPath: binding.cliPath, env, manifest, endpointsConfigId, log
    });
    const matrixResults = await (deps.runMatrixCoverage ?? runMatrixCoverage)({
      runner, token, cliPath: binding.cliPath, env, fixtures, provisionedResults, log
    });
    const results = [...provisionedResults, ...matrixResults];
    evidence = buildEvidence({ results, binding, teardown: { status: 'pending' } });
  } catch (error) {
    runError = error;
    evidence = buildEvidence({
      results: [toEvidenceResult('runner', 'fail', { reasonCode: error?.reasonCode ?? 'cli-failed', validationMode: '' })],
      binding,
      teardown: { status: 'pending' }
    });
  } finally {
    try {
      teardownResult = await (deps.teardown ?? teardown)({ runner, env, manifest, log });
    } catch (error) {
      teardownResult = { status: 'fail', reasonCode: error?.reasonCode ?? 'teardown-failed' };
      log(`teardown: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    }
    if (evidence) {
      evidence = { ...evidence, teardown: teardownResult };
      await writeFile(path.join(repoRoot, 'validation/evidence/live-gcp-surfaces.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    }
  }

  if (runError) throw runError;

  const missing = matrixSlotsMissingCoverage(evidence.results);
  if (evidence.totals.failed || teardownResult.status !== 'pass' || missing.length) {
    throw new Error(
      `${evidence.totals.failed} case failure(s); teardown=${teardownResult.status}; uncovered=${missing.join(',') || 'none'}`
    );
  }
  return evidence;
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = path.resolve(new URL(import.meta.url).pathname);
if (entrypoint === here) {
  runLiveValidation().catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
