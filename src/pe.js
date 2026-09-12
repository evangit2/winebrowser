const MAX_GUEST_MEMORY = 64 * 1024 * 1024;
const MAX_IMAGE_END = 0x03000000;
const MIN_IMAGE_BASE = 0x10000;
const PE32_MAGIC = 0x10b;
const IMAGE_FILE_DLL = 0x2000;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;

function fail(message) {
  throw new Error(`Invalid or unsupported PE: ${message}`);
}

function viewOf(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('input must be a Uint8Array');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function need(bytes, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    fail(`${label} is out of bounds`);
  }
}

function u16(v, bytes, offset, label) {
  need(bytes, offset, 2, label);
  return v.getUint16(offset, true);
}

function u32(v, bytes, offset, label) {
  need(bytes, offset, 4, label);
  return v.getUint32(offset, true);
}

function cString(bytes, offset, limit, label, maxLength = 4096) {
  need(bytes, offset, 1, label);
  const endLimit = Math.min(bytes.length, limit, offset + maxLength + 1);
  let end = offset;
  while (end < endLimit && bytes[end] !== 0) end++;
  if (end === endLimit) fail(`${label} is not terminated`);
  let value = '';
  for (let i = offset; i < end; i++) {
    if (bytes[i] > 0x7f) fail(`${label} is not ASCII`);
    value += String.fromCharCode(bytes[i]);
  }
  return value;
}

