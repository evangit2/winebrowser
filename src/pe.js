const MAX_GUEST_MEMORY = 64 * 1024 * 1024;
const MAX_IMAGE_END = 0x03000000;
const MIN_IMAGE_BASE = 0x10000;
const MAX_IMAGE_SIZE = MAX_IMAGE_END - MIN_IMAGE_BASE;
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

export function parsePE(bytes, options = {}) {
  const allowDll = options?.allowDll === true;
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
  const isDll = Boolean(characteristics & IMAGE_FILE_DLL);
  if (isDll && !allowDll) fail('DLL images are unsupported');
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
  if (
    !imageSize ||
    imageSize > MAX_IMAGE_SIZE ||
    imageBase + imageSize > 0x100000000 ||
    (!isDll && imageBase + imageSize >= MAX_IMAGE_END)
  )
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
    entryRva &&
    (entryRva >= imageSize ||
      !sections.some(
        (s) =>
          s.characteristics & IMAGE_SCN_MEM_EXECUTE &&
          entryRva >= s.rva &&
          entryRva < s.rva + Math.max(s.virtualSize, s.rawSize),
      ))
  )
    fail('entry point is not in an executable section');
  if (!entryRva && !isDll) fail('entry point is not in an executable section');

  // Build the same bounded RVA view that mapPE will later construct. Copy only
  // after section file and virtual ranges have been checked; unbacked virtual
  // bytes stay zero-filled as they are in a mapped PE image.
  const imageBytes = new Uint8Array(imageSize);
  imageBytes.set(bytes.subarray(0, headersSize), 0);
  for (const section of sections) {
    if (section.rawSize)
      imageBytes.set(
        bytes.subarray(section.rawOffset, section.rawOffset + section.rawSize),
        section.rva,
      );
  }
  const imageView = new DataView(imageBytes.buffer);

  function rvaToOffset(rva, size, label) {
    if (
      !Number.isSafeInteger(rva) ||
      !Number.isSafeInteger(size) ||
      rva < 0 ||
      size < 0 ||
      rva + size > imageSize
    )
      fail(`${label} is outside the image`);
    if (rva < headersSize && rva + size <= headersSize) return rva;
    const section = sections.find(
      (s) => rva >= s.rva && rva + size <= s.rva + Math.max(s.virtualSize, s.rawSize),
    );
    if (!section) fail(`${label} is outside mapped image sections`);
    return rva;
  }
  function rvaLimit(rva, label) {
    if (rva < headersSize) return headersSize;
    const section = sections.find(
      (s) => rva >= s.rva && rva < s.rva + Math.max(s.virtualSize, s.rawSize),
    );
    if (!section) fail(`${label} is outside mapped image sections`);
    return sEnd(section);
  }
  function sEnd(section) {
    return section.rva + Math.max(section.virtualSize, section.rawSize);
  }
  function readAsciiRva(rva, label) {
    const off = rvaToOffset(rva, 1, label);
    return cString(imageBytes, off, rvaLimit(rva, label), label, 260);
  }
  function readAsciiRvaBefore(rva, endRva, label) {
    if (!Number.isSafeInteger(endRva) || rva >= endRva) fail(`${label} is outside its directory`);
    const off = rvaToOffset(rva, 1, label);
    return cString(imageBytes, off, Math.min(rvaLimit(rva, label), endRva), label, 260);
  }
  function readImportName(hintNameRva) {
    const hintNameOff = rvaToOffset(hintNameRva, 3, 'import hint/name');
    return cString(
      imageBytes,
      hintNameOff + 2,
      rvaLimit(hintNameRva, 'import hint/name'),
      'import name',
      4096,
    );
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
      const originalThunk = u32(imageView, imageBytes, p, 'import lookup table RVA');
      const time = u32(imageView, imageBytes, p + 4, 'import timestamp');
      const chain = u32(imageView, imageBytes, p + 8, 'import forwarder chain');
      const nameRva = u32(imageView, imageBytes, p + 12, 'import DLL name RVA');
      const iatRva = u32(imageView, imageBytes, p + 16, 'import address table RVA');
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
        const value = u32(imageView, imageBytes, thunkOff, 'import thunk value');
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
  const exports = [];
  const exportDir = directories[0];
  if (Boolean(exportDir?.rva) !== Boolean(exportDir?.size)) fail('invalid export directory');
  if (exportDir?.rva) {
    if (exportDir.size < 40) fail('invalid export directory');
    const p = rvaToOffset(exportDir.rva, 40, 'export directory');
    const exportEnd = exportDir.rva + exportDir.size;
    if (exportEnd > imageSize) fail('export directory exceeds image');
    const ordinalBase = u32(imageView, imageBytes, p + 16, 'export ordinal base');
    const functionCount = u32(imageView, imageBytes, p + 20, 'export function count');
    const nameCount = u32(imageView, imageBytes, p + 24, 'export name count');
    const functionsRva = u32(imageView, imageBytes, p + 28, 'export address table RVA');
    const namesRva = u32(imageView, imageBytes, p + 32, 'export name table RVA');
    const ordinalsRva = u32(imageView, imageBytes, p + 36, 'export ordinal table RVA');
    if (functionCount > 65536 || nameCount > 65536) fail('export table exceeds supported limits');
    if ((functionCount && !functionsRva) || (nameCount && (!namesRva || !ordinalsRva)))
      fail('malformed export address tables');
    const functionOffsets = functionCount
      ? rvaToOffset(functionsRva, functionCount * 4, 'export address table')
      : 0;
    const nameOffsets = nameCount ? rvaToOffset(namesRva, nameCount * 4, 'export name table') : 0;
    const ordinalOffsets = nameCount
      ? rvaToOffset(ordinalsRva, nameCount * 2, 'export ordinal table')
      : 0;
    const aliases = Array.from({ length: functionCount }, () => []);
    for (let i = 0; i < nameCount; i++) {
      const nameRva = u32(imageView, imageBytes, nameOffsets + i * 4, 'export name RVA');
      const functionIndex = u16(
        imageView,
        imageBytes,
        ordinalOffsets + i * 2,
        'export name ordinal',
      );
      if (functionIndex >= functionCount) fail('export name ordinal is out of range');
      aliases[functionIndex].push(readAsciiRva(nameRva, 'export name'));
    }
    for (let i = 0; i < functionCount; i++) {
      const rva = u32(imageView, imageBytes, functionOffsets + i * 4, 'export function RVA');
      if (!rva) continue;
      if (rva >= imageSize) fail('export function RVA is outside image');
      const forwarder =
        rva >= exportDir.rva && rva < exportEnd
          ? readAsciiRvaBefore(rva, exportEnd, 'export forwarder')
          : undefined;
      const ordinal = ordinalBase + i;
      if (!Number.isSafeInteger(ordinal) || ordinal > 0xffffffff)
        fail('export ordinal is out of range');
      if (aliases[i].length) {
        for (const name of aliases[i]) {
          exports.push({ name, ordinal, rva, ...(forwarder === undefined ? {} : { forwarder }) });
        }
      } else {
        exports.push({ ordinal, rva, ...(forwarder === undefined ? {} : { forwarder }) });
      }
    }
  }
  const relocations = [];
  const relocDir = directories[5];
  if (Boolean(relocDir?.rva) !== Boolean(relocDir?.size)) fail('invalid base relocation directory');
  if (relocDir?.rva) {
    const relocOff = rvaToOffset(relocDir.rva, relocDir.size, 'base relocation directory');
    let consumed = 0;
    while (consumed < relocDir.size) {
      if (relocDir.size - consumed < 8) fail('truncated base relocation block');
      const blockOff = relocOff + consumed;
      const pageRva = u32(imageView, imageBytes, blockOff, 'base relocation page RVA');
      const blockSize = u32(imageView, imageBytes, blockOff + 4, 'base relocation block size');
      if (
        pageRva % 0x1000 ||
        pageRva >= imageSize ||
        blockSize < 8 ||
        blockSize % 2 ||
        blockSize > relocDir.size - consumed
      )
        fail('malformed base relocation block');
      const entries = (blockSize - 8) / 2;
      for (let i = 0; i < entries; i++) {
        const item = u16(imageView, imageBytes, blockOff + 8 + i * 2, 'base relocation entry');
        const type = item >>> 12;
        const rva = pageRva + (item & 0x0fff);
        if (type === 0) {
          relocations.push({ type, rva });
          continue;
        }
        if (type !== 3) fail(`unsupported base relocation type ${type}`);
        if (rva + 4 > imageSize) fail('base relocation target is outside image');
        relocations.push({ type, rva });
      }
      consumed += blockSize;
    }
  }
  return {
    machine,
    imageBase,
    imageSize,
    entryPoint: entryRva ? imageBase + entryRva : 0,
    entryPointRva: entryRva,
    isDll,
    sections,
    imports,
    exports,
    relocations,
    subsystem,
    headersSize,
    characteristics,
    directories,
  };
}

