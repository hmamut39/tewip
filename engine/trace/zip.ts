// Minimal zip reader for Playwright trace.zip files (stored or deflated entries, no zip64,
// no encryption). Only the entries the caller asks for are decompressed.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function readZipEntries(file: string, wanted: (name: string) => boolean): Map<string, Buffer> {
  return readZipBuffer(readFileSync(file), wanted, file);
}

/** Same as readZipEntries for a zip already in memory (e.g. a zip nested in another zip). */
export function readZipBuffer(buf: Buffer, wanted: (name: string) => boolean, file = 'zip'): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file} is not a zip file`);

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error(`${file}: corrupt central directory`);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error(`${file}: zip64 entries are not supported`);
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`${file}: corrupt local header for ${name}`);
    // The local header's extra field can differ in length from the central one.
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, inflateRawSync(data));
    else throw new Error(`${file}: unsupported compression method ${method} for ${name}`);
  }
  return entries;
}
