import type { ProviderProbeStatus } from '../../contracts.js';
import type { AppIntegrationApiTrigger, GcpDiscoveryClient } from '../gcp/clients.js';
import { decodeUtf8OpenApi } from './source-document.js';
import { probeFailureStatus } from './probe.js';
import type { SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export interface AppIntegrationScope {
  projectId: string;
  apiId?: string;
}

function shortName(value: string): string {
  return value.split('/').pop() ?? value;
}

/**
 * Application Integration publishes integrations behind API triggers and can
 * generate an OpenAPI 3.0 document for them server-side (generateOpenApiSpec).
 * The document is derived by Google from the trigger request/response schemas,
 * so it is a generated contract rather than an uploaded design-time file, but
 * it is valid OpenAPI for onboarding. Integrations without an API trigger are
 * not API surfaces and are not listed.
 */
export class AppIntegrationProvider implements SpecProvider {
  public readonly type = 'app-integration' as const;

  public constructor(
    private readonly client: GcpDiscoveryClient,
    private readonly scope: AppIntegrationScope
  ) {}

  public async probe(): Promise<ProviderProbeStatus> {
    try {
      await this.client.probeAppIntegration(this.scope.projectId);
      return 'available';
    } catch (error) {
      return probeFailureStatus(error);
    }
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    if (this.scope.apiId) return [];
    const triggers = await this.client.listAppIntegrationApiTriggers(this.scope.projectId);
    return triggers.map((trigger) => this.toCandidate(trigger));
  }

  public async exportSpec(candidate: SpecCandidate): Promise<SpecExportResult> {
    const triggerIds = candidate.meta.triggerIds ? candidate.meta.triggerIds.split('\u0000') : [];
    if (triggerIds.length === 0) throw new Error('Application Integration candidate has no API trigger');
    const content = await this.client.generateAppIntegrationOpenApiSpec(
      candidate.meta.location ?? '',
      candidate.id,
      triggerIds
    );
    const decoded = decodeUtf8OpenApi(content);
    return {
      ...decoded,
      evidence: [
        `Generated OpenAPI from Application Integration API trigger${triggerIds.length === 1 ? '' : 's'} ${triggerIds.join(', ')}`,
        'Contract is generated from trigger schemas by generateOpenApiSpec, not an uploaded source file'
      ]
    };
  }

  private toCandidate(trigger: AppIntegrationApiTrigger): SpecCandidate {
    return {
      id: trigger.integrationResource,
      name: shortName(trigger.integrationResource),
      providerType: this.type,
      projectId: this.scope.projectId,
      tags: {},
      supported: trigger.triggerIds.length > 0,
      evidence: [
        `Application Integration ${shortName(trigger.integrationResource)} exposes ${trigger.triggerIds.length} API trigger${trigger.triggerIds.length === 1 ? '' : 's'} in ${trigger.location}`
      ],
      meta: {
        location: trigger.location,
        triggerIds: trigger.triggerIds.join('\u0000'),
        updateTime: trigger.updateTime ?? ''
      }
    };
  }
}
