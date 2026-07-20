import { describe, expect, it } from 'vitest';

import { inflateZip } from '../src/lib/gcp/zip.js';

function storedEntry(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name);
  const contentBytes = Buffer.from(content);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(contentBytes.length, 18);
  header.writeUInt16LE(nameBytes.length, 26);
  return Buffer.concat([header, nameBytes, contentBytes]);
}

describe('ZIP source bundle confinement', () => {
  it('rejects traversal, absolute, NUL, and duplicate normalized entry names', () => {
    for (const name of ['../openapi.yaml', '/openapi.yaml', 'C:\\openapi.yaml', 'openapi\0.yaml']) {
      expect(() => inflateZip(storedEntry(name, 'openapi: 3.0.3'))).toThrow('unsafe entry name');
    }
    expect(() => inflateZip(Buffer.concat([
      storedEntry('spec/openapi.yaml', 'openapi: 3.0.3'),
      storedEntry('spec\\openapi.yaml', 'openapi: 3.0.3')
    ]))).toThrow('duplicate entry names');
  });
});
