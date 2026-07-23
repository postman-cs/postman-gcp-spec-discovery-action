import { execFile } from 'node:child_process';
import { access, constants, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { selectNpmCommand } from './helpers/npm-command.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('CLI packaging contract', () => {
  it('selects npm deterministically for supplied, missing, and non-Windows environments', () => {
    expect(selectNpmCommand('win32', 'C:\\node\\node.exe', 'C:\\npm\\npm-cli.js')).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\npm\\npm-cli.js'],
    });
    expect(selectNpmCommand('win32', 'C:\\node\\node.exe')).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js'],
    });
    expect(selectNpmCommand('darwin', '/usr/local/bin/node')).toEqual({ command: 'npm', args: [] });
  });

  it('GCP-PACK-001: dist/cli.cjs has a Node shebang, is executable, and answers --help/--version directly', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const contents = await readFile(cliPath, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true);

    if (process.platform !== 'win32') {
      const mode = (await stat(cliPath)).mode & 0o777;
      expect(mode & 0o111).not.toBe(0);
      await access(cliPath, constants.X_OK);
    }

    const help = await execFileAsync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
    expect(help.stdout.startsWith('Usage: postman-gcp-spec-discovery [options]')).toBe(true);

    const version = await execFileAsync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
    expect(version.stdout).toBe('1.1.7\n');
  });

  it('GCP-PACK-001: npm pack includes action.yml, docs, and both bundles', async () => {
    const npm = selectNpmCommand(process.platform, process.execPath, process.env.npm_execpath);
    const packOutput = await execFileAsync(npm.command, [...npm.args, 'pack', '--dry-run', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    const [report] = JSON.parse(packOutput.stdout) as Array<{ files: Array<{ path: string }> }>;
    const filePaths = new Set(report.files.map((file) => file.path));

    for (const required of [
      'action.yml',
      'dist/index.cjs',
      'dist/cli.cjs',
      'README.md',
      'docs/providers.md',
      'docs/LIVE_TESTING_RUNBOOK.md',
      'SECURITY.md',
      'SUPPORT.md',
      'RELEASE_POLICY.md'
    ]) {
      expect(filePaths.has(required), `npm pack must include ${required}`).toBe(true);
    }
  }, 240_000);

  it('GCP-PACK-001: bundled dist files have no runtime third-party require outside the allowlist', async () => {
    // Node builtins are fine; anything else must be inlined by esbuild.
    // node-fetch/debug optional peers are attempted inside swallowed
    // require; the canonical dist verifier carries the same narrow allowlist.
    const allow = new Set<string>(['encoding', 'supports-color']);
    for (const bundle of ['dist/index.cjs', 'dist/cli.cjs']) {
      const source = await readFile(path.join(repoRoot, bundle), 'utf8');
      // Strip block comments first: bundled vendor JSDoc (e.g. google-auth-library
      // usage examples) mentions require() without being a runtime dependency.
      // The canonical code-position walker lives in scripts/verify-dist-artifact.mjs.
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
      const requires = [...withoutComments.matchAll(/require\((['"])([^'")]+)\1\)/g)]
        .map((match) => match[2] as string)
        .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.') && !path.isAbsolute(spec));
      const builtin = new Set([
        'assert', 'buffer', 'child_process', 'constants', 'crypto', 'events', 'fs', 'http', 'http2', 'https', 'module',
        'net', 'os', 'path', 'process', 'punycode', 'querystring', 'stream', 'string_decoder', 'tls', 'tty', 'url',
        'timers', 'util', 'worker_threads', 'zlib'
      ]);
      const external = requires.filter((spec) => !builtin.has(spec) && !allow.has(spec));
      expect(external, `${bundle} must not require ${external.join(', ')}`).toEqual([]);
    }
  });
});
