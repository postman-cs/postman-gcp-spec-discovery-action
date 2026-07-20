export const PROJECT_SCOPE_ALIAS: 'live-validation-project';
export const FIXTURES_ENV: 'GCP_LIVE_FIXTURES_JSON';
export const LEGACY_UNBOUND: 'legacy-unbound';
export const EVIDENCE_SCHEMA_VERSION: 2;

export const RETAINED_PROVIDER_ORDER: readonly string[];
export const VALIDATION_MODES: readonly string[];
export const SUBSTITUTE_REASON_CODES: readonly string[];
export const FAIL_REASON_CODES: readonly string[];
export const FIXTURE_SELECTION_STRATEGIES: readonly string[];

export interface LiveCoverageSlot {
  name: string;
  providerType: string;
  expectedSourceTypes: string[];
  validationMode: 'exact-bytes' | 'semantic-openapi' | 'manual-derived-blocked';
  satisfiedBy?: string[];
}

export const LIVE_COVERAGE_MATRIX: readonly LiveCoverageSlot[];

export interface LiveFlags { provision: boolean; teardown: boolean }
export interface LiveEnv { projectId: string; location: string; apigeeOrg: string; apigeeEnv: string }
export interface LiveManifest {
  runId: string;
  runMarker: string;
  gatewayName: string;
  gatewayConfigName?: string;
  endpointsService: string;
  proxyName: string;
  repoSlug?: string;
  repoLabel?: string;
  conflictSlug?: string;
  conflictLabel?: string;
}

export type EvidenceStatus = 'pass' | 'fail' | 'substitute';
export type ValidationMode = 'exact-bytes' | 'semantic-openapi' | 'manual-derived-blocked' | 'legacy-unbound' | '';
export type FixtureSelectionStrategy = 'strict-api-id' | 'expected-api-ids' | 'api-hub-additional';

export interface EvidenceResult {
  name: string;
  providerType: string;
  sourceType: string;
  specFormat: string;
  status: EvidenceStatus | string;
  validationMode: ValidationMode | string;
  reasonCode?: string;
}

export interface EvidenceTotals {
  cases: number;
  passed: number;
  failed: number;
  substituted: number;
}

export interface TeardownResult {
  status: 'pass' | 'fail' | 'pending' | string;
  reasonCode?: string;
}

export interface DistBinding {
  actionVersion: string;
  gitCommit: string;
  distCliSha256: string;
  distIndexSha256: string;
  cliPath: string;
  indexPath: string;
}

export interface Evidence {
  schemaVersion: number;
  evidenceKind?: 'current' | 'historical' | string;
  capturedAt: string;
  actionVersion: string;
  gitCommit: string;
  distCliSha256: string;
  distIndexSha256: string;
  projectScope: string;
  totals: EvidenceTotals;
  teardown: TeardownResult;
  results: EvidenceResult[];
}

export interface LiveFixture {
  provider: string;
  resourceId: string;
  expectedSourceType: string;
  validationMode: ValidationMode | string;
  expectedSha256?: string;
  expectedFixturePath?: string;
  matrixName: string;
  selectionStrategy: FixtureSelectionStrategy | string;
  serviceHint?: string;
}

export function parseFlags(argv: string[]): LiveFlags;
export function requiredEnv(env: Record<string, string | undefined>): LiveEnv;
export function verifyRemoteGatewayOwnership(manifest: LiveManifest, described: { labels?: Record<string, string> } | undefined): boolean;
export function verifyRemoteEndpointsOwnership(manifest: LiveManifest, serviceName: string | undefined): boolean;
export function verifyRemoteApigeeOwnership(manifest: LiveManifest, described: { name?: string } | undefined): boolean;
export function classifyProbeError(message: unknown): 'fatal' | 'retryable';
export function isResourceNotFoundError(error: unknown): boolean;
export function assertProviderMatrixAligned(matrix?: readonly LiveCoverageSlot[], retained?: readonly string[]): boolean;
export function confinePathWithinRoot(rootPath: string, targetPath: string, fieldName?: string): string;
export function parseLiveFixtures(raw: unknown, options?: { projectId?: string; apigeeOrg?: string; repoRoot?: string }): LiveFixture[];
export function deriveFixtureSelectionStrategy(input: {
  provider: string;
  expectedSourceType: string;
}): FixtureSelectionStrategy | string;
export function resolveFixtureSelectionStrategy(input: {
  provider: string;
  expectedSourceType: string;
  resourceId?: string;
  selectionStrategy?: string;
  matrixName?: string;
}): FixtureSelectionStrategy | string;
export function normalizeFixtureResourceId(input: {
  resourceId: string;
  expectedSourceType: string;
  selectionStrategy: string;
}): string;
export function buildFixtureCliArgs(fixture: LiveFixture, env: LiveEnv): {
  strategy: string;
  args: string[];
  resourceId: string;
  serviceHint?: string;
};
export function assertFixtureResolutionMatch(
  resolution: { sourceType?: string; authority?: string } | undefined,
  fixture: LiveFixture,
  slot?: LiveCoverageSlot
): boolean;
export function classifySubstituteReason(input: {
  providerType: string;
  probeStatus: string | undefined;
  probeMessage?: string;
}): string | null;
export function sha256Hex(content: string | Buffer): string;
export function sha256File(filePath: string): string;
export function computeDistBinding(options?: { root?: string; runner?: (command: string, args: string[], options?: Record<string, unknown>) => unknown }): DistBinding;
export function toEvidenceResult(name: string, status: string, fields?: Partial<EvidenceResult>): EvidenceResult;
export function buildEvidence(input: {
  results: EvidenceResult[];
  binding?: Partial<DistBinding>;
  teardown?: TeardownResult;
  capturedAt?: string;
  evidenceKind?: string;
}): Evidence;
export function isHistoricalEvidence(evidence: Evidence | undefined): boolean;
export function assertAcceptableLiveEvidence(evidence: Evidence | undefined, matrix?: readonly LiveCoverageSlot[]): { kind: 'historical' | 'current' };
export function matrixSlotsMissingCoverage(results: EvidenceResult[], matrix?: readonly LiveCoverageSlot[]): string[];
export function normalizeOpenApiForCompare(content: string): string;
export function compareExactBytes(actualContent: string | Buffer, expectedSha256: string): boolean;
export function compareSemanticOpenApi(actualContent: string, expectedContent: string): boolean;
export function assertManualDerivedBlocked(cliResult: {
  resolution?: {
    status?: string;
    authority?: string;
    sourceType?: string;
    providerType?: string;
    rankedCandidates?: Array<{ providerType?: string; authority?: string; supported?: boolean }>;
  };
}): boolean;
export function extractCliProbeStatuses(result: {
  resolution?: { providerProbes?: Array<{ provider?: string; status?: string }> };
  providerProbes?: Array<{ provider?: string; status?: string }>;
  outputs?: Record<string, string | undefined>;
}): Map<string, string>;
export function probeUrlForProvider(providerType: string, env: LiveEnv, options?: { probeSurface?: string }): string | null;
export function probeProviderSurface(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  token: string;
  env: LiveEnv;
  providerType: string;
  probeSurface?: string;
}): Promise<{ probeStatus: string; reasonCode: string | null; probeMessage?: string }>;
export function teardown(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  env: LiveEnv;
  manifest: LiveManifest;
  log: (message: string) => void;
}): Promise<TeardownResult>;
export function runLiveValidation(options?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  deps?: Record<string, unknown>;
}): Promise<Evidence>;
