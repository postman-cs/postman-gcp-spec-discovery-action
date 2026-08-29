import { parse } from 'yaml';

/**
 * Parse untrusted API description YAML without YAML 1.1 merge expansion.
 * Pinning the core schema is important: an in-document `%YAML 1.1` directive
 * otherwise re-enables recursive `<<` merges even when merge:false is passed.
 */
export function parseUntrustedYaml(source: string): unknown {
  return parse(source, {
    schema: 'core',
    merge: false,
    maxAliasCount: 50
  });
}