export function parsePE(bytes) {
  const v = viewOf(bytes);
  if (bytes.length < 64 || u16(v, bytes, 0, 'DOS signature') !== 0x5a4d)
    fail('missing DOS signature');
  const peOffset = u32(v, bytes, 0x3c, 'PE header offset');
  need(bytes, peOffset, 24, 'PE/COFF header');
  if (u32(v, bytes, peOffset, 'PE signature') !== 0x00004550) fail('missing PE signature');
  const coff = peOffset + 4;
  const machine = u16(v, bytes, coff, 'machine');
  if (machine !== 0x14c) fail('only x86 (I386) images are supported');
  const sectionCount = u16(v, bytes, coff + 2, 'section count');
  if (sectionCount < 1 || sectionCount > 96) fail('invalid section count');
  const optionalSize = u16(v, bytes, coff + 16, 'optional header size');
  const characteristics = u16(v, bytes, coff + 18, 'COFF characteristics');
  if (characteristics & IMAGE_FILE_DLL) fail('DLL images are unsupported');
  const optional = coff + 20;
  need(bytes, optional, optionalSize, 'optional header');
  if (optionalSize < 96 || u16(v, bytes, optional, 'optional header magic') !== PE32_MAGIC)
    fail('only PE32 images are supported');

  const entryRva = u32(v, bytes, optional + 16, 'entry point RVA');
  const imageBase = u32(v, bytes, optional + 28, 'image base');
  const sectionAlignment = u32(v, bytes, optional + 32, 'section alignment');
  const fileAlignment = u32(v, bytes, optional + 36, 'file alignment');
  const imageSize = u32(v, bytes, optional + 56, 'image size');
  const headersSize = u32(v, bytes, optional + 60, 'headers size');
  const subsystem = u16(v, bytes, optional + 68, 'subsystem');
  const directoryCount =
    optionalSize >= 96 ? u32(v, bytes, optional + 92, 'data directory count') : 0;
  const directories = [];
  const availableDirectories = Math.min(directoryCount, Math.floor((optionalSize - 96) / 8));
  for (let i = 0; i < availableDirectories; i++) {
    directories.push({
      rva: u32(v, bytes, optional + 96 + i * 8, `directory ${i} RVA`),
      size: u32(v, bytes, optional + 100 + i * 8, `directory ${i} size`),
    });
  }
  // A declared directory that does not fit the optional header is malformed.
  if (directoryCount > availableDirectories) fail('data directory table exceeds optional header');
  if (directories[9]?.rva || directories[9]?.size) fail('TLS callbacks are unsupported');
  if (directories[13]?.rva || directories[13]?.size) fail('delay imports are unsupported');
  if (!imageBase || imageBase % 0x1000 !== 0 || imageBase < MIN_IMAGE_BASE)
    fail('image base is outside the supported mapping range');
  if (!imageSize || imageSize > MAX_GUEST_MEMORY || imageBase + imageSize >= MAX_IMAGE_END)
    fail('image does not fit the supported guest address range');
  if (!headersSize || headersSize > imageSize || headersSize > bytes.length)
    fail('invalid headers size');
  if (!sectionAlignment || !fileAlignment) fail('invalid section or file alignment');

  const sectionTable = optional + optionalSize;
  need(bytes, sectionTable, sectionCount * 40, 'section table');
  if (sectionTable + sectionCount * 40 > headersSize)
    fail('section table is not included in image headers');
  const sections = [];
  const rawRanges = [];
  const virtualRanges = [];
  for (let i = 0; i < sectionCount; i++) {
    const p = sectionTable + i * 40;
    const nameBytes = bytes.subarray(p, p + 8);
    let nameEnd = nameBytes.indexOf(0);
    if (nameEnd < 0) nameEnd = 8;
    const name = String.fromCharCode(...nameBytes.subarray(0, nameEnd));
    const virtualSize = u32(v, bytes, p + 8, 'section virtual size');
    const rva = u32(v, bytes, p + 12, 'section RVA');
    const rawSize = u32(v, bytes, p + 16, 'section raw size');
    const rawOffset = u32(v, bytes, p + 20, 'section raw offset');
    const sectionCharacteristics = u32(v, bytes, p + 36, 'section characteristics');
    const mappedSize = Math.max(virtualSize, rawSize);
    if (!mappedSize || rva < headersSize || rva + mappedSize > imageSize)
      fail(`section ${name || i} is outside the image`);
    if (rawSize) {
      if (rawOffset < headersSize || rawOffset + rawSize > bytes.length)
        fail(`section ${name || i} raw data is out of bounds`);
      rawRanges.push([rawOffset, rawOffset + rawSize, name]);
    }
    virtualRanges.push([rva, rva + mappedSize, name]);
    sections.push({
      name,
      rva,
      virtualSize,
      rawSize,
      rawOffset,
      characteristics: sectionCharacteristics,
    });
  }
  function rejectOverlaps(ranges, kind) {
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i][0] < ranges[i - 1][1]) fail(`overlapping ${kind} sections`);
  }
  rejectOverlaps(rawRanges, 'raw');
  rejectOverlaps(virtualRanges, 'virtual');
  if (
    !entryRva ||
    entryRva >= imageSize ||
    !sections.some(
      (s) =>
        s.characteristics & IMAGE_SCN_MEM_EXECUTE &&
        entryRva >= s.rva &&
        entryRva < s.rva + Math.max(s.virtualSize, s.rawSize),
    )
  )
    fail('entry point is not in an executable section');

  function rvaToOffset(rva, size, label) {
    if (rva < headersSize && rva + size <= headersSize) {
      need(bytes, rva, size, label);
      return rva;
    }
    const section = sections.find((s) => rva >= s.rva && rva + size <= s.rva + s.rawSize);
    if (!section) fail(`${label} is not backed by file data`);
    const offset = section.rawOffset + (rva - section.rva);
    need(bytes, offset, size, label);
    return offset;
  }
  function readAsciiRva(rva, label) {
    const off = rvaToOffset(rva, 1, label);
    const section = sections.find((s) => rva >= s.rva && rva < s.rva + s.rawSize);
    const limit = section ? section.rawOffset + section.rawSize : headersSize;
    return cString(bytes, off, limit, label, 260);
  }
  function readImportName(hintNameRva) {
    const hintNameOff = rvaToOffset(hintNameRva, 3, 'import hint/name');
    const section = sections.find((s) => hintNameRva >= s.rva && hintNameRva < s.rva + s.rawSize);
    const limit = section ? section.rawOffset + section.rawSize : headersSize;
    return cString(bytes, hintNameOff + 2, limit, 'import name', 4096);
  }
  const imports = [];
  const importDir = directories[1];
  if (importDir?.rva || importDir?.size) {
    if (!importDir.rva || importDir.size < 20) fail('invalid import directory');
    const dirOff = rvaToOffset(importDir.rva, importDir.size, 'import directory');
    const descLimit = Math.min(Math.floor(importDir.size / 20), 4096);
    let terminated = false;
    let importCount = 0;
    for (let d = 0; d < descLimit; d++) {
      const p = dirOff + d * 20;
      const originalThunk = u32(v, bytes, p, 'import lookup table RVA');
      const time = u32(v, bytes, p + 4, 'import timestamp');
      const chain = u32(v, bytes, p + 8, 'import forwarder chain');
      const nameRva = u32(v, bytes, p + 12, 'import DLL name RVA');
      const iatRva = u32(v, bytes, p + 16, 'import address table RVA');
      if (!originalThunk && !time && !chain && !nameRva && !iatRva) {
        terminated = true;
        break;
      }
      if (!nameRva || !iatRva) fail('malformed import descriptor');
      const dll = readAsciiRva(nameRva, 'import DLL name');
      const lookupRva = originalThunk || iatRva;
      let thunkCount = 0;
      while (true) {
        if (thunkCount++ > 65536 || importCount > 65536)
          fail('import table exceeds supported limits');
        const thunkOff = rvaToOffset(lookupRva + (thunkCount - 1) * 4, 4, 'import thunk');
        const value = u32(v, bytes, thunkOff, 'import thunk value');
        if (!value) break;
        const slotRva = iatRva + (thunkCount - 1) * 4;
        rvaToOffset(slotRva, 4, 'import address table slot');
        importCount++;
        if (value & 0x80000000) imports.push({ dll, ordinal: value & 0xffff, iatRva: slotRva });
        else {
          imports.push({ dll, name: readImportName(value), iatRva: slotRva });
        }
      }
    }
    if (!terminated) fail('import descriptor table has no terminator');
  }
  return {
    machine,
    imageBase,
    imageSize,
    entryPoint: imageBase + entryRva,
    entryPointRva: entryRva,
    sections,
    imports,
    subsystem,
    headersSize,
    characteristics,
    directories,
  };
}

export function mapPE(pe, bytes, memory) {
  viewOf(bytes);
  if (!pe || pe.machine !== 0x14c || !Array.isArray(pe.sections)) fail('invalid parsed image');
  if (!(memory instanceof WebAssembly.Memory))
    throw new TypeError('memory must be a WebAssembly.Memory');
  const target = new Uint8Array(memory.buffer);
  const end = pe.imageBase + pe.imageSize;
  if (
    target.byteLength > MAX_GUEST_MEMORY ||
    pe.imageBase < MIN_IMAGE_BASE ||
    end > MAX_IMAGE_END ||
    end > target.byteLength
  )
    fail('image does not fit guest memory');
  const fresh = parsePE(bytes);
  if (
    fresh.imageBase !== pe.imageBase ||
    fresh.imageSize !== pe.imageSize ||
    fresh.sections.length !== pe.sections.length
  )
    fail('parsed image does not match supplied bytes');
  target.fill(0, pe.imageBase, end);
  target.set(bytes.subarray(0, fresh.headersSize), pe.imageBase);
  for (const section of fresh.sections) {
    if (section.rawSize)
      target.set(
        bytes.subarray(section.rawOffset, section.rawOffset + section.rawSize),
        pe.imageBase + section.rva,
      );
  }
  return pe;
}
