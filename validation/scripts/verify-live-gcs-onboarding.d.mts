export const RECEIPT_SCHEMA_VERSION: 1;
export const DEFAULT_RESOURCES_RELATIVE: '.postman/resources.yaml';
export const DEFAULT_RECEIPT_RELATIVE: 'validation/.live-runs/gcs-onboarding-receipt.json';
export const DEFAULT_LIVE_RUNS_DIR: 'validation/.live-runs';
export const PINNED_RELEASE_TAG: 'v1.1.6';
export const EXPECTED_PROVIDER_TYPE: 'connectors-custom';
export const EXPECTED_SOURCE_TYPE: 'connectors-custom-spec';
export const EXPECTED_RESOLUTION_STATUS: 'resolved';
export const POSTMAN_API_HOST: 'https://api.getpostman.com';
export const DEFAULT_FETCH_TIMEOUT_MS: number;
export const DEFAULT_ABSENCE_RETRY_COUNT: number;
export const DEFAULT_ABSENCE_RETRY_DELAY_MS: number;
export const CI_PROVIDER: 'github-actions';
export const RUNNER_KIND: 'github-hosted';
export const GCP_CREDENTIAL_CLASS: 'workload-identity-federation';
export const POSTMAN_CREDENTIAL_CLASS: 'sandbox-service-account-pmak';
export const FAILURE_CLASSES: readonly string[];

export interface ArtifactAssertions {
  resourcesYamlPresent: boolean;
  resourcesYamlValid: boolean;
  workspaceUidPresent: boolean;
  specUidPresent: boolean;
  baselineCollectionUidPresent: boolean;
  smokeCollectionUidPresent: boolean;
  contractCollectionUidPresent: boolean;
  discoveredSpecMapped: boolean;
  discoveryHandoffValid: boolean;
  releaseIdentityValid: boolean;
}

export interface LiveGcsOnboardingReceipt {
  schemaVersion: 1 | number;
  capturedAt: string;
  releaseTag: string;
  releaseCommit: string;
  runId: string;
  runAttempt: number;
  runUrl: string;
  ciProvider: 'github-actions' | string;
  runnerKind: 'github-hosted' | string;
  gcpCredentialClass: 'workload-identity-federation' | string;
  postmanCredentialClass: 'sandbox-service-account-pmak' | string;
  discoveryProvider: string;
  discoverySource: string;
  artifactAssertions: ArtifactAssertions;
  onboardingStatus: string;
  teardownStatus: string;
  failureClass?: string;
}

export interface VerifierInputs {
  runId: string;
  runAttempt: number;
  runUrl: string;
  releaseTag: string;
  releaseCommit: string;
  discoveryStatus: string;
  discoveryProvider: string;
  discoverySource: string;
  specPath: string;
  expectedWorkspaceName: string;
  onboardingOutcome: string;
  postmanApiKey: string;
  resourcesPath: string;
  receiptPath: string;
  /** Optional safe workspace UID from composite onboarding output. */
  workspaceUid: string;
}

export interface ResourcesAssertionResult {
  workspaceUid: string;
  specUid: string;
  baselineCollectionUid: string;
  smokeCollectionUid: string;
  contractCollectionUid: string;
  discoveredSpecMapped: boolean;
  localOrCloudSpecMapped: boolean;
}

export interface VerifierDeps {
  fetchImpl?: typeof fetch;
  fetch?: typeof fetch;
  fetchTimeoutMs?: number;
  absenceRetryCount?: number;
  absenceRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => string;
}

export interface VerifyLiveGcsOnboardingOptions extends VerifierDeps {
  env?: Record<string, string | undefined>;
  root?: string;
  receiptPathFallback?: string;
}

export interface VerifyLiveGcsOnboardingResult {
  ok: boolean;
  exitCode: number;
  receipt: LiveGcsOnboardingReceipt;
  receiptPath: string;
  failureClass?: string;
  workspaceUid?: string;
}

export function confinePathWithinRoot(rootPath: string, targetPath: string, fieldName?: string): string;
export function assertNotSymlink(targetPath: string, fieldName?: string): void;
export function writeAtomicJson(filePath: string, value: unknown, options?: { mode?: number }): string;
export function resolveRunUrl(env?: Record<string, string | undefined>): string;
export function reconcileWorkspaceUids(
  outputUid: string,
  resourcesUid: string
): { mismatch: boolean; workspaceUid: string };
export function readVerifierInputs(env?: Record<string, string | undefined>): VerifierInputs;
export function sanitizeReceipt(
  partial: Omit<Partial<LiveGcsOnboardingReceipt>, 'artifactAssertions'> & {
    artifactAssertions?: Partial<ArtifactAssertions>;
  } & Record<string, unknown>
): LiveGcsOnboardingReceipt;
export function parseResourcesYamlMapping(rawYaml: string): Record<string, unknown>;
export function extractWorkspaceUidFromResources(parsedOrRaw: string | Record<string, unknown>): string;
export function assertResourceMappings(
  parsed: Record<string, unknown>,
  inputs: Pick<VerifierInputs, 'specPath' | 'expectedWorkspaceName'>,
  workspaceUid: string
): ResourcesAssertionResult;
export function assertResourcesYaml(rawYaml: string, inputs: Pick<VerifierInputs, 'specPath' | 'expectedWorkspaceName'>): ResourcesAssertionResult;
export function assertDiscoveryAndRelease(inputs: Pick<VerifierInputs, 'discoveryStatus' | 'discoveryProvider' | 'discoverySource' | 'releaseTag' | 'releaseCommit'>): {
  discoveryHandoffValid: boolean;
  releaseIdentityValid: boolean;
};
export function verifyWorkspaceName(
  deps: VerifierDeps,
  apiKey: string,
  workspaceUid: string,
  expectedName: string
): Promise<{ exists: boolean; nameMatches: boolean }>;
export function deleteWorkspace(
  deps: VerifierDeps,
  apiKey: string,
  workspaceUid: string
): Promise<{ deleted: boolean; alreadyAbsent: boolean }>;
export function verifyWorkspaceAbsent(deps: VerifierDeps, apiKey: string, workspaceUid: string): Promise<true>;
export function teardownVerifiedWorkspace(
  deps: VerifierDeps,
  apiKey: string,
  workspaceUid: string,
  expectedName: string
): Promise<{ status: string; deleted: boolean; alreadyAbsent: boolean }>;
export function verifyLiveGcsOnboarding(options?: VerifyLiveGcsOnboardingOptions): Promise<VerifyLiveGcsOnboardingResult>;
export function runCli(options?: VerifyLiveGcsOnboardingOptions): Promise<VerifyLiveGcsOnboardingResult>;
