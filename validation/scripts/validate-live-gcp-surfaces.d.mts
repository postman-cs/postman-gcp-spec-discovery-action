export interface LiveFlags { provision: boolean; teardown: boolean }
export interface LiveEnv { projectId: string; location: string; apigeeOrg: string; apigeeEnv: string }
export interface EvidenceResult { name: string; status: string; sourceType: string; providerType: string; specFormat: string }
export interface Evidence { schemaVersion: number; capturedAt: string; cases: number; passed: number; failed: number; results: EvidenceResult[] }
export function parseFlags(argv: string[]): LiveFlags;
export function requiredEnv(env: Record<string, string | undefined>): LiveEnv;
export interface LiveManifest { runId: string; runMarker: string; gatewayName: string; gatewayConfigName?: string; endpointsService: string; proxyName: string }
export function verifyRemoteGatewayOwnership(manifest: LiveManifest, described: { labels?: Record<string, string> } | undefined): boolean;
export function verifyRemoteEndpointsOwnership(manifest: LiveManifest, serviceName: string | undefined): boolean;
export function verifyRemoteApigeeOwnership(manifest: LiveManifest, described: { name?: string } | undefined): boolean;
export function classifyProbeError(message: unknown): 'fatal' | 'retryable';
export function isResourceNotFoundError(error: unknown): boolean;
export function toEvidenceResult(name: string, status: string, resolution?: Partial<EvidenceResult>): EvidenceResult;
export function buildEvidence(results: EvidenceResult[]): Evidence;
export function runLiveValidation(options?: { argv?: string[]; env?: Record<string, string | undefined>; deps?: Record<string, unknown> }): Promise<Evidence>;
