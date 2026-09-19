import { parsePE } from './pe.js';

const MAX_ENTRIES = 4096;
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

function reader(bytes) {
  const pe = parsePE(bytes, { allowDll: true });
  const directory = pe.directories[2];
  if (!directory?.rva || !directory.size) return null;
  const end = directory.rva + directory.size;
  if (end > 0x100000000 || directory.size > MAX_RESOURCE_BYTES)
    throw Error('Malformed PE resource directory');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsetOf = (rva, size, resourceDirectory = false) => {
    if (!Number.isInteger(rva) || !Number.isInteger(size) || size < 0)
      throw Error('Malformed PE resource range');
    if (resourceDirectory && (rva < directory.rva || rva + size > end))
      throw Error('Malformed PE resource directory');
    if (rva < pe.headersSize && rva + size <= pe.headersSize) return rva;
    const section = pe.sections.find(
      (item) => rva >= item.rva && rva + size <= item.rva + item.rawSize,
    );
    if (!section) throw Error('PE resource data is not file-backed');
    return section.rawOffset + rva - section.rva;
  };
  const resourceRva = (relative, size) => {
    const rva = directory.rva + relative;
    if (rva > 0xffffffff) throw Error('Malformed PE resource offset');
    offsetOf(rva, size, true);
    return rva;
  };
  const nameAt = (relative) => {
    const rva = resourceRva(relative, 2);
    const offset = offsetOf(rva, 2, true);
    const length = view.getUint16(offset, true);
    const stringRva = resourceRva(relative + 2, length * 2);
    const stringOffset = offsetOf(stringRva, length * 2, true);
    let value = '';
    for (let i = 0; i < length; i++)
      value += String.fromCharCode(view.getUint16(stringOffset + i * 2, true));
    return value;
  };
  const entries = (rva) => {
    const offset = offsetOf(rva, 16, true);
    const count = view.getUint16(offset + 12, true) + view.getUint16(offset + 14, true);
    if (count > MAX_ENTRIES) throw Error('PE resource entry limit exceeded');
    offsetOf(rva, 16 + count * 8, true);
    const result = [];
    for (let i = 0; i < count; i++) {
      const p = offset + 16 + i * 8;
      const rawName = view.getUint32(p, true);
      const target = view.getUint32(p + 4, true);
      result.push({
        name: rawName & 0x80000000 ? nameAt(rawName & 0x7fffffff) : rawName & 0xffff,
        directory: !!(target & 0x80000000),
        relative: target & 0x7fffffff,
      });
    }
    return result;
  };
  const data = (entry) => {
    if (entry.directory) throw Error('Malformed PE resource leaf');
    const dataRva = resourceRva(entry.relative, 16);
    const offset = offsetOf(dataRva, 16, true);
    const payloadRva = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size > MAX_RESOURCE_BYTES) throw Error('PE resource exceeds size limit');
    const payloadOffset = offsetOf(payloadRva, size);
    return bytes.slice(payloadOffset, payloadOffset + size);
  };
  return { directory, entries, data };
}

function sameName(actual, requested) {
  if (typeof actual === 'string' && typeof requested === 'string')
    return actual.toLowerCase() === requested.toLowerCase();
  return actual === requested;
}

export function listPEResources(bytes, type) {
  const resources = reader(bytes);
  if (!resources) return [];
  const typeEntry = resources
    .entries(resources.directory.rva)
    .find((entry) => sameName(entry.name, type));
  if (!typeEntry || !typeEntry.directory) return [];
  const typeRva = resources.directory.rva + typeEntry.relative;
  return resources
    .entries(typeRva)
    .filter((entry) => entry.directory)
    .map((entry) => entry.name);
}

export function readPEResource(bytes, type, name) {
  const resources = reader(bytes);
  if (!resources) return null;
  const typeEntry = resources
    .entries(resources.directory.rva)
    .find((entry) => sameName(entry.name, type));
  if (!typeEntry || !typeEntry.directory) return null;
  const nameEntry = resources
    .entries(resources.directory.rva + typeEntry.relative)
    .find((entry) => sameName(entry.name, name));
  if (!nameEntry || !nameEntry.directory) return null;
  const languages = resources.entries(resources.directory.rva + nameEntry.relative);
  if (!languages.length) return null;
  // Neutral and US English are preferred; otherwise PE table order is stable.
  const language =
    languages.find((entry) => entry.name === 0) ??
    languages.find((entry) => entry.name === 0x409) ??
    languages[0];
  return resources.data(language);
}
