import { Inflate } from 'fflate';

const MAX_COMPRESSED = 64 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const MAX_FILES = 2048;
const MAX_RATIO = 200;

function invalid(message) {
  throw new Error(`Invalid package: ${message}`);
}

export function normalizePath(input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) invalid('invalid file path');
  const path = input.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.startsWith('//'))
    invalid('absolute paths are not allowed');
  const parts = path.split('/');
  const clean = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') invalid('path traversal is not allowed');
    if (part.includes(':')) invalid('colon in path component is not allowed');
    clean.push(part);
  }
  if (!clean.length) invalid('empty file path');
  return clean.join('/').toLowerCase();
}

function read16(v, p, end, label) {
  if (p < 0 || p + 2 > end) invalid(`truncated ${label}`);
  return v.getUint16(p, true);
}

function read32(v, p, end, label) {
  if (p < 0 || p + 4 > end) invalid(`truncated ${label}`);
  return v.getUint32(p, true);
}

function decodeName(data, utf8, label) {
  try {
    if (utf8) return new TextDecoder('utf-8', { fatal: true }).decode(data);
    // ZIP's legacy name encoding is CP437. Restrict it to ASCII rather than
    // silently mapping distinct byte sequences to the same virtual path.
    for (const b of data) if (b > 0x7f) invalid(`${label} must use UTF-8`);
    return String.fromCharCode(...data);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Invalid package:')) throw e;
    invalid(`${label} is not valid UTF-8`);
  }
}

function locateEocd(bytes, v) {
  const start = Math.max(0, bytes.length - 22 - 65535);
  for (let p = bytes.length - 22; p >= start; p--) {
    if (v.getUint32(p, true) === 0x06054b50) {
      const commentLength = read16(v, p + 20, bytes.length, 'EOCD');
      if (p + 22 + commentLength === bytes.length) return p;
    }
  }
  invalid('missing ZIP end record');
}

function preflightZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_COMPRESSED)
    invalid('compressed package exceeds 64 MiB');
  if (bytes.byteLength < 22) invalid('truncated ZIP archive');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = locateEocd(bytes, v);
  const disk = read16(v, eocd + 4, bytes.length, 'EOCD');
  const centralDisk = read16(v, eocd + 6, bytes.length, 'EOCD');
  const diskEntries = read16(v, eocd + 8, bytes.length, 'EOCD');
  const entries = read16(v, eocd + 10, bytes.length, 'EOCD');
  const centralSize = read32(v, eocd + 12, bytes.length, 'EOCD');
  const centralOffset = read32(v, eocd + 16, bytes.length, 'EOCD');
  if (disk || centralDisk || diskEntries !== entries)
    invalid('multi-disk ZIP archives are unsupported');
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    invalid('ZIP64 archives are unsupported');
  if (entries > MAX_FILES) invalid('package contains more than 2048 entries');
  if (centralOffset + centralSize > eocd || centralOffset + centralSize < centralOffset)
    invalid('central directory is out of bounds');

  let cursor = centralOffset;
  let totalCompressed = 0;
  let totalExpanded = 0;
  const records = [];
  const seen = new Set();
  const pathKinds = new Map();
  const localRanges = [];
  const vEnd = centralOffset + centralSize;
  for (let i = 0; i < entries; i++) {
    if (read32(v, cursor, vEnd, 'central directory signature') !== 0x02014b50)
      invalid('malformed central directory');
    const madeBy = read16(v, cursor + 4, vEnd, 'central directory');
    const flags = read16(v, cursor + 8, vEnd, 'central directory');
    const method = read16(v, cursor + 10, vEnd, 'central directory');
    const crc = read32(v, cursor + 16, vEnd, 'central directory');
    const compressedSize = read32(v, cursor + 20, vEnd, 'central directory');
    const expandedSize = read32(v, cursor + 24, vEnd, 'central directory');
    const nameLength = read16(v, cursor + 28, vEnd, 'central directory');
    const extraLength = read16(v, cursor + 30, vEnd, 'central directory');
    const commentLength = read16(v, cursor + 32, vEnd, 'central directory');
    const diskStart = read16(v, cursor + 34, vEnd, 'central directory');
    const externalAttrs = read32(v, cursor + 38, vEnd, 'central directory');
    const localOffset = read32(v, cursor + 42, vEnd, 'central directory');
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > vEnd) invalid('central directory entry exceeds its bounds');
    if (
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      expandedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      invalid('split or ZIP64 entries are unsupported');
    if (flags & 1) invalid('encrypted ZIP entries are unsupported');
    if (flags & 0x40) invalid('strong encryption is unsupported');
    if (method !== 0 && method !== 8) invalid(`compression method ${method} is unsupported`);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const originalName = decodeName(nameBytes, !!(flags & 0x800), 'ZIP filename');
    if (method === 0 && compressedSize !== expandedSize)
      invalid(`stored entry size mismatch for ${originalName}`);
    const isDirectory = originalName.endsWith('/') || originalName.endsWith('\\');
    const path = normalizePath(isDirectory ? originalName.replace(/[\\/]$/, '') : originalName);
    const key = path.toLowerCase();
    if (seen.has(key)) invalid(`duplicate or case-colliding path: ${path}`);
    const components = key.split('/');
    for (let j = 1; j < components.length; j++) {
      const ancestor = components.slice(0, j).join('/');
      if (pathKinds.get(ancestor) === 'file')
        invalid(`file path conflicts with child path: ${path}`);
    }
    if (!isDirectory && [...pathKinds.keys()].some((existing) => existing.startsWith(`${key}/`)))
      invalid(`file path conflicts with child path: ${path}`);
    seen.add(key);
    pathKinds.set(key, isDirectory ? 'directory' : 'file');
    const unixMode = externalAttrs >>> 16;
    if ((unixMode & 0xf000) === 0xa000) invalid(`symlink entry is unsupported: ${path}`);
    if (isDirectory && (expandedSize !== 0 || compressedSize !== 0))
      invalid(`directory entry contains data: ${path}`);
    if (!isDirectory) {
      totalCompressed += compressedSize;
      totalExpanded += expandedSize;
      if (totalCompressed > MAX_COMPRESSED) invalid('compressed data exceeds 64 MiB');
      if (totalExpanded > MAX_EXPANDED) invalid('expanded package exceeds 128 MiB');
      if (expandedSize && (!compressedSize || expandedSize / compressedSize > MAX_RATIO))
        invalid(`compression ratio exceeds ${MAX_RATIO}:1 for ${path}`);
    }
    // Check each local record before allowing the inflater to see the archive.
    if (read32(v, localOffset, bytes.length, 'local file header') !== 0x04034b50)
      invalid(`missing local header for ${path}`);
    const localFlags = read16(v, localOffset + 6, bytes.length, 'local file header');
    const localMethod = read16(v, localOffset + 8, bytes.length, 'local file header');
    const localCrc = read32(v, localOffset + 14, bytes.length, 'local file header');
    const localCompressedSize = read32(v, localOffset + 18, bytes.length, 'local file header');
    const localExpandedSize = read32(v, localOffset + 22, bytes.length, 'local file header');
    const localNameLength = read16(v, localOffset + 26, bytes.length, 'local file header');
    const localExtraLength = read16(v, localOffset + 28, bytes.length, 'local file header');
    if (localFlags !== flags || localMethod !== method || localNameLength !== nameLength)
      invalid(`local and central headers disagree for ${path}`);
    if (flags & 8) {
      if (
        (localCrc && localCrc !== crc) ||
        (localCompressedSize && localCompressedSize !== compressedSize) ||
        (localExpandedSize && localExpandedSize !== expandedSize)
      )
        invalid(`local sizes disagree for ${path}`);
    } else if (
      localCrc !== crc ||
      localCompressedSize !== compressedSize ||
      localExpandedSize !== expandedSize
    )
      invalid(`local sizes disagree for ${path}`);
    const localName = decodeName(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      !!(localFlags & 0x800),
      'local filename',
    );
    if (localName !== originalName) invalid(`local filename mismatch for ${path}`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset || dataOffset + compressedSize < dataOffset)
      invalid(`compressed data is out of bounds for ${path}`);
    let localEnd = dataOffset + compressedSize;
    if (flags & 8) {
      let descriptor = localEnd;
      if (
        descriptor + 4 <= centralOffset &&
        read32(v, descriptor, centralOffset, 'data descriptor') === 0x08074b50
      )
        descriptor += 4;
      if (
        read32(v, descriptor, centralOffset, 'data descriptor') !== crc ||
        read32(v, descriptor + 4, centralOffset, 'data descriptor') !== compressedSize ||
        read32(v, descriptor + 8, centralOffset, 'data descriptor') !== expandedSize
      )
        invalid(`data descriptor disagrees for ${path}`);
      localEnd = descriptor + 12;
    }
    localRanges.push([localOffset, localEnd, path]);
    records.push({
      path,
      originalName,
      isDirectory,
      crc,
      compressedSize,
      expandedSize,
      method,
      flags,
      localOffset,
      dataOffset,
    });
    cursor = recordEnd;
  }
  if (cursor !== vEnd) invalid('central directory size does not match its entries');
  localRanges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < localRanges.length; i++)
    if (localRanges[i][0] < localRanges[i - 1][1])
      invalid(`overlapping local ZIP entries: ${localRanges[i][2]}`);
  return records;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function expandRecord(archive, record) {
  const output = new Uint8Array(record.expandedSize);
  const compressed = archive.subarray(record.dataOffset, record.dataOffset + record.compressedSize);
  if (record.method === 0) {
    output.set(compressed);
    return output;
  }
  let written = 0;
  const inflater = new Inflate();
  inflater.ondata = (chunk) => {
    if (written + chunk.length > output.length)
      invalid(`inflated data exceeds declared size for ${record.path}`);
    output.set(chunk, written);
    written += chunk.length;
  };
  try {
    if (!compressed.length) inflater.push(compressed, true);
    else {
      for (let offset = 0; offset < compressed.length; offset += 256) {
        const end = Math.min(offset + 256, compressed.length);
        inflater.push(compressed.subarray(offset, end), end === compressed.length);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Invalid package:')) throw e;
    invalid(`cannot decompress ${record.path} (${e?.message || 'inflate error'})`);
  }
  if (written !== output.length) invalid(`expanded size mismatch for ${record.path}`);
  return output;
}

export async function unpackPackage(input, name = 'program.exe') {
  if (!(input instanceof Uint8Array)) throw new TypeError('package input must be a Uint8Array');
  if (input.byteLength > MAX_COMPRESSED) invalid('compressed package exceeds 64 MiB');
  input = input.slice();
  const signatureView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const dosSignature = input.length >= 2 ? signatureView.getUint16(0, true) : 0;
  const files = new Map();
  if (dosSignature === 0x5a4d) {
    const path = normalizePath(name);
    if (!path.toLowerCase().endsWith('.exe')) invalid('raw package must have an .exe name');
    files.set(path, input.slice());
    return { files, executables: [path] };
  }
  const zipSignature = input.length >= 4 ? signatureView.getUint32(0, true) : 0;
  if (zipSignature !== 0x04034b50) invalid('input is neither a PE executable nor a ZIP package');
  const records = preflightZip(input);
  const executables = [];
  for (const record of records) {
    if (record.isDirectory) continue;
    const content = expandRecord(input, record);
    if (crc32(content) !== record.crc) invalid(`CRC mismatch for ${record.path}`);
    files.set(record.path, content);
    if (record.path.endsWith('.exe')) executables.push(record.path);
  }
  return { files, executables };
}
