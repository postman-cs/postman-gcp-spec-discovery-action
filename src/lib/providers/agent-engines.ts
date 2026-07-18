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
        if (typeof declaration.name !== 'string' || (declaration.httpMethod !== undefined && !/^(get|put|post|delete|options|head|patch|trace)$/i.test(String(declaration.httpMethod)))) throw new Error('Invalid classMethod declaration');
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
  for (const [index, declaration] of engine.classMethods.entries()) {
    const method = typeof declaration.name === 'string' ? declaration.name : `method-${index + 1}`;
    const path = typeof declaration.path === 'string' ? declaration.path : `/${method}`;
    const verb = typeof declaration.httpMethod === 'string' ? declaration.httpMethod.toLowerCase() : 'post';
    paths[path] = { [verb]: { ...declaration, operationId: typeof declaration.operationId === 'string' ? declaration.operationId : method, responses: declaration.responses ?? { '200': { description: 'Agent Engine method response' } } } };
  }
  return { openapi: '3.0.3', info: { title: engine.displayName || engine.name.split('/').pop()!, version: 'generated', description: 'Generated from Vertex AI Agent Engine classMethods declarations' }, paths };
}
