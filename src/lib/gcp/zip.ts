import { inflateRawSync } from 'node:zlib';

const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;

function safeEntryName(name: string): string {
  if (!name || name.includes('\0')) throw new Error('ZIP contains an unsafe entry name');
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/i.test(normalized)) {
    throw new Error('ZIP contains an unsafe entry name');
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('ZIP contains an unsafe entry name');
  }
  return normalized;
}

function addEntry(files: Map<string, Buffer>, total: number, name: string, method: number, compressed: Buffer): number {
  name = safeEntryName(name);
  if (name.endsWith('/')) return total;
  if (files.has(name)) throw new Error('ZIP contains duplicate entry names');
  const remaining = MAX_EXTRACTED_BYTES - total;
  if (method === 0 && compressed.length > remaining) throw new Error('ZIP extracted contents exceed 10 MiB');
  let content: Buffer | undefined;
  if (method === 0) {
    content = Buffer.from(compressed);
  } else if (method === 8) {
    try {
      // maxOutputLength caps allocation during inflation, so a decompression
      // bomb fails before it can materialize beyond the extraction budget.
      content = inflateRawSync(compressed, { maxOutputLength: remaining + 1 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error('ZIP extracted contents exceed 10 MiB', { cause: error });
      }
      throw error;
    }
  }
  if (!content) throw new Error(`Unsupported ZIP compression method ${method}`);
  const next = total + content.length;
  if (next > MAX_EXTRACTED_BYTES) throw new Error('ZIP extracted contents exceed 10 MiB');
  files.set(name, content);
  return next;
}

/**
 * Parse via the central directory when present. Real Apigee revision bundles
 * set the data-descriptor flag (bit 3) on local headers, so sizes live in the
 * central directory, not the local entry.
 */
function inflateFromCentralDirectory(bytes: Buffer): Map<string, Buffer> | undefined {
  const scanStart = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= scanStart; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return undefined;
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Invalid ZIP local header reference');
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const end = dataOffset + compressedSize;
    if (end > bytes.length) throw new Error('Invalid truncated ZIP entry');
    total = addEntry(files, total, name, method, bytes.subarray(dataOffset, end));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

export function inflateZip(bytes: Buffer): Map<string, Buffer> {
  const central = inflateFromCentralDirectory(bytes);
  if (central) return central;

  const files = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    if (flags & 0x08) throw new Error('ZIP data descriptors require a central directory');
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const end = dataOffset + compressedSize;
    if (end > bytes.length) throw new Error('Invalid truncated ZIP entry');
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    total = addEntry(files, total, name, method, bytes.subarray(dataOffset, end));
    offset = end;
  }
  return files;
}
