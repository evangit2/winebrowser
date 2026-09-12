import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePE } from '../src/pe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'tests/targets.json'), 'utf8'));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseHeaders(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  const peOffset = u32(0x3c);
  const coffOffset = peOffset + 4;
  const optionalOffset = coffOffset + 20;
  const optionalSize = u16(coffOffset + 16);
  const sectionCount = u16(coffOffset + 2);
  const sectionOffset = optionalOffset + optionalSize;
  const directoryCount = u32(optionalOffset + 92);
  const directories = [];
  for (let i = 0; i < Math.min(directoryCount, Math.floor((optionalSize - 96) / 8)); i++) {
    const rva = u32(optionalOffset + 96 + i * 8);
    const size = u32(optionalOffset + 100 + i * 8);
    if (rva || size) directories.push({ index: i, rva, size });
  }
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const offset = sectionOffset + i * 40;
    const nameBytes = bytes.subarray(offset, offset + 8);
    const nameEnd = nameBytes.indexOf(0);
    const name = Buffer.from(nameBytes.subarray(0, nameEnd < 0 ? 8 : nameEnd)).toString('ascii');
    const virtualSize = u32(offset + 8);
    const rva = u32(offset + 12);
    const rawSize = u32(offset + 16);
    const rawOffset = u32(offset + 20);
    const characteristics = u32(offset + 36);
    const availableRawBytes =
      rawOffset < bytes.length ? Math.min(rawSize, bytes.length - rawOffset) : 0;
    sections.push({
      name,
      rva,
      virtualSize,
      rawSize,
      rawOffset,
      rawRange: [rawOffset, rawOffset + rawSize],
      bytesBackedByFile: availableRawBytes,
      rawTailMissingFromFile: Math.max(0, rawSize - availableRawBytes),
      zeroFillBytes: Math.max(0, virtualSize - rawSize),
      imageSpan: [rva, rva + Math.max(virtualSize, rawSize)],
      overlapsHeaders: rawSize > 0 && rawOffset < u32(optionalOffset + 60),
      rawOffsetAlignedToFileAlignment: rawSize === 0 || rawOffset % u32(optionalOffset + 36) === 0,
      characteristics,
    });
  }
  return {
    peOffset,
    machine: u16(coffOffset),
    sectionCount,
    optionalSize,
    optionalMagic: u16(optionalOffset),
    entryRva: u32(optionalOffset + 16),
    imageBase: u32(optionalOffset + 28),
    sectionAlignment: u32(optionalOffset + 32),
    fileAlignment: u32(optionalOffset + 36),
    imageSize: u32(optionalOffset + 56),
    headersSize: u32(optionalOffset + 60),
    subsystem: u16(optionalOffset + 68),
    directoryCount,
    directories,
    sections,
  };
}

function mappedBytes(bytes, headers, rva, size, options = {}) {
  const end = rva + size;
  if (rva < headers.headersSize && end <= headers.headersSize) {
    return { bytes: bytes.slice(rva, end), rawBytes: size, zeroFillBytes: 0 };
  }
  const section = headers.sections.find(
    (candidate) =>
      rva >= candidate.rva &&
      end <= candidate.rva + Math.max(candidate.virtualSize, candidate.rawSize),
  );
  if (!section) return null;
  const sectionOffset = rva - section.rva;
  const output = new Uint8Array(size);
  let rawBytes = 0;
  let virtualZeroBytes = 0;
  for (let i = 0; i < size; i++) {
    const relative = sectionOffset + i;
    if (relative >= section.rawSize) {
      virtualZeroBytes++;
      continue;
    }
    const rawBase = options.alignRawPointerDown
      ? Math.floor(section.rawOffset / headers.fileAlignment) * headers.fileAlignment
      : section.rawOffset;
    const sourceOffset = rawBase + relative;
    if (sourceOffset >= bytes.length) return null;
    output[i] = bytes[sourceOffset];
    rawBytes++;
  }
  return { bytes: output, rawBytes, zeroFillBytes: virtualZeroBytes };
}

