import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { SpecFormat } from '../../contracts.js';

export type DefinitionFileRole = 'root' | 'dependency';
export type DefinitionCompleteness = 'full' | 'partial';

export interface DefinitionFileInventoryEntry {
  path: string;
  role: DefinitionFileRole;
  bytes: number;
  sha256: string;
}

export interface DefinitionFileInventory {
  schemaVersion: 1;
  root: string;
  format: SpecFormat;
  completeness: DefinitionCompleteness;
  provenance: { kind: 'provider'; provider: 'gcp' };
  files: DefinitionFileInventoryEntry[];
}

export interface InventoryMemberInput {
  /** Workspace-relative POSIX path. */
  path: string;
  role: DefinitionFileRole;
  content: string;
}

export interface StageMemberInput {
  /** Path relative to the service directory (POSIX). */
  relativePath: string;
  content: string;
}

export interface StageAndSwapOptions {
  repoRoot: string;
  /** Workspace-relative service directory (e.g. discovered-specs/payments). */
  serviceDirRelative: string;
  members: StageMemberInput[];
  runId?: string;
  /**
   * Test hook invoked before writing each owned member (0-based).
   * Throw to simulate a mid-stage failure; the canonical tree must remain intact.
   */
  beforeWriteMember?: (index: number, relativePath: string) => void | Promise<void>;
  /**
   * Test hook invoked after stage has been renamed to canonical (backup may exist).
   * Throw or mutate canonical bytes to simulate post-swap validation failure;
   * prior backup must be restored and stage/backup residue cleaned.
   */
  afterCanonicalSwap?: () => void | Promise<void>;
}

function sha256HexOfString(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Locale-independent path identity key (NFC + fixed-locale case fold).
 * Used only for collision detection; emitted inventory paths stay NFC form.
 */
function caseFoldPathKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

function assertSafeRelativePath(value: string, label: string): string {
  const normalized = value.trim().replace(/\\/g, '/').normalize('NFC');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('\0')) {
    throw new Error(`${label} path is unsafe: ${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} path is unsafe: ${value}`);
  }
  return parts.join('/');
}

function assertUniquePathIdentities(
  paths: Iterable<string>,
  label: string
): void {
  const seen = new Map<string, string>();
  for (const pathKey of paths) {
    const identity = caseFoldPathKey(pathKey);
    const prior = seen.get(identity);
    if (prior !== undefined) {
      throw new Error(`${label} paths collide under NFC/case-fold (${prior} vs ${pathKey}); refusing to merge`);
    }
    seen.set(identity, pathKey);
  }
}

/**
 * Build the exact R2 inventory object. Files are sorted by path; no content is embedded.
 */