export function mapPE(pe, bytes, memory, base = pe?.imageBase) {
  viewOf(bytes);
  if (!pe || pe.machine !== 0x14c || !Array.isArray(pe.sections)) fail('invalid parsed image');
  if (!(memory instanceof WebAssembly.Memory))
    throw new TypeError('memory must be a WebAssembly.Memory');
  const target = new Uint8Array(memory.buffer);
  if (!Number.isSafeInteger(base) || base % 0x1000 || base < MIN_IMAGE_BASE)
    fail('mapping base is outside the supported range');
  const end = base + pe.imageSize;
  if (target.byteLength > MAX_GUEST_MEMORY || end >= MAX_IMAGE_END || end > target.byteLength)
    fail('image does not fit guest memory');
  const fresh = parsePE(bytes, { allowDll: pe.isDll === true });
  if (
    fresh.imageBase !== pe.imageBase ||
    fresh.imageSize !== pe.imageSize ||
    fresh.sections.length !== pe.sections.length ||
    fresh.isDll !== (pe.isDll === true)
  )
    fail('parsed image does not match supplied bytes');
  const delta = base - fresh.imageBase;
  if (delta && !fresh.directories[5]?.rva) fail('image has no base relocation directory');
  target.fill(0, base, end);
  target.set(bytes.subarray(0, fresh.headersSize), base);
  for (const section of fresh.sections) {
    if (section.rawSize)
      target.set(
        bytes.subarray(section.rawOffset, section.rawOffset + section.rawSize),
        base + section.rva,
      );
  }
  if (delta) {
    for (const relocation of fresh.relocations) {
      if (relocation.type === 0) continue;
      const address = base + relocation.rva;
      const value = new DataView(memory.buffer).getUint32(address, true);
      new DataView(memory.buffer).setUint32(address, (value + delta) >>> 0, true);
    }
  }
  // Return fresh metadata describing this particular mapping; parsed metadata is
  // left untouched and can still describe the preferred image base.
  return {
    ...fresh,
    preferredImageBase: fresh.imageBase,
    imageBase: base,
    entryPoint: fresh.entryPointRva ? base + fresh.entryPointRva : 0,
  };
}