function decodeImports(bytes, headers, options = {}) {
  const importDirectory = headers.directories.find((directory) => directory.index === 1);
  if (!importDirectory) return null;
  const endBeyondImage = importDirectory.rva + importDirectory.size > headers.imageSize;
  if (endBeyondImage && !options.allowOversizedDirectory) {
    return {
      mapping: 'literal PE section PointerToRawData mapping',
      directory: importDirectory,
      declaredEndRva: importDirectory.rva + importDirectory.size,
      mappedSpan: null,
      endBeyondImage: true,
      descriptors: [],
      note: 'Directory range exceeds SizeOfImage; no descriptors decoded in standards view.',
    };
  }
  const readU32Rva = (rva) => {
    const mapped = mappedBytes(bytes, headers, rva, 4, options);
    return mapped
      ? new DataView(mapped.bytes.buffer, mapped.bytes.byteOffset, 4).getUint32(0, true)
      : null;
  };
  const readStringRva = (rva) => {
    const parts = [];
    let rawBytes = 0;
    for (let i = 0; i < 4096; i++) {
      const mapped = mappedBytes(bytes, headers, rva + i, 1, options);
      if (!mapped) return { value: null, rawBytes, terminated: false };
      if (!mapped.bytes[0])
        return { value: Buffer.from(parts).toString('ascii'), rawBytes, terminated: true };
      parts.push(mapped.bytes[0]);
      rawBytes += mapped.rawBytes;
    }
    return { value: null, rawBytes, terminated: false };
  };

  const descriptors = [];
  for (let index = 0; index < 4096; index++) {
    const rva = importDirectory.rva + index * 20;
    const fields = Array.from({ length: 5 }, (_, i) => readU32Rva(rva + i * 4));
    if (fields.some((field) => field === null)) break;
    if (fields.every((field) => field === 0)) {
      const mappedDescriptor = mappedBytes(bytes, headers, rva, 20, options);
      descriptors.push({
        index,
        rva,
        terminator: true,
        mappedBytes: mappedDescriptor
          ? {
              fileBackedBytes: mappedDescriptor.rawBytes,
              zeroFillBytes: mappedDescriptor.zeroFillBytes,
            }
          : null,
      });
      break;
    }
    const [originalThunk, timestamp, forwarderChain, nameRva, firstThunk] = fields;
    const mappedDescriptor = mappedBytes(bytes, headers, rva, 20, options);
    descriptors.push({
      index,
      rva,
      originalThunk,
      timestamp,
      forwarderChain,
      nameRva,
      name: readStringRva(nameRva),
      firstThunk,
      mappedBytes: mappedDescriptor
        ? {
            fileBackedBytes: mappedDescriptor.rawBytes,
            zeroFillBytes: mappedDescriptor.zeroFillBytes,
          }
        : null,
    });
  }
  const mappedDirectory = mappedBytes(
    bytes,
    headers,
    importDirectory.rva,
    importDirectory.size,
    options,
  );
  return {
    mapping: options.alignRawPointerDown
      ? 'legacy hypothesis: section raw pointer rounded down to FileAlignment per upstream source comments'
      : 'literal PE section PointerToRawData mapping',
    directory: importDirectory,
    declaredEndRva: importDirectory.rva + importDirectory.size,
    mappedSpan: mappedDirectory
      ? { fileBackedBytes: mappedDirectory.rawBytes, zeroFillBytes: mappedDirectory.zeroFillBytes }
      : null,
    endBeyondImage,
    descriptors,
  };
}