export function buildDefinitionFileInventory(args: {
  root: string;
  format: SpecFormat;
  completeness: DefinitionCompleteness;
  members: InventoryMemberInput[];
}): DefinitionFileInventory {
  const root = assertSafeRelativePath(args.root, 'inventory root');
  const files = args.members
    .map((member) => {
      const memberPath = assertSafeRelativePath(member.path, 'inventory member');
      const bytes = Buffer.byteLength(member.content, 'utf8');
      return {
        path: memberPath,
        role: member.role,
        bytes,
        sha256: sha256HexOfString(member.content)
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  assertUniquePathIdentities(
    files.map((file) => file.path),
    'Inventory member'
  );

  const roots = files.filter((file) => file.role === 'root');
  if (roots.length !== 1) {
    throw new Error(`Inventory must contain exactly one root, found ${roots.length}`);
  }
  if (roots[0]!.path !== root) {
    throw new Error(`Inventory root path mismatch: expected ${root}, found ${roots[0]!.path}`);
  }

  return {
    schemaVersion: 1,
    root,
    format: args.format,
    completeness: args.completeness,
    provenance: { kind: 'provider', provider: 'gcp' },
    files
  };
}

/** Single-line JSON serialization for action/CLI output. */
export function serializeDefinitionFileInventory(inventory: DefinitionFileInventory): string {
  return JSON.stringify(inventory);
}

export async function validateStagedMembers(
  stageDirAbs: string,
  members: StageMemberInput[]
): Promise<void> {
  for (const member of members) {
    const relativePath = assertSafeRelativePath(member.relativePath, 'staged member');
    const absolute = path.join(stageDirAbs, ...relativePath.split('/'));
    const onDisk = await readFile(absolute);
    const expected = Buffer.from(member.content, 'utf8');
    if (!onDisk.equals(expected)) {
      throw new Error(`Staged member byte mismatch at ${relativePath}`);
    }
    if (createHash('sha256').update(onDisk).digest('hex') !== sha256HexOfString(member.content)) {
      throw new Error(`Staged member hash mismatch at ${relativePath}`);
    }
  }
}

async function fsyncFile(absolutePath: string): Promise<void> {
  const handle = await open(absolutePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExactFile(absolutePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const bytes = Buffer.from(content, 'utf8');
  await pipeline(Readable.from(bytes), createWriteStream(absolutePath));
  await fsyncFile(absolutePath);
}

async function walkFiles(rootAbs: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(currentAbs: string, relative: string): Promise<void> {
    const entries = await readdir(currentAbs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbs = path.join(currentAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        out.push(childRel.split(path.sep).join('/'));
      }
    }
  }
  await walk(rootAbs, '');
  return out;
}

/**
 * Preserve non-definition sidecars (e.g. derived OpenAPI) from a prior service tree.
 * Prior `.proto` files that are absent from the new owned set are treated as stale
 * owned members and are not copied.
 */
async function copyPreservedSidecars(
  canonicalAbs: string,
  stageAbs: string,
  ownedRelativePaths: ReadonlySet<string>
): Promise<void> {
  let priorFiles: string[];
  try {
    priorFiles = await walkFiles(canonicalAbs);
  } catch {
    return;
  }
  for (const relative of priorFiles) {
    if (ownedRelativePaths.has(relative)) continue;
    if (relative.endsWith('.proto')) continue;
    const from = path.join(canonicalAbs, ...relative.split('/'));
    const to = path.join(stageAbs, ...relative.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the complete owned target into a sibling stage directory, validate hashes,
 * then atomically swap it into the canonical service directory with backup/rollback.
 * Never edits files in the canonical directory in place.
 */
export async function stageAndSwapServiceDirectory(options: StageAndSwapOptions): Promise<void> {
  const serviceDirRelative = assertSafeRelativePath(options.serviceDirRelative, 'service directory');
  if (options.members.length === 0) {
    throw new Error('Refusing to stage an empty definition member set');
  }

  const owned = options.members.map((member) => ({
    relativePath: assertSafeRelativePath(member.relativePath, 'owned member'),
    content: member.content
  }));
  assertUniquePathIdentities(
    owned.map((member) => member.relativePath),
    'Owned member'
  );
  const ownedSet = new Set(owned.map((member) => member.relativePath));

  const runId = options.runId ?? randomBytes(8).toString('hex');
  const canonicalAbs = path.resolve(options.repoRoot, ...serviceDirRelative.split('/'));
  const stageAbs = `${canonicalAbs}.stage-${runId}`;
  const backupAbs = `${canonicalAbs}.backup-${runId}`;

  await rm(stageAbs, { recursive: true, force: true });
  await rm(backupAbs, { recursive: true, force: true });
  await mkdir(stageAbs, { recursive: true });

  let swappedToCanonical = false;
  try {
    for (let index = 0; index < owned.length; index += 1) {
      const member = owned[index]!;
      await options.beforeWriteMember?.(index, member.relativePath);
      const absolute = path.join(stageAbs, ...member.relativePath.split('/'));
      await writeExactFile(absolute, member.content);
    }

    if (await pathExists(canonicalAbs)) {
      await copyPreservedSidecars(canonicalAbs, stageAbs, ownedSet);
    }

    await validateStagedMembers(stageAbs, owned);

    const hadCanonical = await pathExists(canonicalAbs);
    if (hadCanonical) {
      await rename(canonicalAbs, backupAbs);
    }
    try {
      await rename(stageAbs, canonicalAbs);
      swappedToCanonical = true;
    } catch (error) {
      if (hadCanonical && (await pathExists(backupAbs))) {
        await rename(backupAbs, canonicalAbs);
      }
      throw error;
    }

    await options.afterCanonicalSwap?.();
    await validateStagedMembers(canonicalAbs, owned);
    if (await pathExists(backupAbs)) {
      await rm(backupAbs, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(stageAbs, { recursive: true, force: true });
    if (swappedToCanonical) {
      // Failed canonical must not remain active; restore prior bytes when backup exists.
      await rm(canonicalAbs, { recursive: true, force: true });
      if (await pathExists(backupAbs)) {
        await rename(backupAbs, canonicalAbs);
      }
    }
    throw error;
  }
}

export function sha256Hex(content: string): string {
  return sha256HexOfString(content);
}
