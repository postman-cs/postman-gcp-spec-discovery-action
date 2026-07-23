export const PROJECT_SCOPE_ALIAS: 'live-validation-project';
export const FIXTURES_ENV: 'GCP_LIVE_FIXTURES_JSON';
export const LEGACY_UNBOUND: 'legacy-unbound';
export const EVIDENCE_SCHEMA_VERSION: 2;
export const LIVE_STATE_SCHEMA_VERSION: 1;
export const LIVE_REQUIRED_SERVICES: readonly string[];
export const LIVE_RECEIPT_SCHEMA_VERSION: 1;
export const DEFAULT_LIVE_RUNS_DIR: 'validation/.live-runs';
export const DEFAULT_STATE_FILENAME: 'state.json';
export const ADC_ACCESS_TOKEN_FILENAME: 'adc-access-token';
export const DEFAULT_COMMAND_TIMEOUT_MS: number;
export const DEFAULT_PHASE_TIMEOUT_MS: number;
export const MIN_COMMAND_TIMEOUT_MS: number;
export const MAX_COMMAND_TIMEOUT_MS: number;
export const MIN_PHASE_TIMEOUT_MS: number;
export const MAX_PHASE_TIMEOUT_MS: number;
export const TRACKED_EVIDENCE_RELATIVE: 'validation/evidence/live-gcp-surfaces.json';

export const RETAINED_PROVIDER_ORDER: readonly string[];
export const VALIDATION_MODES: readonly string[];
export const SUBSTITUTE_REASON_CODES: readonly string[];
export const OFFICIALLY_DEPRECATED_PROVIDER_TYPES: readonly string[];
export const FAIL_REASON_CODES: readonly string[];
export const FIXTURE_SELECTION_STRATEGIES: readonly string[];
export const LIVE_PHASES: readonly string[];
export const PHASE_DURATION_GUIDANCE_MS: Readonly<Record<string, number>>;

export interface LiveCoverageSlot {
  name: string;
  providerType: string;
  expectedSourceTypes: string[];
  validationMode: 'exact-bytes' | 'semantic-openapi' | 'manual-derived-blocked';
  satisfiedBy?: string[];
}

export const LIVE_COVERAGE_MATRIX: readonly LiveCoverageSlot[];

export type LivePhase = 'preflight' | 'provision' | 'validate' | 'teardown' | 'assemble' | 'all';

export interface LiveFlags {
  phase: LivePhase | string;
  provision: boolean;
  teardown: boolean;
  slots: string[] | null;
  statePath: string | null;
  receiptPath: string | null;
  phaseReceipts: string[];
  commandTimeoutMs: number;
  phaseTimeoutMs: number;
}

export interface LiveEnv { projectId: string; location: string; apigeeOrg: string; apigeeEnv: string }
export type ManifestResourceKey = 'gateway' | 'endpoints' | 'apigee';

export interface ManifestResourceState {
  attempted: boolean;
  created: boolean;
}

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
  resources?: Record<ManifestResourceKey, ManifestResourceState>;
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

export interface PhaseDeadline {
  startedAt: number;
  deadlineAt: number;
  phaseTimeoutMs: number;
  remainingMs(at?: number): number;
  elapsedMs(at?: number): number;
  assertNotExpired(at?: number): void;
}

export interface LiveState {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  binding: Pick<DistBinding, 'actionVersion' | 'gitCommit' | 'distCliSha256' | 'distIndexSha256'> | null;
  env: LiveEnv | null;
  manifest: LiveManifest | null;
  endpointsConfigId: string;
  completedSlots: EvidenceResult[];
  providerProbes?: Record<string, string>;
  phaseStatus: Record<string, string>;
}

export interface PhaseReceipt {
  schemaVersion: number;
  phase: string;
  group: string;
  elapsedMs: number;
  binding: Pick<DistBinding, 'actionVersion' | 'gitCommit' | 'distCliSha256' | 'distIndexSha256'>;
  status: 'pass' | 'fail' | string;
  failureClass?: string;
  teardown?: TeardownResult;
  results?: EvidenceResult[];
  totals?: EvidenceTotals;
  completedSlotNames?: string[];
}