const targets = manifest.targets.filter((target) => target.id.startsWith('pts-tinype-'));
const reports = [];
for (const target of targets) {
  const bytes = new Uint8Array(await readFile(path.join(root, target.path)));
  const headers = parseHeaders(bytes);
  let currentParser = { status: 'accepted' };
  try {
    parsePE(bytes);
  } catch (error) {
    currentParser = { status: 'rejected', error: error.message };
  }
  reports.push({
    id: target.id,
    path: target.path,
    byteLength: bytes.length,
    expectedSha256: target.sha256,
    actualSha256: sha256(bytes),
    hashMatchesManifest: sha256(bytes) === target.sha256,
    headers,
    importLayout: decodeImports(bytes, headers),
    ...(target.id === 'pts-tinype-hh2-x86'
      ? {
          upstreamDescribedLegacyImportLayout: decodeImports(bytes, headers, {
            alignRawPointerDown: true,
            allowOversizedDirectory: true,
          }),
        }
      : {}),
    currentParser,
  });
}

const evidence = {
  title: 'pts-tinype PE layout and native-loader probe',
  inspectedAt: new Date().toISOString(),
  upstream: {
    repository: 'https://github.com/pts/pts-tinype',
    commit: '00bb8824c93188b236599c174af4269abf281664',
    sourceFiles: [
      'https://github.com/pts/pts-tinype/blob/00bb8824c93188b236599c174af4269abf281664/hh2.nasm',
      'https://github.com/pts/pts-tinype/blob/00bb8824c93188b236599c174af4269abf281664/hh4t.nasm',
      'https://github.com/pts/pts-tinype/blob/00bb8824c93188b236599c174af4269abf281664/README.txt',
    ],
    license:
      'The upstream repository has no license file; binaries remain in ignored .cache/targets/.',
  },
  nativeWineProbe: {
    command: '/opt/homebrew/bin/wine .cache/targets/pts-hh2.exe',
    version: 'Wine 11.0',
    prefix: '.cache/native-wine',
    prefixWasAbsentBeforeRun: true,
    timeoutMs: 30000,
    elapsedMs: 27900,
    exitCode: 0,
    timedOut: false,
    stdout: 'Hello, World!\r\n',
    stderrSummary:
      'MoltenVK emitted a verbose Vulkan device and extension banner while Wine initialized the fresh prefix. WINEDEBUG=-all was set. The program result is the exit code and stdout above; the verbose backend banner is omitted from this evidence record.',
    hh4tLaunched: false,
  },
  specReferences: [
    {
      url: 'https://learn.microsoft.com/en-us/windows/win32/debug/pe-format',
      claims: [
        'Section PointerToRawData is a file pointer; executable-image section data must satisfy FileAlignment.',
        'When SizeOfRawData is less than VirtualSize, the remaining section bytes are zero-filled in the loaded image.',
        'Data-directory VirtualAddress fields are RVAs; directory count and optional-header size bound directory-table reads.',
      ],
    },
  ],
  recommendation: {
    standardsCompatible:
      'Support bounded reads from zero-filled section tails as mapped image bytes. Keep reads inside the declared section virtual extent and image size; map available raw bytes first and synthesize zeroes only for the specified virtual tail.',
    hh4t: 'Its 40-byte import directory is entirely within the section virtual span: the descriptor is file-backed and the null descriptor occupies the PE-defined zero-filled tail. The current parser accepts this standards-compatible layout; retain it as a regression case for bounded virtual-tail reads.',
    hh2: 'Wine executes it, but its source deliberately uses a nonstandard 0-based layout: raw pointer 2 aliases the headers and violates FileAlignment 0x200; its import-directory size extends beyond both the section virtual end and SizeOfImage. Do not relax general PE validation solely to accept this executable. If supporting it is an explicit compatibility goal, gate compatibility to a bounded loader-emulation profile that parses only descriptors up to an in-image null terminator; keep standards-mode strict and add no filename/hash fingerprint.',
  },
  targets: reports,
};

const outPath = path.join(root, 'evidence/tiny-pe-inspection.json');
await writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(root, outPath), targets: reports }, null, 2));
