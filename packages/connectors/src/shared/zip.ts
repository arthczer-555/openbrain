import { inflateRawSync } from "node:zlib";

// Minimal ZIP reader (central directory + stored / deflated entries) for .docx and .pptx, no dependency.
// Not supported: ZIP64, encryption, multi-disk archives. Entry sizes are capped against zip bombs.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** Uncompressed content of an entry, or undefined when the archive has no such entry. */
  read(name: string): Buffer | undefined;
}

export interface ZipOptions {
  /** Maximum uncompressed size of one entry (default 50 MB). */
  maxEntryBytes?: number;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const stop = Math.max(0, buffer.length - EOCD_MIN_SIZE - 0xffff);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipFormatError("not a ZIP archive (no end of central directory)");
}

function readEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < EOCD_MIN_SIZE) throw new ZipFormatError("not a ZIP archive (too short)");
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipFormatError("ZIP64 archives are not supported");
  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError("corrupted ZIP central directory");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      name: buffer.toString("utf8", offset + 46, offset + 46 + nameLength),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      size: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
      encrypted: (flags & 1) === 1,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extract(buffer: Buffer, entry: ZipEntry, maxEntryBytes: number): Buffer {
  if (entry.encrypted) throw new ZipFormatError(`${entry.name} is encrypted`);
  if (entry.size > maxEntryBytes) throw new ZipFormatError(`${entry.name} is too large (${entry.size} bytes)`);
  const local = entry.localHeaderOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(`corrupted local header for ${entry.name}`);
  }
  const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxEntryBytes });
  throw new ZipFormatError(`${entry.name}: compression method ${entry.method} is not supported`);
}

export function readZip(buffer: Buffer, options: ZipOptions = {}): ZipArchive {
  const maxEntryBytes = options.maxEntryBytes ?? 50 * 1024 * 1024;
  const entries = readEntries(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    entries,
    read(name: string): Buffer | undefined {
      const entry = byName.get(name);
      return entry ? extract(buffer, entry, maxEntryBytes) : undefined;
    },
  };
}
