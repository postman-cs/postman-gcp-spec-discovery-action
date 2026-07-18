import type { NarrowingTier } from '../../contracts.js';
import type { RepoSignals } from '../repo/signals.js';

export interface NarrowingResult {
  apiIds: string[];
  tier: NarrowingTier;
  mode: 'select' | 'narrow';
  droppedCount: number;
  evidence: string[];
  /**
   * True when more than one candidate carries the SAME exact canonical
   * `postman-repo` value. Multiple authoritative ownership claims are a hard
   * conflict: the runtime returns unresolved and never breaks the tie with
   * incidental tags or name heuristics.
   */
  conflict?: boolean;
}

export interface NarrowingContext {
  repoSlug?: string;
  projectId: string;
  serviceHints: string[];
  signals: RepoSignals;
}

export interface NarrowingCandidate {
  id: string;
  name: string;
  projectId?: string;
  tags?: Record<string, string>;
}

interface TierHit {
  ids: string[];
  selectId?: string;
  evidence: string[];
  conflict?: boolean;
}

function repoNameVariants(repoSlug?: string): string[] {
  const repoName = repoSlug?.split('/').pop()?.trim().toLowerCase() ?? '';
  if (!repoName) return [];
  const values = [repoName];
  for (const suffix of ['-service', '-api', '-backend', '-server', '-app']) {
    if (repoName.endsWith(suffix)) values.push(repoName.slice(0, -suffix.length));
  }
  return [...new Set(values.filter((value) => value.length > 2))];
}

export function canonicalRepoLabelValue(repoSlug: string | undefined): string | undefined {
  if (!repoSlug) return undefined;
  const value = repoSlug
    .toLowerCase()
    .replace(/\//g, '--')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return value && value.length <= 63 ? value : undefined;
}

function tierIac(signals: RepoSignals): TierHit | undefined {
  const ids = [...signals.explicitApiIdHints, ...signals.inferredApiIdHints];
  return ids.length > 0 ? { ids, evidence: [`IaC fingerprinting found ${ids.length} API config reference(s)`] } : undefined;
}

function tierProject(candidates: NarrowingCandidate[], context: NarrowingContext): TierHit | undefined {
  const variants = repoNameVariants(context.repoSlug);
  if (variants.length === 0 || !variants.some((value) => context.projectId.toLowerCase().includes(value))) return undefined;
  const matches = candidates.filter((candidate) => candidate.projectId === context.projectId);
  return matches.length > 0
    ? { ids: matches.map((candidate) => candidate.id), evidence: [`Project correlation matched ${matches.length} candidate(s)`] }
    : undefined;
}

function tierLabels(candidates: NarrowingCandidate[], context: NarrowingContext): TierHit | undefined {
  const canonical = canonicalRepoLabelValue(context.repoSlug);
  if (!canonical) return undefined;
  const exact = [...new Set(candidates
    .filter((candidate) => candidate.tags?.['postman-repo'] === canonical)
    .map((candidate) => candidate.id))];
  if (exact.length > 0) {
    return {
      ids: exact,
      ...(exact.length === 1 ? { selectId: exact[0] } : { conflict: true }),
      evidence: [`Found ${exact.length} exact postman-repo=${canonical} label match(es)`]
    };
  }
  const generic = candidates.filter((candidate) => {
    const labels = candidate.tags ?? {};
    return ['repo', 'repository', 'service'].some((key) => labels[key] === canonical);
  });
  return generic.length > 0
    ? { ids: generic.map((candidate) => candidate.id), evidence: [`Found ${generic.length} generic repo/service label match(es)`] }
    : undefined;
}

function tierNames(candidates: NarrowingCandidate[], context: NarrowingContext): TierHit | undefined {
  const variants = repoNameVariants(context.repoSlug);
  const matches = candidates.filter((candidate) => variants.some((value) => candidate.name.toLowerCase().includes(value)));
  return matches.length > 0
    ? { ids: matches.map((candidate) => candidate.id), evidence: [`Name matching ranked ${matches.length} candidate(s) first`] }
    : undefined;
}

export async function runNarrowingPipeline(
  context: NarrowingContext,
  candidates: NarrowingCandidate[]
): Promise<NarrowingResult | undefined> {
  const enumerated = new Set(candidates.map((candidate) => candidate.id));
  const tiers: Array<[NarrowingTier, () => TierHit | undefined]> = [
    ['iac-fingerprint', () => tierIac(context.signals)],
    ['project-correlation', () => tierProject(candidates, context)],
    ['label-prefilter', () => tierLabels(candidates, context)],
    ['naming-heuristic', () => tierNames(candidates, context)]
  ];
  for (const [tier, run] of tiers) {
    const hit = run();
    if (!hit) continue;
    const seen = new Set<string>();
    const intersecting = hit.ids.filter((id) => enumerated.has(id) && !seen.has(id) && Boolean(seen.add(id)));
    if (intersecting.length === 0) continue;
    const droppedCount = candidates.length - intersecting.length;
    const select = hit.selectId !== undefined && intersecting.length === 1 && intersecting[0] === hit.selectId;
    return {
      apiIds: intersecting,
      tier,
      mode: select ? 'select' : 'narrow',
      droppedCount,
      ...(hit.conflict ? { conflict: true } : {}),
      evidence: [...hit.evidence, `Narrowing (${tier}) ranked ${intersecting.length} candidate(s) first and demoted ${droppedCount} (not deleted)`]
    };
  }
  return undefined;
}