export function parseFlags(argv: string[]): LiveFlags;
export function parseSlots(raw: unknown): string[] | null;
export function clampTimeoutMs(value: unknown, options: {
  min: number;
  max: number;
  fallback: number;
  flagName: string;
}): number;
export function createPhaseDeadline(phaseTimeoutMs: number, now?: number): PhaseDeadline;
export function resolveCommandTimeoutMs(commandTimeoutMs: number, deadline?: PhaseDeadline | null, now?: number): number;
export function createTimedRunner(
  baseRunner: (command: string, args: string[], options?: Record<string, unknown>) => unknown,
  options: { commandTimeoutMs: number; deadline: PhaseDeadline }
): (command: string, args: string[], options?: Record<string, unknown>) => unknown;
export function defaultRunner(command: string, args: string[], options?: Record<string, unknown>): unknown;
export function defaultLiveRunsRoot(root?: string): string;
export function resolveAdcAccessTokenFilePath(options?: { root?: string }): string;
export function isAdcAccessTokenMintArgs(args: unknown): boolean;
export function withAdcAccessTokenFile(
  baseRunner: (command: string, args: string[], options?: Record<string, unknown>) => unknown,
  tokenFilePath: string
): (command: string, args: string[], options?: Record<string, unknown>) => unknown;
export function createAdcAccessTokenBridge(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  root?: string;
}): Promise<{
  token: string;
  tokenFilePath: string;
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  dispose: () => void;
}>;
export function resolveStatePath(options?: { root?: string; statePath?: string | null }): string;
export function resolveReceiptPath(options?: { root?: string; phase?: string; receiptPath?: string | null }): string;
export function writeAtomicJson(filePath: string, value: unknown, options?: { mode?: number }): Promise<string>;
export function createEmptyLiveState(options?: {
  binding?: Partial<DistBinding>;
  env?: LiveEnv;
  manifest?: LiveManifest;
}): LiveState;
export function assertLiveStateSchema(state: unknown): LiveState;
export function loadLiveState(statePath: string): Promise<LiveState>;
export function saveLiveState(statePath: string, state: LiveState): Promise<LiveState>;
export function sanitizePhaseReceipt(receipt: Partial<PhaseReceipt> & { phase: string; status: string }): PhaseReceipt;
export function writePhaseReceipt(receiptPath: string, receipt: Partial<PhaseReceipt> & { phase: string; status: string }): Promise<PhaseReceipt>;
export function loadPhaseReceipt(receiptPath: string, root?: string): PhaseReceipt;
export function classifyPhaseFailure(error: unknown): string;
export function mergeCompletedSlots(prior?: EvidenceResult[], next?: EvidenceResult[]): EvidenceResult[];
export function runMatrixCoverage(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  token: string;
  cliPath: string;
  env: Record<string, string>;
  fixtures: LiveFixture[];
  provisionedResults: EvidenceResult[];
  slots?: readonly LiveCoverageSlot[];
  cliProbes?: Map<string, string>;
  log: (message: string) => void;
}): Promise<EvidenceResult[]>;
export function assertValidateSlotsAllowed(requestedSlots: string[] | null | undefined, matrix?: readonly LiveCoverageSlot[]): string[];
export function assembleFromPhaseReceipts(options: {
  receipts: PhaseReceipt[];
  binding: Pick<DistBinding, 'actionVersion' | 'gitCommit' | 'distCliSha256' | 'distIndexSha256'>;
  matrix?: readonly LiveCoverageSlot[];
}): Evidence;
export function requiredEnv(env: Record<string, string | undefined>): LiveEnv;
export function verifyRemoteGatewayOwnership(manifest: LiveManifest, described: { labels?: Record<string, string> } | undefined): boolean;
export function verifyRemoteEndpointsOwnership(manifest: LiveManifest, serviceName: string | undefined): boolean;
export function verifyRemoteApigeeOwnership(manifest: LiveManifest, described: { name?: string } | undefined): boolean;
export const MANIFEST_RESOURCE_KEYS: readonly ManifestResourceKey[];
export function createEmptyResourceStates(): Record<ManifestResourceKey, ManifestResourceState>;
export function ensureManifestResources(manifest: LiveManifest): Record<ManifestResourceKey, ManifestResourceState>;
export function getResourceState(manifest: LiveManifest, key: ManifestResourceKey): ManifestResourceState;
export function markResourceAttempted(manifest: LiveManifest, key: ManifestResourceKey): ManifestResourceState;
export function markResourceCreated(manifest: LiveManifest, key: ManifestResourceKey): ManifestResourceState;
export function classifyProbeError(message: unknown): 'fatal' | 'retryable';
export function isResourceNotFoundError(error: unknown): boolean;
export function proveExactNameAbsent(probe: () => unknown): true;
export function provision(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  token?: string;
  env: LiveEnv;
  manifest: LiveManifest;
  onCheckpoint?: (manifest: LiveManifest) => unknown | Promise<unknown>;
  root?: string;
}): Promise<{ endpointsConfigId: string }>;
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
  probeSurface?: string;
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
  root?: string;
}): Promise<TeardownResult>;
export function runPhasePreflight(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  env: LiveEnv;
  binding: DistBinding | Pick<DistBinding, 'actionVersion' | 'gitCommit' | 'distCliSha256' | 'distIndexSha256'>;
  statePath: string;
  receiptPath: string;
  deadline: PhaseDeadline;
  log: (message: string) => void;
  root?: string;
}): Promise<{ state: LiveState; receipt: PhaseReceipt; token: string }>;
export function runPhaseProvision(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  token?: string;
  env: LiveEnv;
  state: LiveState;
  statePath: string;
  receiptPath: string;
  deadline: PhaseDeadline;
  deps?: Record<string, unknown>;
  log: (message: string) => void;
  root?: string;
}): Promise<{ state: LiveState; receipt: PhaseReceipt; endpointsConfigId: string }>;
export function runPhaseValidate(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  token: string;
  cliPath: string;
  env: LiveEnv;
  state: LiveState;
  statePath: string;
  receiptPath: string;
  slots?: string[] | null;
  fixtures?: LiveFixture[];
  deadline: PhaseDeadline;
  deps?: Record<string, unknown>;
  log: (message: string) => void;
}): Promise<{ state: LiveState; receipt: PhaseReceipt; results: EvidenceResult[] }>;
export function runPhaseTeardown(options: {
  runner: (command: string, args: string[], options?: Record<string, unknown>) => unknown;
  env: LiveEnv;
  state: LiveState;
  statePath: string;
  receiptPath: string;
  deadline: PhaseDeadline;
  deps?: Record<string, unknown>;
  log: (message: string) => void;
  root?: string;
}): Promise<{ state: LiveState; receipt: PhaseReceipt; teardownResult: TeardownResult }>;
export function runPhaseAssemble(options: {
  binding: Pick<DistBinding, 'actionVersion' | 'gitCommit' | 'distCliSha256' | 'distIndexSha256'>;
  receiptPaths: string[];
  root?: string;
  promote?: boolean;
}): Promise<Evidence>;
export function runLiveValidation(options?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  deps?: Record<string, unknown>;
}): Promise<Evidence | { phase: string; state?: LiveState; receipt?: PhaseReceipt; results?: EvidenceResult[]; teardown?: TeardownResult }>;
