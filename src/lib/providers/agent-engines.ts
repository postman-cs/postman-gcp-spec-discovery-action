import type { ProviderProbeStatus } from '../../contracts.js';
import type { AgentEngineSummary, GcpDiscoveryClient } from '../gcp/clients.js';
import { parseAndValidateOpenApi } from '../spec/validate-openapi.js';
import { decodeUtf8OpenApi } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class AgentEnginesProvider implements SpecProvider {
  public readonly type = 'agent-engines' as const;
  public constructor(private readonly client: GcpDiscoveryClient, private readonly scope: { projectId: string; location?: string; apiId?: string }) {}

  private async locations(): Promise<string[]> {
    return this.scope.location && this.scope.location !== 'global' ? [this.scope.location] : this.client.listVertexLocations(this.scope.projectId);
  }

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      let failure: unknown;
      for (const location of await this.locations()) {
        try { await this.client.probeAgentEngines(this.scope.projectId, location); return 'available'; } catch (error) { failure = error; }
      }
      return probeFailureStatus(failure ?? new Error('Vertex AI returned no locations'));
    } catch (error) { return probeFailureStatus(error); }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    const engines: AgentEngineSummary[] = [];
    for (const location of await this.locations()) {
      try { engines.push(...await this.client.listAgentEngines(this.scope.projectId, location)); } catch { /* Regional Agent Engine surfaces are fail-soft. */ }
    }
    return engines.filter((engine) => engine.classMethods.length > 0).map((engine) => this.toCandidate(engine));
  }

  private toCandidate(engine: AgentEngineSummary): SpecCandidate {
    const document = JSON.stringify(assembleAgentEngineOpenApi(engine));
    let supported = true;
    const evidence = ['OpenAPI assembled from Agent Engine classMethods declarations; confidence is lower than stored specification sources'];
    try {
      for (const declaration of engine.classMethods) {
        if (typeof declaration.name !== 'string') throw new Error('Invalid classMethod declaration');
      }
      parseAndValidateOpenApi(document);
    } catch { supported = false; evidence.push('Generated spec has no operations or is invalid; manual review'); }
    return { id: engine.name, apiId: engine.name, name: engine.displayName || engine.name.split('/').pop()!, providerType: this.type, sourceType: 'agent-engine-generated-spec', projectId: this.scope.projectId, tags: {}, supported, evidence, meta: { generatedOpenApi: document } };
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    return { ...decodeUtf8OpenApi(candidate.meta.generatedOpenApi ?? ''), evidence: ['OpenAPI assembled from Agent Engine classMethods declarations'] };
  }
}

function assembleAgentEngineOpenApi(engine: AgentEngineSummary): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const mode of ['', 'stream'] as const) {
    const declarations = engine.classMethods.filter((declaration) => (declaration.api_mode === 'stream' ? 'stream' : '') === mode);
    if (declarations.length === 0) continue;
    const suffix = mode === 'stream' ? 'streamQuery' : 'query';
    paths[`/v1/{engine.name}:${suffix}`] = {
      post: {
        operationId: suffix,
        description: declarations.map((declaration) => typeof declaration.description === 'string' ? declaration.description : undefined).filter(Boolean).join('\n\n') || undefined,
        parameters: [{ name: 'engine.name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: declarations.map((declaration) => ({
                  type: 'object',
                  required: ['class_method', 'input'],
                  properties: {
                    class_method: { type: 'string', enum: [declaration.name] },
                    input: parameterSchema(declaration)
                  }
                }))
              }
            }
          }
        },
        responses: { '200': { description: 'Agent Engine method response' } }
      }
    };
  }
  return { openapi: '3.0.3', info: { title: engine.displayName || engine.name.split('/').pop()!, version: 'generated', description: 'Generated from Vertex AI Agent Engine classMethods declarations' }, paths };
}

function parameterSchema(declaration: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(declaration.parameters)) return declaration.parameters;
  if (isRecord(declaration.properties)) return { type: 'object', properties: declaration.properties };
  return { type: 'object', additionalProperties: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
