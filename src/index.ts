// GitHub Action shell -- see runtime.ts for the core execution logic (execute, resolveInputs).
import * as core from '@actions/core';

import { actionSink, createLogger, createTelemetryContext, type Logger } from '@postman-cs/automation-core';

import { contractOutputNames, type DiscoveredService } from './contracts.js';
import { resolveActionVersion } from './action-version.js';
import {
  createGcpAuth,
  GcpSdkClient,
  type GcpDiscoveryClient
} from './lib/gcp/clients.js';
import { formatUserSafeError } from './lib/logging/sanitize.js';
import { appendAmbiguityStepSummary } from './lib/logging/step-summary.js';
import { prepareTelemetryCredentials, resolveTelemetryTeamId } from './lib/postman/telemetry-credentials.js';
import {
  defaultWriteSpecFile,
  execute,
  getInput,
  readActionInputs,
  type InputReaderLike,
  type ReporterLike
} from './runtime.js';
import type { SpecProvider } from './lib/providers/types.js';

export interface CoreLike extends InputReaderLike, ReporterLike {
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  setSecret?(value: string): void;
}

export interface GitHubActionDependencies {
  client?: GcpDiscoveryClient;
  writeSpecFile?: (outputPath: string, content: string) => Promise<void>;
  providers?: SpecProvider[];
  /** Injected by tests; otherwise built over `actionCore` when the run starts. */
  logger?: Logger;
}

export async function runAction(
  actionCore: CoreLike = core,
  dependencies: GitHubActionDependencies = {}
): Promise<DiscoveredService[]> {
  const actionVersion = resolveActionVersion();
  const logger =
    dependencies.logger ??
    createLogger({
      sink: actionSink(actionCore),
      fields: { action: 'gcp-spec-discovery', action_version: actionVersion }
    });
  const telemetry = createTelemetryContext({
    action: 'gcp-spec-discovery',
    actionVersion,
    logger: actionCore
  });
  telemetry.setTeamId(resolveTelemetryTeamId(process.env));
  const postmanApiKey = getInput('postman-api-key');
  const postmanAccessToken = getInput('postman-access-token');
  // Register before any phase can run: a credential that reaches the logger
  // after the first line is a credential that already leaked once.
  logger.addSecret(postmanApiKey);
  logger.addSecret(postmanAccessToken);
  if (postmanApiKey) {
    actionCore.setSecret?.(postmanApiKey);
  }
  if (postmanAccessToken) {
    actionCore.setSecret?.(postmanAccessToken);
  }
  const { accountType } = await logger.phase('prepare-telemetry-credentials', async () =>
    prepareTelemetryCredentials({
      postmanApiKey,
      postmanAccessToken,
      onToken: (token) => {
        logger.addSecret(token);
        actionCore.setSecret?.(token);
      },
      onWarning: (message) => actionCore.warning(message)
    })
  );
  try {
    const result = await logger.phase('discover', async () =>
      runActionInner(actionCore, dependencies, logger)
    );
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('success');
    return result;
  } catch (error) {
    telemetry.setAccountType(accountType);
    telemetry.emitCompletion('failure');
    throw error;
  }
}

