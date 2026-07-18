export interface LiveFlags { provision: boolean; teardown: boolean }
export interface LiveEnv { projectId: string; location: string; apigeeOrg: string; apigeeEnv: string }
export interface EvidenceResult { name: string; status: string; sourceType: string; providerType: string; specFormat: string }
export interface Evidence { schemaVersion: number; capturedAt: string; cases: number; passed: number; failed: number; results: EvidenceResult[] }
export function parseFlags(argv: string[]): LiveFlags;
export function requiredEnv(env: Record<string, string | undefined>): LiveEnv;
export function shouldDeleteGatewayResource(input: { manifest?: { runMarker?: string; gatewayName?: string }; resourceName?: string; marker?: string }): boolean;
export function shouldDeleteApigeeProxy(input: { manifest?: { runMarker?: string; proxyName?: string }; proxyName?: string; marker?: string }): boolean;
export function classifyProbeError(message: unknown): 'fatal' | 'retryable';
export function isResourceNotFoundError(error: unknown): boolean;
export function toEvidenceResult(name: string, status: string, resolution?: Partial<EvidenceResult>): EvidenceResult;
export function buildEvidence(results: EvidenceResult[]): Evidence;
export function runLiveValidation(options?: { argv?: string[]; env?: Record<string, string | undefined>; deps?: Record<string, unknown> }): Promise<Evidence>;
