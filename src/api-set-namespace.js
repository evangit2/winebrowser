import { WINE_API_SET_SCHEMA } from './wine-api-set-schema.js';
import { PROCESS_LAYOUT } from './process-layout.js';

export const PEB_API_SET_MAP = PROCESS_LAYOUT.peb + 0x38;
const HASH_FACTOR = 31;

// Version 6 layouts from Wine include/winternl.h; all offsets are relative to
// the namespace start. Wine's unchanged NTDLL can search the same schema as
// the JS module loader, including contracts without an assigned destination.
export function createApiSetNamespace() {
  const entries = Object.entries(WINE_API_SET_SCHEMA);
  const entryOffset = 28;
  const hashOffset = entryOffset + entries.length * 24;
  const valueOffset = hashOffset + entries.length * 8;
  const values = entries.filter(([, target]) => target).length;
  const stringOffset = valueOffset + values * 20;
  const strings = new Map();
  let size = stringOffset;
  const string = (text) => {
    if (!strings.has(text)) {
      strings.set(text, size);
      size += text.length * 2;
    }
    return strings.get(text);
  };
  for (const [name, target] of entries) {
    string(name);
    if (target) string(target);
  }
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  const write = (offset, ...words) =>
    words.forEach((word, i) => view.setUint32(offset + i * 4, word, true));
  write(0, 6, size, 0, entries.length, entryOffset, hashOffset, HASH_FACTOR);
  const hashes = [];
  let nextValue = valueOffset;
  entries.forEach(([name, target], index) => {
    const prefix = name.slice(0, name.lastIndexOf('-'));
    let hash = 0;
    for (const letter of prefix) hash = (Math.imul(hash, HASH_FACTOR) + letter.charCodeAt(0)) >>> 0;
    hashes.push({ hash, index });
    write(
      entryOffset + index * 24,
      0,
      string(name),
      name.length * 2,
      prefix.length * 2,
      nextValue,
      target ? 1 : 0,
    );
    if (target) {
      write(nextValue, 0, 0, 0, string(target), target.length * 2);
      nextValue += 20;
    }
  });
  hashes.sort((a, b) => a.hash - b.hash);
  hashes.forEach(({ hash, index }, position) => write(hashOffset + position * 8, hash, index));
  for (const [text, offset] of strings)
    for (let i = 0; i < text.length; i++) view.setUint16(offset + i * 2, text.charCodeAt(i), true);
  return bytes;
}

const namespace = createApiSetNamespace();
export function initializeApiSetNamespace(runtime) {
  const address = runtime.allocate(namespace.length);
  runtime.data.set(namespace, address);
  runtime.write32(PEB_API_SET_MAP, address);
  return address;
}
