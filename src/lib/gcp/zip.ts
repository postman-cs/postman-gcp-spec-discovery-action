import { inflateRawSync } from 'node:zlib';

const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;

export function inflateZip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    if (flags & 0x08) throw new Error('ZIP data descriptors are not supported');
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const end = dataOffset + compressedSize;
    if (end > bytes.length) throw new Error('Invalid truncated ZIP entry');
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    if (!name.endsWith('/')) {
      const compressed = bytes.subarray(dataOffset, end);
      const content = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : undefined;
      if (!content) throw new Error(`Unsupported ZIP compression method ${method}`);
      total += content.length;
      if (total > MAX_EXTRACTED_BYTES) throw new Error('ZIP extracted contents exceed 10 MiB');
      files.set(name, content);
    }
    offset = end;
  }
  return files;
}
