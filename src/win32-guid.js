import { readGuid } from './com.js';
import { classRegistryKey, registryString } from './com-registry.js';

const E_INVALIDARG = 0x80070057;
const CO_E_CLASSSTRING = 0x800401f3;
const CO_E_IIDSTRING = 0x800401f4;
const response = (result, argc) => ({ result, argc });

// Match the native field-by-field parser, including partially written fields
// on malformed input. A regular-expression-only parser loses that behavior.
function parseGuid(text, bytes) {
  if (text === null || text[0] !== '{') {
    bytes.fill(0);
    return text === null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const nibble = (at) => {
    const c = text.charCodeAt(at);
    return c >= 48 && c <= 57
      ? c - 48
      : c >= 65 && c <= 70
        ? c - 55
        : c >= 97 && c <= 102
          ? c - 87
          : -1;
  };
  for (const [start, end, offset, width] of [
    [1, 9, 0, 4],
    [10, 14, 4, 2],
    [15, 19, 6, 2],
  ]) {
    let value = 0;
    for (let i = start; i < end; i++) {
      const digit = nibble(i);
      if (digit < 0) {
        width === 4 ? view.setUint32(offset, value, true) : view.setUint16(offset, value, true);
        return false;
      }
      value = value * 16 + digit;
    }
    width === 4 ? view.setUint32(offset, value, true) : view.setUint16(offset, value, true);
    if (text[end] !== '-') return false;
  }
  for (let i = 0; i < 8; i++) {
    if (i === 2 && text[24] !== '-') return false;
    const at = 20 + i * 2 + (i >= 2 ? 1 : 0),
      hi = nibble(at),
      lo = nibble(at + 1);
    if (hi < 0 || lo < 0) return false;
    bytes[8 + i] = hi * 16 + lo;
  }
  return text[37] === '}' && text.length === 38;
}

function fromString(r, a, iid) {
  const out = a(1) >>> 0;
  if (!out) return response(E_INVALIDARG, 2);
  const text = a(0) ? r.wideString(a(0)) : null;
  // IID conversion never consults the registry, and length/initial-brace errors
  // leave the caller's output untouched.
  if (iid && text !== null) {
    if (text.length !== 38) return response(E_INVALIDARG, 2);
    if (text[0] !== '{') return response(CO_E_IIDSTRING, 2);
  }
  r.check(out, 16, true);
  const bytes = r.data.subarray(out, out + 16);
  if (parseGuid(text, bytes)) return response(0, 2);
  if (iid) return response(CO_E_IIDSTRING, 2);

  const path = text.split('\\').filter(Boolean);
  const registered = registryString(classRegistryKey(r, [...path, 'CLSID']), '', 78);
  if (registered !== null) {
    const temporary = new Uint8Array(16);
    if (parseGuid(registered, temporary)) {
      bytes.set(temporary);
      return response(0, 2);
    }
  }
  return response(CO_E_CLASSSTRING, 2);
}

export const guidApis = {
  'ole32.dll!CLSIDFromString': (r, a) => fromString(r, a, false),
  'ole32.dll!IIDFromString': (r, a) => fromString(r, a, true),
  'ole32.dll!StringFromGUID2': (r, a) => {
    if (!a(0) || (a(2) | 0) < 39) return response(0, 3);
    const text = `{${readGuid(r, a(0)).toUpperCase()}}`;
    const out = a(1) >>> 0;
    r.check(out, 78, true);
    const view = new DataView(r.memory.buffer);
    for (let i = 0; i < 39; i++) view.setUint16(out + i * 2, text.charCodeAt(i) || 0, true);
    return response(39, 3);
  },
};
