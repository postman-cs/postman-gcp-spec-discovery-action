import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

function nearestExistingAncestor(candidate: string): string {
  let current = candidate;
  for (;;) {
    try {
      return realpathSync(current);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function assertNoSymlinkComponents(base: string, resolved: string, targetPath: string, fieldName: string): void {
  const relative = path.relative(base, resolved);
  let current = base;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `${fieldName} must not traverse symbolic links; received ${targetPath}`
        );
      }
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

/**
 * Confine target beneath root lexically AND by realpath: the nearest existing
 * ancestor of the resolved target must live inside the root's real path, so a
 * symlinked segment cannot redirect writes outside the workspace.
 */
export function resolvePathWithinRoot(rootPath: string, targetPath: string, fieldName: string): string {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(base, targetPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace; received ${targetPath}`);
  }
  // realpathSync() follows symlinks and throws for a dangling final link. Walk
  // with lstatSync() first so a link whose target does not exist cannot be
  // mistaken for a missing ordinary path and approved for a later write.
  assertNoSymlinkComponents(base, resolved, targetPath, fieldName);
  const realBase = nearestExistingAncestor(base);
  const realResolved = nearestExistingAncestor(resolved);
  const realRelative = path.relative(realBase, realResolved);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace after resolving symlinks; received ${targetPath}`);
  }
  return resolved;
}
