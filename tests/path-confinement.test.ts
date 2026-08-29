import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { resolvePathWithinRoot } from '../src/lib/utils/resolve-path-within-root.js';

describe('output path confinement', () => {
  it.runIf(process.platform !== 'win32')(
    'rejects a dangling final symlink before a write can create its outside target',
    async () => {
      const sandbox = await mkdtemp(path.join(tmpdir(), 'gcp-dangling-symlink-'));
      const repoRoot = path.join(sandbox, 'repo');
      const outputParent = path.join(repoRoot, 'discovered-specs', 'payments');
      const outside = path.join(sandbox, 'outside-created.json');
      await mkdir(outputParent, { recursive: true });
      await symlink(outside, path.join(outputParent, 'index.json'));
      try {
        expect(() =>
          resolvePathWithinRoot(repoRoot, 'discovered-specs/payments/index.json', 'output-dir')
        ).toThrow(/must not traverse symbolic links/);
        expect(existsSync(outside)).toBe(false);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    }
  );

  it('GCP-CONTRACT-003: CLI rejects output-dir escape with exit 1 and no outside write', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'gcp-path-confinement-'));
    const repoRoot = path.join(sandbox, 'repo');
    await mkdir(repoRoot);
    try {
      const cli = path.resolve(process.cwd(), 'dist/cli.cjs');
      const result = spawnSync(
        process.execPath,
        [cli, '--project-id', 'sample-project-123', '--repo-root', repoRoot, '--output-dir', '../escape', '--result-json', 'result.json'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, POSTMAN_ACTIONS_TELEMETRY: 'off' }
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('output-dir must stay within repo-root/workspace; received ../escape');
      expect(existsSync(path.join(sandbox, 'escape'))).toBe(false);
      expect(existsSync(path.join(repoRoot, 'result.json'))).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
