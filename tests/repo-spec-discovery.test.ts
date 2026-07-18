import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findExistingRepoSpecTyped } from '../src/lib/repo/specs.js';

const VALID_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Payments', version: '1.0.0' },
  paths: { '/payments': { get: { responses: { '200': { description: 'ok' } } } } }
});

const INVALID_SPEC = JSON.stringify({ openapi: '3.0.3' });

async function repoRootWith(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gcp-repo-spec-'));
  for (const [relPath, content] of Object.entries(entries)) {
    const full = join(root, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return root;
}

describe('repository spec discovery validation (GCP-REPOSPEC)', () => {
  it('GCP-REPOSPEC-001: a marker-only document that fails full validation is not selected', async () => {
    const root = await repoRootWith({ 'openapi.json': INVALID_SPEC });
    expect(await findExistingRepoSpecTyped(root)).toBeUndefined();
  });

  it('GCP-REPOSPEC-002: one valid document resolves with evidence', async () => {
    const root = await repoRootWith({ 'openapi.json': VALID_SPEC });
    const match = await findExistingRepoSpecTyped(root);
    expect(match?.path).toBe('openapi.json');
    expect(match?.ambiguousPaths).toBeUndefined();
  });

  it('GCP-REPOSPEC-003: two equally ranked valid documents surface as ambiguous instead of guessing', async () => {
    const root = await repoRootWith({
      'apis/payments/openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: A\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n',
      'apis/billing/openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: B\n  version: 1.0.0\npaths:\n  /b:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    });
    const match = await findExistingRepoSpecTyped(root);
    expect(match?.ambiguousPaths?.length).toBe(2);
  });

  it('GCP-REPOSPEC-004: a higher-precedence valid document beats a lower-precedence one without ambiguity', async () => {
    const root = await repoRootWith({
      'openapi.json': VALID_SPEC,
      'apis/payments/openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: A\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n'
    });
    const match = await findExistingRepoSpecTyped(root);
    expect(match?.path).toBe('openapi.json');
    expect(match?.ambiguousPaths).toBeUndefined();
  });
});
