import { realpathSync } from 'node:fs';
import path from 'node:path';

function nearestExistingAncestor(candidate: string): string {
  let current = candidate;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
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
  const realBase = nearestExistingAncestor(base);
  const realResolved = nearestExistingAncestor(resolved);
  const realRelative = path.relative(realBase, realResolved);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`${fieldName} must stay within repo-root/workspace after resolving symlinks; received ${targetPath}`);
  }
  return resolved;
}