async function runActionInner(
  actionCore: CoreLike = core,
  dependencies: GitHubActionDependencies = {},
  logger?: Logger
): Promise<DiscoveredService[]> {
  const inputs = readActionInputs(actionCore);
  logger?.debug('resolved inputs', {
    mode: inputs.mode,
    dry_run: inputs.dryRun,
    max_attempts: inputs.maxAttempts,
    request_timeout_ms: inputs.requestTimeoutMs
  });
  const sdkOptions = { requestTimeoutMs: inputs.requestTimeoutMs, maxAttempts: inputs.maxAttempts };
  const client = dependencies.client ?? new GcpSdkClient(createGcpAuth(), sdkOptions);

  const result = await execute(inputs, {
    core: actionCore,
    client,
    writeSpecFile: dependencies.writeSpecFile ?? defaultWriteSpecFile,
    providers: dependencies.providers
  });

  for (const [name, value] of Object.entries(result.outputs)) {
    actionCore.setOutput(name, value);
  }

  const ambiguityResolution = result.resolution;
  if (
    result.mode !== 'discover-many' &&
    ambiguityResolution?.status === 'unresolved' &&
    (ambiguityResolution.rankedCandidates?.length ?? 0) >= 2
  ) {
    await appendAmbiguityStepSummary(
      {
        status: ambiguityResolution.status,
        sourceType: ambiguityResolution.sourceType,
        narrowingTier: ambiguityResolution.narrowing?.tier ?? 'none',
        candidates: ambiguityResolution.rankedCandidates ?? [],
        probes: ambiguityResolution.providerProbes ?? []
      },
      process.env,
      (message) => actionCore.warning(message)
    );
  }

  actionCore.info(
    result.mode === 'discover-many'
      ? `Discovered ${result.discovered.length} service(s)`
      : `Resolution status: ${result.resolution?.status ?? 'unresolved'} (${result.resolution?.sourceType ?? 'manual-review'})`
  );

  return result.discovered;
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runAction().catch((error) => {
    const message = formatUserSafeError(error);
    core.setFailed(message);
  });
}

export * from './runtime.js';
export { chooseSource } from './lib/resolve/source-selector.js';
export {
  rankServiceCandidates,
  resolveServiceCandidate,
  toAmbiguousViews,
  type GCPCandidateInput,
  type RankedServiceCandidate
} from './lib/resolve/service-resolver.js';
export { runNarrowingPipeline, type NarrowingCandidate, type NarrowingResult } from './lib/resolve/narrowing-pipeline.js';
export { collectRepoSignals } from './lib/repo/signals.js';
export { scanGCPIac, type IacScanResult, type IacFingerprint } from './lib/repo/gcp-iac-scanner.js';
export { findExistingRepoSpecTyped, type RepoSpecMatch } from './lib/repo/specs.js';
export {
  ApiGatewayProvider,
  parseApiGatewayConfigName,
  parseApiGatewayProtobufConfigName
} from './lib/providers/api-gateway.js';
export {
  CloudEndpointsProvider,
  parseEndpointConfigName,
  parseEndpointProtobufConfigName
} from './lib/providers/cloud-endpoints.js';
export { resolveProtoSourceSet, extractProtoImports, normalizeProtoSourcePath } from './lib/spec/proto-source-set.js';
export { ApigeeProvider, parseApigeeArchiveDeploymentName, parseApigeeRevisionName } from './lib/providers/apigee.js';
export { ApiHubProvider, parseApiHubAdditionalSpecName, parseApiHubSpecName } from './lib/providers/api-hub.js';
export { ApigeeRegistryProvider, parseApigeeRegistrySpecName } from './lib/providers/apigee-registry.js';
export { AppIntegrationProvider } from './lib/providers/app-integration.js';
export { ConnectorsCustomProvider, parseGcsSpecLocation } from './lib/providers/connectors-custom.js';
export { ApigeePortalProvider, parseApigeePortalApidocName } from './lib/providers/apigee-portal.js';
export { VertexExtensionsProvider, parseVertexExtensionName } from './lib/providers/vertex-extensions.js';
export { AgentEnginesProvider } from './lib/providers/agent-engines.js';
export { DialogflowToolsProvider, parseDialogflowToolName } from './lib/providers/dialogflow-tools.js';
export { CesToolsetsProvider } from './lib/providers/ces-toolsets.js';
export { IacLocalProvider } from './lib/providers/iac-local.js';
export { parseAndValidateOpenApi } from './lib/spec/validate-openapi.js';
export {
  detectNativeFormat,
  nativeFilename,
  parseAndValidateNativeFamily,
  parseAndValidateNativeSpec
} from './lib/spec/native-formats.js';
export { decodeUtf8OpenApi, decodeUtf8NativeSpec } from './lib/providers/source-document.js';
export { deriveOpenApiDocument, type OpenApiDerivationInput, type OpenApiDerivationResult } from './lib/spec/oas-derivation.js';
export { renderAmbiguityStepSummary, appendAmbiguityStepSummary } from './lib/logging/step-summary.js';
export const outputNames = contractOutputNames;