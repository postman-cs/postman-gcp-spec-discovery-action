import type { ProviderProbeStatus, SourceAuthority } from '../../contracts.js';
import type { DialogflowToolSummary, GcpDiscoveryClient } from '../gcp/clients.js';
import { decodeUtf8OpenApi } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import { withAuthority, type SpecCandidate, type SpecExportResult, type SpecProvider } from './types.js';

const PATTERN = /^projects\/([^/]+)\/locations\/([^/]+)\/agents\/([^/]+)\/tools\/([^/]+)$/;
export function parseDialogflowToolName(value: string) {
  const match = PATTERN.exec(value);
  return match ? { projectId: match[1]!, location: match[2]!, agentId: match[3]!, toolId: match[4]! } : undefined;
}

export class DialogflowToolsProvider implements SpecProvider {
  public readonly type = 'dialogflow-tools' as const;
  public constructor(private readonly client: GcpDiscoveryClient, private readonly scope: { projectId: string; apiId?: string }) {}
  public async probe(): Promise<ProviderProbeStatus> {
    try { await this.client.probeDialogflow(this.scope.projectId); return 'available'; } catch (error) { return probeFailureStatus(error); }
  }
  public async listCandidates(): Promise<SpecCandidate[]> {
    const parsed = this.scope.apiId ? parseDialogflowToolName(this.scope.apiId) : undefined;
    if (this.scope.apiId && !parsed) return [];
    if (parsed && parsed.projectId !== this.scope.projectId) throw new Error('api-id Dialogflow tool does not belong to configured project-id');
    let tools: DialogflowToolSummary[] = [];
    if (parsed) tools = (await this.client.listDialogflowTools(`projects/${parsed.projectId}/locations/${parsed.location}/agents/${parsed.agentId}`)).filter((tool) => tool.name === this.scope.apiId);
    else for (const agent of await this.client.listDialogflowAgents(this.scope.projectId)) tools.push(...await this.client.listDialogflowTools(agent.name));
    return tools.map((tool) => {
      const schema = tool.textSchema ?? '';
      const hasSchema = Boolean(schema.trim());
      let supported = hasSchema;
      let authority: SourceAuthority = hasSchema ? 'stored-authoritative' : 'metadata-only';
      if (hasSchema) {
        try { decodeUtf8OpenApi(schema); } catch { supported = false; authority = 'metadata-only'; }
      }
      return withAuthority({
        id: tool.name,
        apiId: tool.name,
        name: tool.displayName || tool.name.split('/').pop()!,
        providerType: this.type,
        sourceType: 'dialogflow-tool-schema',
        authority,
        projectId: this.scope.projectId,
        tags: {},
        supported,
        evidence: [hasSchema ? 'Dialogflow tool stores an OpenAPI text schema' : 'Dialogflow tool has no OpenAPI text schema; only OPEN_API_TOOL tools are exportable'],
        meta: { textSchema: schema }
      });
    });
  }
  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    return { ...decodeUtf8OpenApi(candidate.meta.textSchema ?? ''), evidence: ['Exported original Dialogflow tool OpenAPI text schema'] };
  }
}
