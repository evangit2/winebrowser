// The wider msvcrt surface: character classification, numeric conversion, the
// byte/wide/multibyte string families, the environment, and the CRT's path and
// file-statistic calls. Everything here runs over guest memory; the one piece
// of data that is not literal, the character-classification table, is generated
// from Wine's own dlls/msvcrt/ctype.c (see scripts/build-msvcrt-ctype.py), so
// isalpha and friends answer from the table the real msvcrt.dll exports.
import { packageDosPath, resolveGuestPath } from './guest-paths.js';
import { fileMetadata } from './file-metadata.js';
import { encodeAnsi } from './encoding.js';
import { CTYPE_TABLE, WCTYPE_TABLE } from './msvcrt-ctype.js';

export const CTYPE_UPPER = 0x0001,
  CTYPE_LOWER = 0x0002,
  CTYPE_DIGIT = 0x0004,
  CTYPE_SPACE = 0x0008,
  CTYPE_PUNCT = 0x0010,
  CTYPE_CONTROL = 0x0020,
  CTYPE_BLANK = 0x0040,
  CTYPE_HEX = 0x0080,
  CTYPE_LEADBYTE = 0x8000,
  CTYPE_ALPHA = 0x0100 | CTYPE_UPPER | CTYPE_LOWER;
const ALNUM = CTYPE_ALPHA | CTYPE_DIGIT,
  GRAPH = CTYPE_ALPHA | CTYPE_DIGIT | CTYPE_PUNCT,
  PRINT = GRAPH | CTYPE_BLANK,
  WEOF = 0xffff;

const EINVAL = 22,
  ERANGE = 34,
  EACCES = 13,
  ENOENT = 2;
const S_IREAD = 0x0100,
  S_IWRITE = 0x0080,
  S_IEXEC = 0x0040,
  S_IFDIR = 0x4000,
  S_IFREG = 0x8000,
  ALL_IREAD = S_IREAD | (S_IREAD >> 3) | (S_IREAD >> 6),
  ALL_IWRITE = S_IWRITE | (S_IWRITE >> 3) | (S_IWRITE >> 6),
  ALL_IEXEC = S_IEXEC | (S_IEXEC >> 3) | (S_IEXEC >> 6);
const MAX_PATH = 260;
const STRUNCATE = 80;
// Win32 file attributes the stat/_finddata writers compare against.
const FILE_ATTRIBUTE_READONLY = 0x01,
  FILE_ATTRIBUTE_HIDDEN = 0x02,
  FILE_ATTRIBUTE_DIRECTORY = 0x10,
  FILE_ATTRIBUTE_NORMAL = 0x80;

const ok = (result = 0, argc = 0) => ({ result, argc });

// ---------------------------------------------------------------------------
// Per-process guest cells. They share r.msvcrtData with the msvcrt module so a
// symbol keeps one address for the process lifetime.
function cell(r, name, build) {
  r.msvcrtData ??= new Map();
  if (!r.msvcrtData.has(name)) r.msvcrtData.set(name, build(r));
  return r.msvcrtData.get(name);
}
function writeWordArray(r, address, table) {
  for (let i = 0; i < table.length; i++) r.guestMemory.write(address + i * 2, table[i], 2);
}
function ctypeTable(r) {
  return cell(r, '_ctype', (rt) => {
    const address = rt.allocate(CTYPE_TABLE.length * 2);
    writeWordArray(rt, address, CTYPE_TABLE);
    return address;
  });
}
function wctypeTable(r) {
  return cell(r, '_wctype', (rt) => {
    const address = rt.allocate(WCTYPE_TABLE.length * 2);
    writeWordArray(rt, address, WCTYPE_TABLE);
    return address;
  });
}
// A single-byte code page has no lead bytes and no multibyte table, so
// _mbctype is 257 zero bytes.
function mbctypeTable(r) {
  return cell(r, '_mbctype', (rt) => rt.allocate(257));
}
function pctypeCell(r) {
  return cell(r, '_pctype', (rt) => {
    const pointer = rt.allocate(4);
    rt.write32(pointer, ctypeTable(rt) + 2);
    return pointer;
  });
}
// The pointer cells the __p_* accessors return: _pctype/_pwctype are the
// addresses of the pointer *variables*, _mbctype is the byte table itself.
// msvcrt.js delegates its accessors here so there is one table per process.
export function crtCtypeCell(r, name) {
  if (name === '_pctype') return pctypeCell(r);
  if (name === '_pwctype') return pwctypeCell(r);
  if (name === '_mbctype') return mbctypeTable(r);
  if (name === '_ctype') return ctypeTable(r);
  if (name === '_wctype') return wctypeTable(r);
  return 0;
}
function pwctypeCell(r) {
  return cell(r, '_pwctype', (rt) => {
    const pointer = rt.allocate(4);
    rt.write32(pointer, wctypeTable(rt) + 2);
    return pointer;
  });
}
// The errno cell is shared with msvcrt.js's _errno/_get_errno accessors.
function errnoAddress(r, key = 'errno') {
  r.msvcrtErrno ??= new Map();
  if (!r.msvcrtErrno.has(key)) r.msvcrtErrno.set(key, r.allocate(4));
  return r.msvcrtErrno.get(key);
}
function setErrno(r, value) {
  r.write32(errnoAddress(r), value | 0);
}
// ---------------------------------------------------------------------------
// Character classification. Each predicate indexes the exported table with the
// same mask Wine's ctype.c passes to _isctype.
function ctypeMask(r, index) {
  if (index < 0 || index > 255) return 0;
  return r.guestMemory.read(ctypeTable(r) + 2 + index * 2, 2);
}
function isctype(r, c, mask) {
  return ctypeMask(r, c & 0xffff) & mask ? 1 : 0;
}
const CTYPE_PREDICATES = {
  isalnum: ALNUM,
  isalpha: CTYPE_ALPHA,
  iscntrl: CTYPE_CONTROL,
  isdigit: CTYPE_DIGIT,
  isgraph: GRAPH,
  islower: CTYPE_LOWER,
  isprint: PRINT,
  ispunct: CTYPE_PUNCT,
  isspace: CTYPE_SPACE,
  isupper: CTYPE_UPPER,
  isxdigit: CTYPE_HEX,
};
// isblank is '\t' or a blank per the table (space in the C locale).
function isBlank(r, c) {
  if ((c & 0xffff) === 0x09) return 1;
  return isctype(r, c, CTYPE_BLANK);
}
function wctypeMask(r, code) {
  if (code > 0xffff) return 0;
  return r.guestMemory.read(wctypeTable(r) + 2 + code * 2, 2);
}
function iswctype(r, c, mask) {
  const code = c & 0xffff;
  if (code === WEOF) return 0;
  return wctypeMask(r, code) & mask ? 1 : 0;
}
const WCTYPE_PREDICATES = {
  iswalnum: ALNUM,
  iswalpha: CTYPE_ALPHA,
  iswcntrl: CTYPE_CONTROL,
  iswdigit: CTYPE_DIGIT,
  iswgraph: GRAPH,
  iswlower: CTYPE_LOWER,
  iswprint: PRINT,
  iswpunct: CTYPE_PUNCT,
  iswspace: CTYPE_SPACE,
  iswupper: CTYPE_UPPER,
  iswxdigit: CTYPE_HEX,
};
const WCTYPE_PROPERTIES = {
  alnum: ALNUM,
  alpha: CTYPE_ALPHA,
  blank: CTYPE_BLANK,
  cntrl: CTYPE_CONTROL,
  digit: CTYPE_DIGIT,
  graph: GRAPH,
  lower: CTYPE_LOWER,
  print: PRINT,
  punct: CTYPE_PUNCT,
  space: CTYPE_SPACE,
  upper: CTYPE_UPPER,
  xdigit: CTYPE_HEX,
};
function tolowerByte(c) {
  const byte = c & 0xffff;
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : c;
}
function toupperByte(c) {
  const byte = c & 0xffff;
  return byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : c;
}
function tolowerWide(c) {
  const code = c & 0xffff;
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}
function toupperWide(c) {
  const code = c & 0xffff;
  return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
}
// ---------------------------------------------------------------------------
// Numeric conversion. Strings are read byte by byte; the sign, base prefix and
// digit set follow the C rules, and a value outside the target range clamps and
// reports ERANGE instead of wrapping.
function ansiLengthOf(r, pointer) {
  let length = 0;
  while (length < 0x1000000) {
    if (!r.guestMemory.read(pointer + length, 1)) break;
    length++;
  }
  return length;
}
function ansiText(r, pointer) {
  const length = ansiLengthOf(r, pointer);
  return new TextDecoder('windows-1252').decode(r.data.subarray(pointer, pointer + length));
}
// Parse an integer honouring an optional sign and a 0x/0 prefix for base 0/16.
// Returns null when no digits were consumed.
function parseInteger(text, base, max, min) {
  let index = 0;
  while (index < text.length && /\s/.test(text[index])) index++;
  let negative = false;
  if (text[index] === '+' || text[index] === '-') {
    negative = text[index] === '-';
    index++;
  }
  // Base 0 means "decide from the prefix": 0x/0X is hexadecimal, a leading 0
  // is octal, anything else decimal. A nonzero base accepts only the matching
  // 0x prefix (base 16).
  let radix = base;
  if (base === 0) {
    if (text[index] === '0' && /[xX]/.test(text[index + 1] || '')) {
      radix = 16;
      index += 2;
    } else if (text[index] === '0') {
      radix = 8;
    } else {
      radix = 10;
    }
  } else if (radix === 16 && text[index] === '0' && /[xX]/.test(text[index + 1] || '')) {
    index += 2;
  }
  if (radix < 2 || radix > 36) return null;
  let value = 0n,
    digits = 0;
  for (; index < text.length; index++) {
    const code = text.charCodeAt(index);
    let digit = -1;
    if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
    else if (code >= 0x41 && code <= 0x5a) digit = code - 0x41 + 10;
    else if (code >= 0x61 && code <= 0x7a) digit = code - 0x61 + 10;
    if (digit < 0 || digit >= radix) break;
    value = value * BigInt(radix) + BigInt(digit);
    digits++;
  }
  if (!digits) return null;
  if (negative) value = -value;
  if (value > max) return { value: max, range: true, consumed: index };
  if (value < min) return { value: min, range: true, consumed: index };
  return { value, range: false, consumed: index };
}
// Every strtol-family entry point takes (str, endptr, base) and, when endptr is
// not NULL, writes the first unconsumed character's address through it.
function integerParse(r, pointer, endptr, base, bits, signed, argc) {
  const text = ansiText(r, pointer);
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const parsed = parseInteger(text, base | 0, max, min);
  if (endptr) {
    r.check(endptr, 4, true);
    r.write32(endptr, pointer + (parsed ? parsed.consumed : 0));
  }
  if (parsed?.range) setErrno(r, ERANGE);
  return { value: parsed ? parsed.value : 0n, argc };
}
// ---------------------------------------------------------------------------
// Floating-point parsing. Only the decimal grammar is accepted (the CRT also
// takes hex floats and inf/nan spellings through its own scan); a leading sign,
// digits, one decimal point and a signed exponent are consumed, and the longest
// valid prefix decides the result.
function parseFloatPrefix(text) {
  const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text);
  return match ? { value: Number.parseFloat(match[0]), length: match[0].length } : null;
}
function doubleResult(r, value, argc) {
  r.cpu.x87.pushDouble(value);
  return ok(0, argc);
}
// strtod returns the double in ST(0); strtof narrows it to binary32 first.
function strtodImpl(r, a, float) {
  const parsed = parseFloatPrefix(ansiText(r, a(0)));
  if (a(1)) r.write32(a(1), a(0) + (parsed ? parsed.length : 0));
  const value = parsed ? parsed.value : 0;
  return doubleResult(r, float ? Math.fround(value) : value, 2);
}
function atofImpl(r, a) {
  const parsed = parseFloatPrefix(ansiText(r, a(0)));
  return doubleResult(r, parsed ? parsed.value : 0, 1);
}

// ---------------------------------------------------------------------------
// Integer formatting. _itoa-family writes digits in the requested radix and
// returns the buffer; the _s forms validate the size and report errno_t.
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const DIGITS_UPPER = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function formatInteger(value, radix, upper) {
  if (radix < 2 || radix > 36) return null;
  const digits = upper ? DIGITS_UPPER : DIGITS,
    base = BigInt(radix);
  let negative = false,
    magnitude = value;
  if (value < 0n) {
    negative = true;
    magnitude = -value;
  }
  let text = '';
  do {
    text = digits[Number(magnitude % base)] + text;
    magnitude /= base;
  } while (magnitude);
  return (negative ? '-' : '') + text;
}
function writeAnsiBytes(r, pointer, text) {
  for (let i = 0; i < text.length; i++) r.data[pointer + i] = text.charCodeAt(i) & 0xff;
  r.data[pointer + text.length] = 0;
}
function writeWideChars(r, pointer, text) {
  for (let i = 0; i < text.length; i++) r.guestMemory.write(pointer + i * 2, text.charCodeAt(i), 2);
  r.guestMemory.write(pointer + text.length * 2, 0, 2);
}
// ---------------------------------------------------------------------------
// The byte-string family beyond what msvcrt.js already implements.
function ansiCopyN(r, a) {
  const count = a(2) >>> 0;
  r.check(a(0), count + 1, true);
  let i = 0;
  for (; i < count; i++) {
    const byte = r.data[a(1) + i];
    r.data[a(0) + i] = byte;
    if (!byte) {
      for (i++; i < count; i++) r.data[a(0) + i] = 0;
      return ok(a(0), 3);
    }
  }
  r.data[a(0) + count] = 0;
  return ok(a(0), 3);
}
function ansiCatN(r, a) {
  const count = a(2) >>> 0;
  const left = ansiLengthOf(r, a(0));
  r.check(a(0), left + count + 1, true);
  for (let i = 0; i < count; i++) {
    const byte = r.data[a(1) + i];
    r.data[a(0) + left + i] = byte;
    if (!byte) return ok(a(0), 3);
  }
  r.data[a(0) + left + count] = 0;
  return ok(a(0), 3);
}
function ansiNLen(r, a) {
  const count = a(1) >>> 0;
  let length = 0;
  while (length < count && r.data[a(0) + length]) length++;
  return ok(length, 2);
}
function ansiBrk(r, a) {
  const set = [];
  for (let i = 0; r.data[a(1) + i]; i++) set.push(r.data[a(1) + i]);
  for (let i = 0; ; i++) {
    const byte = r.data[a(0) + i];
    if (!byte) return ok(0, 2);
    if (set.includes(byte)) return ok(a(0) + i, 2);
  }
}
function ansiColl(r, a) {
  // The C locale collates by unsigned byte value, so strcoll is strcmp and
  // strxfrm copies when the buffer can hold the string (or reports its size).
  return strcmpImpl(r, a);
}
function strcmpImpl(r, a) {
  for (let i = 0; ; i++) {
    const left = r.data[a(0) + i],
      right = r.data[a(1) + i];
    if (left !== right) return ok(left < right ? -1 : 1, 2);
    if (!left) return ok(0, 2);
  }
}
function strxfrmImpl(r, a) {
  const length = ansiLengthOf(r, a(0));
  if (a(1)) {
    r.check(a(1), length + 1, true);
    r.data.copyWithin(a(1), a(0), a(0) + length + 1);
  }
  return ok(length, 3);
}
function strncpyS(r, a) {
  const destination = a(0),
    size = a(1) >>> 0,
    source = a(2);
  if (!destination || size === 0) return ok(EINVAL, 3);
  r.check(destination, size, true);
  const length = ansiLengthOf(r, source);
  if (length + 1 > size) {
    r.data[destination] = 0;
    return ok(ERANGE, 3);
  }
  r.data.copyWithin(destination, source, source + length + 1);
  return ok(0, 3);
}
function strncatS(r, a) {
  const destination = a(0),
    size = a(1) >>> 0,
    source = a(2),
    count = a(3) >>> 0;
  if (!destination || size === 0) return ok(EINVAL, 4);
  r.check(destination, size, true);
  const left = ansiLengthOf(r, destination);
  if (left >= size) return ok(EINVAL, 4);
  let added = 0;
  while (added < count && r.data[source + added]) added++;
  if (left + added + 1 > size) {
    r.data[destination] = 0;
    return ok(ERANGE, 4);
  }
  if (added) r.data.copyWithin(destination + left, source, source + added);
  r.data[destination + left + added] = 0;
  return ok(0, 4);
}
function strerrorImpl(r, a) {
  const message = `Error ${a(0) | 0}`;
  const buffer = cell(r, '_strerror_buffer', (rt) => rt.allocate(96));
  writeAnsiBytes(r, buffer, message);
  return ok(buffer, 1);
}
// ---------------------------------------------------------------------------
// The wide-string family beyond what msvcrt.js already implements.
function wideLengthOf(r, pointer) {
  let length = 0;
  while (length < 0x1000000) {
    if (!r.guestMemory.read(pointer + length * 2, 2)) break;
    length++;
  }
  return length;
}
// _wcsnicmp / _wcsicmp fold case with the CRT's own wide case mapping, which in
// the invariant locale is the ASCII fold used here.
function wideCompare(r, a, count) {
  for (let i = 0; i < count; i++) {
    const left = tolowerWide(r.guestMemory.read(a(0) + i * 2, 2)),
      right = tolowerWide(r.guestMemory.read(a(1) + i * 2, 2));
    if (left !== right) return ok(left < right ? -1 : 1, 3);
    if (!left) break;
  }
  return ok(0, 3);
}
function wideCatN(r, a) {
  const count = a(2) >>> 0;
  const left = wideLengthOf(r, a(0));
  r.check(a(0), (left + count + 1) * 2, true);
  for (let i = 0; i < count; i++) {
    const code = r.guestMemory.read(a(1) + i * 2, 2);
    r.guestMemory.write(a(0) + (left + i) * 2, code, 2);
    if (!code) return ok(a(0), 3);
  }
  r.guestMemory.write(a(0) + (left + count) * 2, 0, 2);
  return ok(a(0), 3);
}
function wideSpan(r, a) {
  const set = [];
  for (let i = 0; ; i++) {
    const code = r.guestMemory.read(a(1) + i * 2, 2);
    if (!code) break;
    set.push(code);
  }
  for (let i = 0; ; i++) {
    const code = r.guestMemory.read(a(0) + i * 2, 2);
    if (!code) return ok(i, 2);
    if (!set.includes(code)) return ok(i, 2);
  }
}
function wideSpanNot(r, a) {
  const set = [];
  for (let i = 0; ; i++) {
    const code = r.guestMemory.read(a(1) + i * 2, 2);
    if (!code) break;
    set.push(code);
  }
  for (let i = 0; ; i++) {
    const code = r.guestMemory.read(a(0) + i * 2, 2);
    if (!code) return ok(i, 2);
    if (set.includes(code)) return ok(i, 2);
  }
}
function wideBrk(r, a) {
  const set = [];
  for (let i = 0; ; i++) {
    const code = r.guestMemory.read(a(1) + i * 2, 2);
    if (!code) break;
    set.push(code);
  }
  for (let i = 0; ; i++) {
    const code = r.guestMemory.read(a(0) + i * 2, 2);
    if (!code) return ok(0, 2);
    if (set.includes(code)) return ok(a(0) + i * 2, 2);
  }
}
// _wcstok advances a caller-held context pointer; like strtok_s the separator
// set is plain, which means an empty selection is a no-op.
function wcstokImpl(r, a) {
  const context = a(2);
  if (!context) return ok(0, 3);
  let cursor = a(0) >>> 0;
  if (!cursor) cursor = r.read32(context) >>> 0;
  if (!cursor) return ok(0, 3);
  const isDelimiter = (code) => {
    for (let i = 0; ; i++) {
      const entry = r.guestMemory.read(a(1) + i * 2, 2);
      if (!entry) return false;
      if (entry === code) return true;
    }
  };
  while (r.guestMemory.read(cursor, 2) && isDelimiter(r.guestMemory.read(cursor, 2))) cursor += 2;
  if (!r.guestMemory.read(cursor, 2)) {
    r.write32(context, 0);
    return ok(0, 3);
  }
  const start = cursor;
  while (r.guestMemory.read(cursor, 2) && !isDelimiter(r.guestMemory.read(cursor, 2))) cursor += 2;
  if (r.guestMemory.read(cursor, 2)) {
    r.guestMemory.write(cursor, 0, 2);
    r.write32(context, cursor + 2);
  } else r.write32(context, 0);
  return ok(start, 3);
}
function wcsSet(r, a, count, fillValue) {
  let i = 0;
  for (; i < count; i++) {
    const code = r.guestMemory.read(a(0) + i * 2, 2);
    if (!code) break;
    r.guestMemory.write(a(0) + i * 2, fillValue, 2);
  }
  return ok(a(0), 3);
}
function wcsCase(r, a, upper) {
  let i = 0;
  for (; ; i++) {
    const code = r.guestMemory.read(a(0) + i * 2, 2);
    if (!code) break;
    r.guestMemory.write(a(0) + i * 2, upper ? toupperWide(code) : tolowerWide(code), 2);
  }
  return ok(a(0), 1);
}
function wcsRev(r, a) {
  const length = wideLengthOf(r, a(0));
  for (let i = 0, j = length - 1; i < j; i++, j--) {
    const left = r.guestMemory.read(a(0) + i * 2, 2),
      right = r.guestMemory.read(a(0) + j * 2, 2);
    r.guestMemory.write(a(0) + i * 2, right, 2);
    r.guestMemory.write(a(0) + j * 2, left, 2);
  }
  return ok(a(0), 1);
}
function wcsDup(r, a) {
  const length = wideLengthOf(r, a(0));
  const copy = r.allocate((length + 1) * 2);
  for (let i = 0; i <= length; i++)
    r.guestMemory.write(copy + i * 2, r.guestMemory.read(a(0) + i * 2, 2), 2);
  return ok(copy, 1);
}
// ---------------------------------------------------------------------------
// The multibyte (mbcs) family. The runtime models one single-byte code page, so
// every mb* call reduces to its byte equivalent: _mbslen is strlen, _mbscpy is
// strcpy, _mbschr is strchr, and the classification predicates index _ctype.
// A lead byte never occurs, so _ismbblead/_ismbbtrail are always false.
function mbsCopyS(r, a) {
  const destination = a(0),
    size = a(1) >>> 0,
    source = a(2);
  if (!destination || size === 0) return ok(EINVAL, 3);
  r.check(destination, size, true);
  const length = ansiLengthOf(r, source);
  if (length + 1 > size) {
    r.data[destination] = 0;
    return ok(ERANGE, 3);
  }
  r.data.copyWithin(destination, source, source + length + 1);
  return ok(0, 3);
}
function mbsNLen(r, a) {
  const count = a(1) >>> 0;
  let length = 0;
  while (length < count && r.data[a(0) + length]) length++;
  return ok(length, 2);
}
function mbsSet(r, a, count, fillValue) {
  let i = 0;
  for (; i < count; i++) {
    if (!r.data[a(0) + i]) break;
    r.data[a(0) + i] = fillValue;
  }
  return ok(a(0), 3);
}
function mbsCase(r, a, upper) {
  for (let i = 0; r.data[a(0) + i]; i++) {
    const c = r.data[a(0) + i];
    if (upper) r.data[a(0) + i] = c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
    else r.data[a(0) + i] = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
  }
  return ok(a(0), 1);
}
function mbsRev(r, a) {
  const length = ansiLengthOf(r, a(0));
  for (let i = 0, j = length - 1; i < j; i++, j--) {
    const tmp = r.data[a(0) + i];
    r.data[a(0) + i] = r.data[a(0) + j];
    r.data[a(0) + j] = tmp;
  }
  return ok(a(0), 1);
}
function mbsInc(r, a) {
  return ok(a(0) + 1, 1);
}
function mbsDec(r, a, argc) {
  if (a(0) <= a(1)) return ok(a(1), argc);
  return ok(a(0) - 1, argc);
}
function mbsNextC(r, a) {
  return ok(r.data[a(0)], 1);
}
// ---------------------------------------------------------------------------
// The environment. The runtime's Win32 environment is the single source: the
// ANSI and wide vectors are built from the same entries, and _environ/_wenviron
// keep one stable address as a char**/wchar_t**.
function environmentEntries(r) {
  return ['=C:=C:\\', 'PATH=C:\\'];
}
function environmentVector(r, wide) {
  return cell(r, wide ? '_environ_w' : '_environ', (rt) => {
    const strings = environmentEntries(rt).map((entry) => rt.allocString(entry, wide));
    const table = rt.allocate((strings.length + 1) * 4);
    strings.forEach((address, index) => rt.write32(table + index * 4, address));
    return table;
  });
}
// _get_environ/_get_wenviron write the vector pointer through the caller's
// char***; the exported _environ/_wenviron cells hold the same address.
function getEnviron(r, a, wide) {
  const vector = environmentVector(r, wide);
  if (!a(0)) return ok(EINVAL, 1);
  r.check(a(0), 4, true);
  r.write32(a(0), vector);
  return ok(0, 1);
}
function environCell(r, wide) {
  return cell(r, wide ? '_wenviron' : '_environ_cell', (rt) => {
    const pointer = rt.allocate(4);
    rt.write32(pointer, environmentVector(rt, wide));
    return pointer;
  });
}

// ---------------------------------------------------------------------------
// Current directory and absolute paths. r.cwd is the package-relative working
// directory; the DOS form the CRT reports is C:\winebrowser\<cwd>.
function currentDirectory(r, wide) {
  return packageDosPath(r.cwd, true);
}
function getcwdImpl(r, a, wide) {
  const buffer = a(0);
  let size = a(1) | 0;
  const directory = currentDirectory(r, wide);
  const length = wide ? directory.length : encodeAnsi(directory).bytes.length;
  if (!buffer) {
    if (size < length + 1) size = length + 1;
    const allocated = r.allocate(size * (wide ? 2 : 1));
    return writeCounted(r, allocated, size, directory, wide);
  }
  if (length + 1 > size) {
    setErrno(r, ERANGE);
    return ok(0, 2);
  }
  return writeCounted(r, buffer, size, directory, wide);
}
function writeCounted(r, buffer, capacity, text, wide) {
  r.check(buffer, capacity * (wide ? 2 : 1), true);
  if (wide) writeWideChars(r, buffer, text);
  else writeAnsiBytes(r, buffer, text);
  return ok(buffer, 2);
}
// _getdcwd is _getcwd for the current drive; any other drive is EACCES because
// the isolated volume only has C:.
function getdcwdImpl(r, a, wide) {
  const drive = a(0) | 0;
  if (drive > 1) {
    setErrno(r, EACCES);
    return ok(0, 3);
  }
  return getcwdImpl(r, { 0: () => a(1), 1: () => a(2) }, wide);
}
function chdirImpl(r, a, wide) {
  let resolved;
  try {
    resolved = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd, {
      allowRoot: true,
    });
  } catch {
    setErrno(r, ENOENT);
    return ok(0xffffffff, 1);
  }
  const prefix = resolved ? resolved + '/' : '';
  const exists =
    !resolved ||
    [...(r.files?.keys() ?? [])].some((name) => name.startsWith(prefix)) ||
    r.virtualDirectories?.has(prefix);
  if (!exists) {
    setErrno(r, ENOENT);
    return ok(0xffffffff, 1);
  }
  r.cwd = prefix;
  return ok(0, 1);
}
function getdriveImpl(r) {
  return ok(3, 0);
}
function fullpathImpl(r, a, wide) {
  const destination = a(0);
  const relative = wide ? r.wideString(a(1)) : r.string(a(1));
  let size = a(2) >>> 0;
  if (!relative) return getcwdImpl(r, { 0: () => destination, 1: () => size }, wide);
  let resolved;
  try {
    resolved = resolveGuestPath(relative, r.cwd, { allowRoot: true });
  } catch {
    setErrno(r, ENOENT);
    return ok(0, 3);
  }
  const text = packageDosPath(resolved);
  const length = wide ? text.length : encodeAnsi(text).bytes.length;
  if (!destination) {
    if (size < length + 1) size = length + 1;
    const allocated = r.allocate(size * (wide ? 2 : 1));
    return writeCounted(r, allocated, size, text, wide);
  }
  if (size < 4) {
    setErrno(r, ERANGE);
    return ok(0, 3);
  }
  if (length + 1 > size) {
    setErrno(r, ERANGE);
    return ok(0, 3);
  }
  r.check(destination, size * (wide ? 2 : 1), true);
  if (wide) writeWideChars(r, destination, text);
  else writeAnsiBytes(r, destination, text);
  return ok(destination, 3);
}
// ---------------------------------------------------------------------------
// Path splitting and joining. _splitpath picks out the drive, directory (with
// its trailing separator), filename and extension; the _s form validates four
// destination/size pairs and reports ERANGE after clearing every destination.
const MAX_DRIVE = 3,
  MAX_DIR = 256,
  MAX_FNAME = 256,
  MAX_EXT = 256;
// One split, returned as the four pieces. The rules are the CRT's: a drive is
// `X:`, the directory runs through the last separator (kept), the filename is
// everything before the last dot and the extension includes that dot.
function splitPathParts(path) {
  let drive = '',
    directory = '',
    filename = '',
    extension = '';
  let rest = path;
  if (rest[0] && rest[1] === ':') {
    drive = rest.slice(0, 2);
    rest = rest.slice(2);
  }
  let end = -1;
  for (let i = 0; i < rest.length; i++) if (rest[i] === '/' || rest[i] === '\\') end = i + 1;
  if (end >= 0) {
    directory = rest.slice(0, end);
    rest = rest.slice(end);
  }
  let dot = -1;
  for (let i = 0; i < rest.length; i++) if (rest[i] === '.') dot = i;
  if (dot < 0) filename = rest;
  else {
    filename = rest.slice(0, dot);
    extension = rest.slice(dot);
  }
  return { drive, directory, filename, extension };
}
function splitpathImpl(r, a, wide) {
  const path = wide ? r.wideString(a(0)) : r.string(a(0));
  const parts = splitPathParts(path);
  const pairs = [
    [a(1), a(2), parts.drive, MAX_DRIVE],
    [a(3), a(4), parts.directory, MAX_DIR],
    [a(5), a(6), parts.filename, MAX_FNAME],
    [a(7), a(8), parts.extension, MAX_EXT],
  ];
  for (const [destination, size, text] of pairs) {
    if (!destination || !size) continue;
    const length = wide ? text.length : encodeAnsi(text).bytes.length;
    if (length + 1 > size) {
      for (const [other] of pairs) if (other) r.data[other] = 0;
      setErrno(r, ERANGE);
      return ok(ERANGE, 9);
    }
  }
  for (const [destination, size, text] of pairs) {
    if (!destination || !size) continue;
    if (wide) writeWideChars(r, destination, text);
    else writeAnsiBytes(r, destination, text);
  }
  return ok(0, 9);
}
// The non-_s form uses the fixed _MAX_* sizes and reports nothing.
function splitpathUnchecked(r, a, wide) {
  return splitpathImpl(
    r,
    (index) => [a(0), a(1), MAX_DRIVE, a(2), MAX_DIR, a(3), MAX_FNAME, a(4), MAX_EXT][index] ?? 0,
    wide,
  );
}
function makepathImpl(r, a, wide) {
  const pathPointer = a(0),
    size = a(1) | 0;
  if (!pathPointer || !size) {
    setErrno(r, EINVAL);
    return ok(EINVAL, 6);
  }
  const read = (index) => {
    const pointer = a(index);
    if (!pointer) return '';
    return wide ? r.wideString(pointer) : r.string(pointer);
  };
  const drive = read(2),
    directory = read(3),
    filename = read(4),
    extension = read(5);
  let text = '';
  if (drive) text += drive.slice(0, 2);
  if (directory) {
    text += directory;
    if (!/[\\/]$/.test(directory)) text += '\\';
  }
  text += filename;
  if (extension) {
    if (extension[0] !== '.') text += '.';
    text += extension;
  }
  const length = wide ? text.length : encodeAnsi(text).bytes.length;
  if (length + 1 > size) {
    setErrno(r, ERANGE);
    return ok(ERANGE, 6);
  }
  r.check(pathPointer, size * (wide ? 2 : 1), true);
  if (wide) writeWideChars(r, pathPointer, text);
  else writeAnsiBytes(r, pathPointer, text);
  return ok(0, 6);
}
function makepathUnchecked(r, a, wide) {
  return makepathImpl(r, (index) => [a(0), 0x7fffffff, a(1), a(2), a(3), a(4)][index] ?? 0, wide);
}
// ---------------------------------------------------------------------------
// File access and statistics. Every query resolves the guest path against the
// package volume and answers from the same metadata the Win32 file APIs use.
const R_OK = 4,
  W_OK = 2,
  F_OK = 0;
function fileTimeSeconds(value) {
  if (value === undefined || value === null) return 0;
  const ticks = BigInt(value) - 11644473600000000n;
  return Number(ticks / 10000000n) | 0;
}
// Resolve a guest path to the package-relative key, or null when it is outside
// the volume. `allowRoot` lets the volume root itself be a directory.
function resolveQuery(r, pointer, wide) {
  const name = wide ? r.wideString(pointer) : r.string(pointer);
  if (!name) return null;
  try {
    let text = name;
    if (text.startsWith('\\\\?\\')) text = '\\??\\' + text.slice(4);
    return resolveGuestPath(text, r.cwd, { allowRoot: true });
  } catch {
    return null;
  }
}
function accessImpl(r, a, wide) {
  const pointer = a(0);
  const mode = a(1) | 0;
  if (!pointer) {
    setErrno(r, ENOENT);
    return ok(-1, 2);
  }
  const path = resolveQuery(r, pointer, wide);
  if (path === null) {
    setErrno(r, ENOENT);
    return ok(-1, 2);
  }
  const info = fileMetadata(r, path);
  if (info.status) {
    setErrno(r, ENOENT);
    return ok(-1, 2);
  }
  if (info.attributes & FILE_ATTRIBUTE_READONLY && mode & W_OK) {
    setErrno(r, EACCES);
    return ok(-1, 2);
  }
  return ok(0, 2);
}
function accessS(r, a, wide) {
  const pointer = a(0);
  const mode = a(1) | 0;
  if (!pointer || mode & ~(R_OK | W_OK)) {
    setErrno(r, EINVAL);
    return ok(EINVAL, 2);
  }
  const result = accessImpl(r, (index) => (index === 0 ? pointer : mode), wide);
  return result.result === 0 ? ok(0, 2) : ok(r.read32(errnoAddress(r)) | 0, 2);
}
// The stat family shares one computation and only differs in how the result is
// written: which time fields are 32- or 64-bit and where st_size sits. The
// offsets below are the verified i386 (32-bit time_t) layouts from Wine's own
// headers, in sys/stat.h.
const STAT_LAYOUTS = {
  stat32: {
    size: 36,
    sizeOffset: 20,
    size64: false,
    atime: 24,
    mtime: 28,
    ctime: 32,
    times64: false,
  },
  stat32i64: {
    size: 48,
    sizeOffset: 24,
    size64: true,
    atime: 32,
    mtime: 36,
    ctime: 40,
    times64: false,
  },
  stat64i32: {
    size: 48,
    sizeOffset: 20,
    size64: false,
    atime: 24,
    mtime: 32,
    ctime: 40,
    times64: true,
  },
  stat64: {
    size: 56,
    sizeOffset: 24,
    size64: true,
    atime: 32,
    mtime: 40,
    ctime: 48,
    times64: true,
  },
};
// Build the common field set, then place it at the layout's offsets.
function statFields(r, path, info) {
  let mode = ALL_IREAD;
  if (info.directory) mode |= S_IFDIR | ALL_IEXEC;
  else {
    mode |= S_IFREG;
    if (/\.(exe|bat|cmd|com)$/i.test(path)) mode |= ALL_IEXEC;
  }
  if (!(info.attributes & FILE_ATTRIBUTE_READONLY)) mode |= ALL_IWRITE;
  return {
    dev: 2,
    mode,
    nlink: 1,
    size: info.size ?? 0,
    atime: fileTimeSeconds(info.access),
    mtime: fileTimeSeconds(info.write),
    ctime: fileTimeSeconds(info.write),
  };
}
function writeStat(r, pointer, fields, layout) {
  r.data.fill(0, pointer, pointer + layout.size);
  r.write32(pointer, fields.dev);
  r.guestMemory.write(pointer + 4, 0, 2); // st_ino
  r.guestMemory.write(pointer + 6, fields.mode, 2);
  r.guestMemory.write(pointer + 8, fields.nlink, 2);
  r.guestMemory.write(pointer + 10, 0, 2); // st_uid
  r.guestMemory.write(pointer + 12, 0, 2); // st_gid
  r.write32(pointer + 16, fields.dev); // st_rdev
  if (layout.size64) r.view.setBigInt64(pointer + layout.sizeOffset, BigInt(fields.size), true);
  else r.write32(pointer + layout.sizeOffset, fields.size >>> 0);
  const writeTime = (offset, value) => {
    if (layout.times64) r.view.setBigInt64(pointer + offset, BigInt(value), true);
    else r.write32(pointer + offset, value);
  };
  writeTime(layout.atime, fields.atime);
  writeTime(layout.mtime, fields.mtime);
  writeTime(layout.ctime, fields.ctime);
}
function statPath(r, a, wide, layout) {
  const pointer = a(1);
  if (!pointer) {
    setErrno(r, EINVAL);
    return ok(-1, 2);
  }
  const path = resolveQuery(r, a(0), wide);
  if (path === null) {
    setErrno(r, ENOENT);
    return ok(-1, 2);
  }
  const info = fileMetadata(r, path);
  if (info.status) {
    setErrno(r, ENOENT);
    return ok(-1, 2);
  }
  r.check(pointer, layout.size, true);
  writeStat(r, pointer, statFields(r, path, info), layout);
  return ok(0, 2);
}
// _fstat describes an open descriptor. Descriptors 0-2 are the console, which
// the CRT reports as character devices; anything else is the file behind the
// descriptor's Win32 handle, found through the CRT fd table.
function statDescriptor(r, a, layout) {
  const descriptor = a(0) | 0;
  const pointer = a(1);
  if (!pointer) {
    setErrno(r, EINVAL);
    return ok(-1, 2);
  }
  r.check(pointer, layout.size, true);
  if (descriptor >= 0 && descriptor <= 2) {
    r.data.fill(0, pointer, pointer + layout.size);
    r.write32(pointer, descriptor);
    r.write32(pointer + 16, descriptor);
    r.guestMemory.write(pointer + 6, S_IFCHR, 2);
    r.guestMemory.write(pointer + 8, 1, 2);
    return ok(0, 2);
  }
  const handle = r.crtFds?.get(descriptor);
  if (handle === undefined) {
    setErrno(r, 9);
    return ok(-1, 2);
  }
  const record = r.handles.get(handle);
  if (!record) {
    setErrno(r, 9);
    return ok(-1, 2);
  }
  const info = fileMetadata(r, record.path);
  if (info.status) {
    setErrno(r, 9);
    return ok(-1, 2);
  }
  writeStat(r, pointer, statFields(r, record.path, info), layout);
  return ok(0, 2);
}
// ---------------------------------------------------------------------------
// Directory search. _findfirst/_findnext are FindFirstFile/FindNextFile over
// the package volume; the result record is the CRT's own _finddata layout, not
// the Win32 WIN32_FIND_DATA. The four variants differ only in field widths.
const FIND_LAYOUTS = {
  find32: { size: 280, nameOffset: 20, sizeOffset: 16, size64: false, times64: false },
  find32i64: { size: 288, nameOffset: 24, sizeOffset: 16, size64: true, times64: false },
  find64i32: { size: 296, nameOffset: 36, sizeOffset: 32, size64: false, times64: true },
  find64: { size: 304, nameOffset: 40, sizeOffset: 32, size64: true, times64: true },
};
// The entries one wildcard selects, with per-entry metadata, reusing the same
// name/directory model FindFirstFile uses.
function searchEntries(r, pattern) {
  const slash = pattern.lastIndexOf('/');
  const prefix = slash < 0 ? '' : pattern.slice(0, slash + 1);
  const match = slash < 0 ? pattern : pattern.slice(slash + 1);
  const names = new Map();
  for (const name of r.files?.keys() ?? []) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!rest) continue;
    const cut = rest.indexOf('/');
    names.set(cut < 0 ? rest : rest.slice(0, cut), cut >= 0);
  }
  for (const directory of r.virtualDirectories ?? []) {
    if (!directory.startsWith(prefix) || directory.length <= prefix.length) continue;
    const rest = directory.slice(prefix.length).replace(/\/$/, '');
    if (rest && !rest.includes('/')) names.set(rest, true);
  }
  const wildcard = /[*?]/.test(match);
  const selected = wildcard
    ? [...names].filter(([name]) => dosWildcard(match, name))
    : names.has(match)
      ? [[match, names.get(match)]]
      : [];
  return {
    prefix,
    entries: selected.map(([name, isDirectory]) => {
      const info = isDirectory ? null : fileMetadata(r, prefix + name);
      return { name, isDirectory, info };
    }),
  };
}
// The DOS wildcard rule: `*` matches any run (including none), `?` one
// character, both case-insensitive and stopping at the end of the component.
function dosWildcard(pattern, name) {
  const source = pattern.toLowerCase(),
    target = name.toLowerCase();
  let p = 0,
    n = 0,
    star = -1,
    resume = 0;
  while (n < target.length) {
    if (p < source.length && (source[p] === '?' || source[p] === target[n])) {
      p++;
      n++;
    } else if (p < source.length && source[p] === '*') {
      star = p++;
      resume = n;
    } else if (star >= 0) {
      p = star + 1;
      n = ++resume;
    } else return false;
  }
  while (p < source.length && source[p] === '*') p++;
  return p === source.length;
}
// Write one _finddata record. Times are seconds since 1970; the wide variants
// write the name as UTF-16 rather than ANSI.
function writeFindData(r, pointer, entry, layout, wide) {
  r.data.fill(0, pointer, pointer + layout.size);
  const info = entry.info;
  const directory = entry.isDirectory;
  let attributes = directory ? FILE_ATTRIBUTE_DIRECTORY : 0x20;
  if (info?.attributes !== undefined && info.attributes !== FILE_ATTRIBUTE_NORMAL)
    attributes = directory ? FILE_ATTRIBUTE_DIRECTORY : info.attributes;
  r.write32(pointer, attributes);
  const writeTime = (offset, value) => {
    const seconds = fileTimeSeconds(value);
    if (layout.times64) r.view.setBigInt64(pointer + offset, BigInt(seconds), true);
    else r.write32(pointer + offset, seconds);
  };
  writeTime(4, info?.creation);
  writeTime(layout.times64 ? 12 : 8, info?.access);
  writeTime(layout.times64 ? 20 : 12, info?.write);
  const size = info?.size ?? 0;
  if (layout.size64) r.view.setBigInt64(pointer + layout.sizeOffset, BigInt(size), true);
  else r.write32(pointer + layout.sizeOffset, size >>> 0);
  const target = pointer + layout.nameOffset;
  if (wide) {
    for (let i = 0; i < entry.name.length && i < 259; i++)
      r.guestMemory.write(target + i * 2, entry.name.charCodeAt(i), 2);
  } else {
    for (let i = 0; i < entry.name.length && i < 259; i++)
      r.data[target + i] = entry.name.charCodeAt(i) & 0xff;
  }
}
function findfirstImpl(r, a, wide, layout) {
  const pointer = a(1);
  let pattern;
  try {
    pattern = resolveQuery(r, a(0), wide);
  } catch {
    pattern = null;
  }
  if (pattern === null) {
    setErrno(r, ENOENT);
    return ok(-1, 2);
  }
  const { prefix, entries } = searchEntries(r, pattern);
  if (!entries.length) {
    setErrno(r, ENOENT);
    return ok(-1, 2);
  }
  r.check(pointer, layout.size, true);
  writeFindData(r, pointer, entries[0], layout, wide);
  r.findHandles ??= new Map();
  const handle = (r.nextFindHandle = (r.nextFindHandle ?? 0x52000000) + 4);
  r.findHandles.set(handle, {
    crt: { prefix, entries, index: 1, wide, layout, pointer },
  });
  if (r.findHandles.size > 256) r.findHandles.delete(r.findHandles.keys().next().value);
  return ok(handle, 2);
}
function findnextImpl(r, a, wide, layout) {
  const state = r.findHandles?.get(a(0) >>> 0)?.crt;
  if (!state || state.index >= state.entries.length) {
    setErrno(r, ENOENT);
    return ok(-1, 2);
  }
  const entry = state.entries[state.index++];
  r.check(a(1), layout.size, true);
  writeFindData(r, a(1), entry, layout, wide);
  return ok(0, 2);
}
function findcloseImpl(r, a) {
  const state = r.findHandles?.get(a(0) >>> 0);
  if (!state) {
    setErrno(r, EINVAL);
    return ok(-1, 1);
  }
  r.findHandles.delete(a(0) >>> 0);
  return ok(0, 1);
}
// ---------------------------------------------------------------------------
// Miscellaneous numeric and process helpers.
// RAND_MAX is 0x7fff and the generator is MSVC's LCG: seed = seed*214013 +
// 2531011, result = (seed >> 16) & 0x7fff.
const RAND_MAX = 0x7fff;
function randImpl(r) {
  r.crtRandomSeed = (Math.imul(r.crtRandomSeed ?? 1, 214013) + 2531011) | 0;
  return ok((r.crtRandomSeed >> 16) & RAND_MAX, 0);
}
function srandImpl(r, a) {
  r.crtRandomSeed = a(0) | 0;
  return ok(0, 1);
}
function absImpl(r, a, bits) {
  const value =
    bits === 32 ? a(0) | 0 : Number(BigInt.asIntN(64, BigInt(a(0)) | (BigInt(a(1)) << 32n)));
  const magnitude = value < 0 ? -value : value;
  if (bits === 32) return ok(magnitude | 0, 1);
  const result = BigInt(magnitude);
  return {
    result: Number(BigInt.asUintN(32, result)),
    resultHigh: Number(BigInt.asIntN(32, result >> 32n)),
    argc: 2,
  };
}
// div/ldiv/lldiv return a div_t of {quot, rem}. On i386 Wine's spec declares
// them `-ret64`, so the two 32-bit members come back packed in EAX:EDX rather
// than through a caller pointer.
function divImpl(r, a, argc, bits, signed) {
  const low = (index) =>
    bits === 64 ? BigInt(a(index)) | (BigInt(a(index + 1)) << 32n) : a(index) | 0;
  const dividend = low(0),
    divisor = low(bits === 64 ? 2 : 1);
  if (!divisor) {
    setErrno(r, EINVAL);
    return ok(0, argc);
  }
  let quotient = dividend / divisor,
    remainder = dividend % divisor;
  if (!signed && bits === 64) quotient &= 0xffffffffffffffffn;
  const quotientLow = bits === 64 ? Number(BigInt.asUintN(32, quotient)) : quotient | 0;
  const remainderLow = bits === 64 ? Number(BigInt.asIntN(32, remainder)) : remainder | 0;
  return { result: quotientLow, resultHigh: remainderLow, argc };
}
// bsearch walks the sorted array with the guest comparator; the comparator
// order (key first for plain bsearch, context first for the _s form) decides
// which argument each call receives first.
async function bsearchImpl(r, a, withContext) {
  const key = a(0),
    base = a(1),
    count = a(2) >>> 0,
    size = a(3) >>> 0;
  const compare = a(4) >>> 0;
  const context = withContext ? a(5) : 0;
  if (!size || !compare) return ok(0, withContext ? 6 : 6);
  let min = 0,
    max = count - 1;
  while (min <= max) {
    const cursor = min + Math.floor((max - min) / 2);
    const element = base + cursor * size;
    const result = await r.callGuest(
      compare,
      withContext ? [context, key, element] : [key, element],
      'cdecl',
    );
    if (result === 0) return ok(element, 6);
    if (result < 0) max = cursor - 1;
    else min = cursor + 1;
  }
  return ok(0, 6);
}
// getenv reads the same environment the Win32 APIs report. A missing name is
// NULL, and the returned pointer stays valid for the process lifetime.
function getenvImpl(r, a, wide) {
  const name = (wide ? r.wideString(a(0)) : r.string(a(0))).toUpperCase();
  const entry = environmentEntries(r).find(
    (item) =>
      item.slice(0, item.indexOf('=') < 0 ? item.length : item.indexOf('=')).toUpperCase() === name,
  );
  if (!entry) return ok(0, 1);
  const value = entry.slice(entry.indexOf('=') + 1);
  return ok(
    cell(r, wide ? `_env_${name}_w` : `_env_${name}`, (rt) => rt.allocString(value, wide)),
    1,
  );
}
// system() has no shell here; like Wine with no /bin/sh it reports failure and
// sets ENOENT rather than pretending a command ran.
function systemImpl(r) {
  setErrno(r, ENOENT);
  return ok(-1, 1);
}
// abort() terminates the process with the CRT's abort code, running the same
// shutdown path as exit.
async function abortImpl(r) {
  r.exitCode = 3;
  await r.shutdownProcess();
  r.threads.terminateProcess(3);
  return ok(0, 0);
}

// ---------------------------------------------------------------------------
// A small set of the CRT math helpers real programs import. Each returns its
// double in ST(0) and its float in ST(0) narrowed to binary32.
function doubleArg(r, a, index) {
  const low = a(index) >>> 0,
    high = a(index + 1) >>> 0;
  return new DataView(new Uint32Array([low, high]).buffer).getFloat64(0, true);
}
function double4(r, value, argc) {
  r.cpu.x87.pushDouble(value);
  return ok(0, argc);
}
function float4(r, value, argc) {
  r.cpu.x87.pushDouble(Math.fround(value));
  return ok(0, argc);
}
// Read/write a binary32 through a guest address. frexpf and a few other float
// entry points pass their argument by pointer rather than in a register.
function readFloat32(r, address) {
  return new DataView(r.data.buffer, r.data.byteOffset + address, 4).getFloat32(0, true);
}
function floatArg(r, a, index) {
  return new DataView(new Uint32Array([a(index) >>> 0]).buffer).getFloat32(0, true);
}
// _logb returns the exponent as a double (unbiased when normal).
function logbImpl(r, a) {
  const value = Math.abs(doubleArg(r, a, 0));
  return double4(r, value && Number.isFinite(value) ? Math.floor(Math.log2(value)) : -Infinity, 2);
}
function nextafterImpl(r, a, float) {
  const from = float ? floatArg(r, a, 0) : doubleArg(r, a, 0);
  const to = float ? floatArg(r, a, 1) : doubleArg(r, a, 2);
  const result = nextRepresentable(from, to, float);
  return float ? float4(r, result, 3) : double4(r, result, 4);
}
// The IEEE-754 next representable value in the direction of `to`.
function nextRepresentable(from, to, float) {
  if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
  if (from === to) return to;
  if (from === 0)
    return to > 0
      ? float
        ? 1.401298464324817e-45
        : 5e-324
      : -(float ? 1.401298464324817e-45 : 5e-324);
  const buffer = new ArrayBuffer(float ? 4 : 8);
  const view = new DataView(buffer);
  if (float) view.setFloat32(0, from, true);
  else view.setFloat64(0, from, true);
  let bits = float ? view.getUint32(0, true) : view.getBigUint64(0, true);
  const up = to > from;
  if (float) {
    let value = bits >>> 0;
    value = up
      ? value < 0x80000000
        ? value + 1
        : value - 1
      : value < 0x80000000
        ? value - 1
        : value + 1;
    view.setUint32(0, value >>> 0, true);
    return view.getFloat32(0, true);
  }
  let value = bits;
  const signBit = 0x8000000000000000n;
  value = up
    ? value < signBit
      ? value + 1n
      : value - 1n
    : value < signBit
      ? value - 1n
      : value + 1n;
  view.setBigUint64(0, BigInt.asUintN(64, value), true);
  return view.getFloat64(0, true);
}
const FPCLASS = {
  snan: 0x0001,
  qnan: 0x0002,
  ninf: 0x0004,
  nn: 0x0008,
  nd: 0x0010,
  nz: 0x0020,
  pz: 0x0040,
  pd: 0x0080,
  pn: 0x0100,
  pinf: 0x0200,
};
function fpclassImpl(r, a) {
  const value = doubleArg(r, a, 0);
  let bits;
  if (Number.isNaN(value)) bits = FPCLASS.qnan;
  else if (value === -Infinity) bits = FPCLASS.ninf;
  else if (value === Infinity) bits = FPCLASS.pinf;
  else if (value === 0) bits = Object.is(value, -0) ? FPCLASS.nz : FPCLASS.pz;
  else if (value < 0) bits = value < -1 ? FPCLASS.nn : value > -1 ? FPCLASS.nd : FPCLASS.nn;
  else bits = value < 1 ? FPCLASS.pd : FPCLASS.pn;
  return ok(bits, 2);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bit rotation and byte swapping. _rotl/_lrotl rotate a 32-bit value left by a
// count masked to 31 bits, _rotr/_lrotr the other way; the long variants are
// the same 32-bit operation on this ABI.
function rotlImpl(r, a, left) {
  const value = a(0) >>> 0,
    count = (a(1) >>> 0) & 31;
  if (!count) return ok(value | 0, 2);
  const result = left
    ? ((value << count) | (value >>> (32 - count))) >>> 0
    : ((value >>> count) | (value << (32 - count))) >>> 0;
  return ok(result | 0, 2);
}
// _swab swaps each adjacent pair of bytes; an odd trailing byte is left alone.
function swabImpl(r, a) {
  const source = a(0) >>> 0,
    destination = a(1) >>> 0;
  let count = a(2) | 0;
  if (count <= 1) return ok(0, 3);
  r.check(source, count);
  r.check(destination, count, true);
  for (let i = 0; i + 1 < count; i += 2) {
    const left = r.data[source + i],
      right = r.data[source + i + 1];
    r.data[destination + i] = right;
    r.data[destination + i + 1] = left;
  }
  return ok(0, 3);
}
// _itoa_s and friends take the destination size and report errno_t, clearing the
// buffer on every failure instead of overrunning it. The radix must be 2..36.
function integerToString(
  r,
  a,
  { wide, bits, signed, bufferIndex, sizeIndex, valueIndex, radixIndex },
) {
  const buffer = a(bufferIndex) >>> 0,
    size = a(sizeIndex) >>> 0,
    radix = a(radixIndex) | 0;
  const clear = () => {
    if (buffer && size) {
      if (wide) r.guestMemory.write(buffer, 0, 2);
      else r.data[buffer] = 0;
    }
  };
  if (!buffer || !size || radix < 2 || radix > 36) {
    clear();
    setErrno(r, EINVAL);
    return ok(EINVAL, radixIndex + 1);
  }
  const raw =
    bits === 64
      ? BigInt(a(valueIndex)) | (BigInt(a(valueIndex + 1)) << 32n)
      : BigInt(a(valueIndex) | 0);
  const value = signed ? BigInt.asIntN(bits, raw) : BigInt.asUintN(bits, raw);
  const text = formatInteger(value, radix, false);
  if (text === null) {
    clear();
    return ok(EINVAL, radixIndex + 1);
  }
  if (text.length + 1 > size) {
    clear();
    setErrno(r, ERANGE);
    return ok(ERANGE, radixIndex + 1);
  }
  if (wide) writeWideChars(r, buffer, text);
  else writeAnsiBytes(r, buffer, text);
  return ok(0, radixIndex + 1);
}
// ---------------------------------------------------------------------------
// strtok and strtok_s. Both replace each separator with a NUL and keep the
// next start in a context cell; the non-_s form owns one per-process cell,
// exactly like the CRT's static pointer.
function strtokCore(r, string, delimiters, context, argc) {
  let cursor = string >>> 0;
  if (!cursor) {
    if (!context) return ok(0, argc);
    cursor = r.read32(context) >>> 0;
  }
  if (!cursor) return ok(0, argc);
  const isDelimiter = (byte) => {
    for (let i = 0; ; i++) {
      const entry = r.data[delimiters + i];
      if (!entry) return false;
      if (entry === byte) return true;
    }
  };
  while (r.data[cursor] && isDelimiter(r.data[cursor])) cursor++;
  if (!r.data[cursor]) {
    r.write32(context, 0);
    return ok(0, argc);
  }
  const start = cursor;
  while (r.data[cursor] && !isDelimiter(r.data[cursor])) cursor++;
  if (r.data[cursor]) {
    r.data[cursor] = 0;
    r.write32(context, cursor + 1);
  } else r.write32(context, 0);
  return ok(start, argc);
}
// _putenv installs one "NAME=VALUE" entry (or removes it when there is no `=`),
// then refreshes the cached environment vectors so a later _environ or getenv
// observes the change.
function putenvImpl(r, a, wide) {
  const pointer = a(0);
  if (!pointer) return ok(-1, 1);
  const entry = wide ? r.wideString(pointer) : r.string(pointer);
  applyEnvironment(r, entry, wide);
  return ok(0, 1);
}
function putenvS(r, a, wide) {
  const name = wide ? r.wideString(a(0)) : r.string(a(0));
  const value = wide ? r.wideString(a(1)) : r.string(a(1));
  if (!name || name.includes('=')) {
    setErrno(r, EINVAL);
    return ok(EINVAL, 2);
  }
  applyEnvironment(r, value ? `${name}=${value}` : name, wide);
  return ok(0, 2);
}
function applyEnvironment(r, entry, wide) {
  r.environment ??= { ansi: ['=C:=C:\\', 'PATH=C:\\'], wide: ['=C:=C:\\', 'PATH=C:\\'] };
  const key = entry
    .slice(0, entry.indexOf('=') < 0 ? entry.length : entry.indexOf('='))
    .toUpperCase();
  for (const kind of wide ? ['wide'] : ['ansi']) {
    const list = r.environment[kind];
    const index = list.findIndex(
      (item) =>
        item.slice(0, item.indexOf('=') < 0 ? item.length : item.indexOf('=')).toUpperCase() ===
        key,
    );
    if (entry.includes('=')) {
      if (index < 0) list.push(entry);
      else list[index] = entry;
    } else if (index >= 0) list.splice(index, 1);
  }
  // Force the vectors to be rebuilt from the updated entries.
  r.msvcrtData?.delete(wide ? '_environ' : '_environ');
  r.msvcrtData?.delete(wide ? '_environ_w' : '_environ');
  r.msvcrtData?.delete('_environ');
}
// _dupenv_s allocates a fresh copy of the value and reports its size, the
// caller's two output pointers being (buffer, size).
function dupenv(r, a, wide) {
  const name = wide ? r.wideString(a(0)) : r.string(a(0));
  const value = environmentValue(r, name, wide);
  const bufferOut = a(1),
    sizeOut = a(2);
  if (!value) {
    if (bufferOut) r.write32(bufferOut, 0);
    if (sizeOut) r.write32(sizeOut, 0);
    return ok(0, 3);
  }
  const copy = r.allocString(value, wide);
  if (bufferOut) r.write32(bufferOut, copy);
  if (sizeOut) r.write32(sizeOut, value.length + 1);
  return ok(0, 3);
}
function environmentValue(r, name, wide) {
  const wanted = name.toUpperCase();
  for (const entry of environmentEntries(r)) {
    const equals = entry.indexOf('=');
    const key = (equals < 0 ? entry : entry.slice(0, equals)).toUpperCase();
    if (key === wanted && equals >= 0) return entry.slice(equals + 1);
  }
  return null;
}
// The Bessel helpers are the only math entry points with no Closed-form
// JavaScript equivalent; they are computed from the standard ascending and
// continued-series expansions, accurate enough for the CRT's own tolerances.
function hostBessel(order, x) {
  if (order < 0) return Math.pow(-1, -order) * hostBessel(-order, x);
  let sum = 0,
    term = Math.pow(x / 2, order);
  for (let k = 0; k < 40; k++) {
    if (k) term *= -(x * x) / (4 * k * (k + order));
    sum += term / factorial(order + k);
    if (Math.abs(term / factorial(order + k)) < 1e-18 * Math.abs(sum)) break;
  }
  return sum;
}
function hostBesselY(order, x) {
  // Y_n relates to J_n through the standard order derivative; evaluate the
  // finite difference at a small step rather than deriving the closed form.
  const step = 1e-6;
  const jn = (nu) => hostBessel(nu, x);
  const derivative = (jn(order + step) - jn(order - step)) / (2 * step);
  const series = hostBessel(order, x) * (Math.log(Math.abs(x / 2)) + 0.5772156649015329);
  return derivative * 0.6366197723675814 - (order === 0 ? 0 : series);
}
function factorial(n) {
  let value = 1;
  for (let i = 2; i <= n; i++) value *= i;
  return value;
}
// Registration. Called from msvcrt.js after the real implementations are in
// place but before the trap tables, so a name that already has a handler keeps
// it and everything else gets the implementation here.
export function registerCrtExtended(apis) {
  const add = (name, handler) => {
    const key = `msvcrt.dll!${name}`;
    if (apis[key]) return;
    apis[key] = handler;
  };
  // Data cells: _ctype/_wctype are the tables, _pctype/_pwctype/_mbctype the
  // pointer variables and byte table the __p_* accessors return.
  add('_ctype', (r) => ok(ctypeTable(r), 0));
  add('_wctype', (r) => ok(wctypeTable(r), 0));
  add('_mbctype', (r) => ok(mbctypeTable(r), 0));
  add('_pctype', (r) => ok(pctypeCell(r), 0));
  add('_pwctype', (r) => ok(pwctypeCell(r), 0));
  add('__p__pctype', (r) => ok(pctypeCell(r), 0));
  add('__p__pwctype', (r) => ok(pwctypeCell(r), 0));
  add('__p__mbctype', (r) => ok(mbctypeTable(r), 0));
  add('__pctype_func', (r) => ok(ctypeTable(r) + 2, 0));
  add('__pwctype_func', (r) => ok(wctypeTable(r) + 2, 0));
  // Character classification.
  for (const [name, mask] of Object.entries(CTYPE_PREDICATES))
    add(name, (r, a) => ok(isctype(r, a(0), mask), 1));
  add('isblank', (r, a) => ok(isBlank(r, a(0)), 1));
  add('_isctype', (r, a) => ok(isctype(r, a(0), a(1)), 2));
  add('_isctype_l', (r, a) => ok(isctype(r, a(0), a(1)), 3));
  for (const [name, mask] of Object.entries(WCTYPE_PREDICATES))
    add(name, (r, a) => ok(iswctype(r, a(0), mask), 1));
  add('iswblank', (r, a) => ok((a(0) & 0xffff) === 0x09 || iswctype(r, a(0), CTYPE_BLANK), 1));
  add('_iswblank_l', (r, a) => ok((a(0) & 0xffff) === 0x09 || iswctype(r, a(0), CTYPE_BLANK), 2));
  add('iswctype', (r, a) => ok(iswctype(r, a(0), a(1)), 2));
  add('_iswctype_l', (r, a) => ok(iswctype(r, a(0), a(1)), 3));
  add('is_wctype', (r, a) => ok(iswctype(r, a(0), a(1)), 2));
  add('iswascii', (r, a) => ok((a(0) & 0xffff) < 0x80 ? 1 : 0, 1));
  add('wctype', (r, a) => ok(WCTYPE_PROPERTIES[r.string(a(0))] ?? 0, 1));
  add('wctrans', (r, a) => {
    const name = r.string(a(0));
    return ok(name === 'toupper' ? 1 : name === 'tolower' ? 2 : 0, 1);
  });
  add('towctrans', (r, a) => ok(a(1) === 1 ? toupperWide(a(0)) : tolowerWide(a(0)), 2));
  // Case mapping. The plain forms test the table first; the _to* macros are
  // unconditional, matching Wine's "sic" comment.
  add('tolower', (r, a) =>
    ok(ctypeMask(r, a(0) & 0xff) & CTYPE_UPPER ? tolowerByte(a(0)) : a(0) & 0xffff, 1),
  );
  add('toupper', (r, a) =>
    ok(ctypeMask(r, a(0) & 0xff) & CTYPE_LOWER ? toupperByte(a(0)) : a(0) & 0xffff, 1),
  );
  add('_tolower', (r, a) => ok((a(0) & 0xffff) + 0x20, 1));
  add('_toupper', (r, a) => ok((a(0) & 0xffff) - 0x20, 1));
  add('tolower', (r, a) => ok(tolowerByte(a(0)), 1));
  add('toupper', (r, a) => ok(toupperByte(a(0)), 1));
  add('towlower', (r, a) => ok(tolowerWide(a(0)), 1));
  add('towupper', (r, a) => ok(toupperWide(a(0)), 1));
  add('_tolower_l', (r, a) => ok(tolowerByte(a(0)), 2));
  add('_toupper_l', (r, a) => ok(toupperByte(a(0)), 2));
  add('_towlower_l', (r, a) => ok(tolowerWide(a(0)), 2));
  add('_towupper_l', (r, a) => ok(toupperWide(a(0)), 2));
  add('isleadbyte', () => ok(0, 1));
  add('_isleadbyte_l', () => ok(0, 2));
  add('_ismbblead', () => ok(0, 1));
  add('_ismbblead_l', () => ok(0, 2));
  add('_ismbbtrail', () => ok(0, 1));
  add('_ismbbtrail_l', () => ok(0, 2));
  add('_getmbcp', () => ok(0, 0));
  add('_setmbcp', (r, a) => ok(0, 1));
  add('_mbbtype', (r, a) => ok(isctype(r, a(1) === 1 ? 0 : a(0), PRINT) && a(1) !== 1 ? 0 : -1, 2));
  add('__isascii', (r, a) => ok((a(0) & 0xffff) < 0x80 ? 1 : 0, 1));
  add('__toascii', (r, a) => ok(a(0) & 0x7f, 1));
  add('__iscsym', (r, a) => ok(isctype(r, a(0), ALNUM) || (a(0) & 0xff) === 0x5f ? 1 : 0, 1));
  add('__iscsymf', (r, a) =>
    ok(isctype(r, a(0), CTYPE_ALPHA) || (a(0) & 0xff) === 0x5f ? 1 : 0, 1),
  );

  // Number parsing and formatting.
  const parseInt = (bits, signed) => (r, a) => {
    const { value, argc } = integerParse(r, a(0), a(1), a(2), bits, signed, 3);
    return bits === 64
      ? {
          result: Number(BigInt.asUintN(32, value)),
          resultHigh: Number(BigInt.asIntN(32, value >> 32n)),
          argc,
        }
      : ok(Number(BigInt.asIntN(32, value)) | 0, argc);
  };
  add('strtol', parseInt(32, true));
  add('strtoul', parseInt(32, false));
  add('_strtoi64', parseInt(64, true));
  add('_strtoui64', parseInt(64, false));
  add('strtoll', parseInt(64, true));
  add('strtoull', parseInt(64, false));
  add('atoi', (r, a) =>
    ok(Number(BigInt.asIntN(32, integerParse(r, a(0), 0, 10, 32, true, 1).value)) | 0, 1),
  );
  add('atol', (r, a) =>
    ok(Number(BigInt.asIntN(32, integerParse(r, a(0), 0, 10, 32, true, 1).value)) | 0, 1),
  );
  add('atoll', (r, a) => {
    const { value } = integerParse(r, a(0), 0, 10, 64, true, 1);
    return {
      result: Number(BigInt.asUintN(32, value)),
      resultHigh: Number(BigInt.asIntN(32, value >> 32n)),
      argc: 1,
    };
  });
  add('strtod', (r, a) => strtodImpl(r, a, false));
  add('strtof', (r, a) => strtodImpl(r, a, true));
  add('atof', atofImpl);
  const formatUnsigned = (name, bits, wide) => {
    add(name, (r, a) => {
      const text = formatInteger(BigInt.asUintN(bits, BigInt(a(0))), a(2) | 0, false);
      if (text === null) return ok(a(1), 3);
      if (wide) writeWideChars(r, a(1), text);
      else writeAnsiBytes(r, a(1), text);
      return ok(a(1), 3);
    });
  };
  const formatSigned = (name, bits, wide) => {
    add(name, (r, a) => {
      const value = bits === 32 ? BigInt(a(0) | 0) : BigInt(a(0)) | (BigInt(a(1)) << 32n);
      const text = formatInteger(BigInt.asIntN(bits, value), a(bits === 32 ? 2 : 3) | 0, false);
      const buffer = a(bits === 32 ? 1 : 2);
      if (text === null) return ok(buffer, bits === 32 ? 3 : 4);
      if (wide) writeWideChars(r, buffer, text);
      else writeAnsiBytes(r, buffer, text);
      return ok(buffer, bits === 32 ? 3 : 4);
    });
  };
  formatSigned('_itoa', 32, false);
  formatSigned('_ltoa', 32, false);
  formatSigned('_i64toa', 64, false);
  formatSigned('_itow', 32, true);
  formatSigned('_ltow', 32, true);
  formatUnsigned('_ultoa', 32, false);
  formatUnsigned('_ui64toa', 64, false);
  formatUnsigned('_ultow', 32, true);

  // Byte strings.
  add('strncpy', ansiCopyN);
  add('strncat', ansiCatN);
  add('strnlen', ansiNLen);
  add('strpbrk', ansiBrk);
  add('strcoll', ansiColl);
  add('strxfrm', strxfrmImpl);
  add('strerror', strerrorImpl);
  // strtok keeps the remainder in a small per-process cell, the same way the
  // CRT's own static pointer works; strtok_s uses the caller's context cell.
  add('strtok', (r, a) => {
    const cellAddress = cell(r, '_strtok_context', (rt) => rt.allocate(4));
    return strtokCore(r, a(0), a(1), cellAddress, 2);
  });
  add('strtok_s', (r, a) => strtokCore(r, a(0), a(1), a(2), 3));
  add('_memicmp', (r, a) => {
    const count = a(2) >>> 0;
    for (let i = 0; i < count; i++) {
      const left = (r.data[a(0) + i] | 0x20) & 0xff,
        right = (r.data[a(1) + i] | 0x20) & 0xff;
      if (left !== right) return ok(left < right ? -1 : 1, 3);
    }
    return ok(0, 3);
  });
  add('_strcmpi', strcmpImpl);
  add('_stricmp', strcmpImpl);
  add('strncpy_s', strncpyS);
  add('strncat_s', strncatS);

  // Wide strings.
  add('wcscat', (r, a) => wideCatN(r, { 0: () => a(0), 1: () => a(1), 2: () => 0xffffffff }, 2));
  add('wcsncat', wideCatN);
  add('wcscmp', (r, a) => wideCompare(r, a, 0xffffffff));
  add('wcsncmp', (r, a) => wideCompare(r, a, a(2) >>> 0));
  add('_wcsicmp', (r, a) => wideCompare(r, a, 0xffffffff));
  add('_wcsnicmp', (r, a) => wideCompare(r, a, a(2) >>> 0));
  add('wcsspn', wideSpan);
  add('wcscspn', wideSpanNot);
  add('wcspbrk', wideBrk);
  add('wcstok', wcstokImpl);
  add('wcslwr', (r, a) => wcsCase(r, a, false));
  add('_wcslwr', (r, a) => wcsCase(r, a, false));
  add('wcsupr', (r, a) => wcsCase(r, a, true));
  add('_wcsupr', (r, a) => wcsCase(r, a, true));
  add('wcsrev', wcsRev);
  add('wcsdup', wcsDup);
  add('_wcsdup', wcsDup);
  // wcstol/wcstoul/wcstod mirror their byte forms over UTF-16 text.
  const wideText = (r, pointer) => {
    let text = '';
    for (let i = 0; i < 0x1000000; i++) {
      const code = r.guestMemory.read(pointer + i * 2, 2);
      if (!code) break;
      text += String.fromCharCode(code);
    }
    return text;
  };
  const wideInteger = (bits, signed) => (r, a) => {
    const text = wideText(r, a(0));
    const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const parsed = parseInteger(text, a(2) | 0, max, min);
    if (a(1)) r.write32(a(1), a(0) + (parsed ? parsed.consumed : 0) * 2);
    if (parsed?.range) setErrno(r, ERANGE);
    const value = parsed ? parsed.value : 0n;
    return bits === 64
      ? {
          result: Number(BigInt.asUintN(32, value)),
          resultHigh: Number(BigInt.asIntN(32, value >> 32n)),
          argc: 3,
        }
      : ok(Number(BigInt.asIntN(32, value)) | 0, 3);
  };
  add('wcstol', wideInteger(32, true));
  add('wcstoul', wideInteger(32, false));
  add('_wcstoi64', wideInteger(64, true));
  add('_wcstoui64', wideInteger(64, false));
  add('wcstod', (r, a) => {
    const parsed = parseFloatPrefix(wideText(r, a(0)));
    if (a(1)) r.write32(a(1), a(0) + (parsed ? parsed.length : 0) * 2);
    return double4(r, parsed ? parsed.value : 0, 2);
  });

  // Multibyte.
  add('_mbsdup', (r, a) => {
    const length = ansiLengthOf(r, a(0));
    const copy = r.allocate(length + 1);
    r.data.copyWithin(copy, a(0), a(0) + length + 1);
    return ok(copy, 1);
  });
  add('_mbscpy', (r, a) => {
    const length = ansiLengthOf(r, a(1));
    r.check(a(0), length + 1, true);
    r.data.copyWithin(a(0), a(1), a(1) + length + 1);
    return ok(a(0), 2);
  });
  add('_mbscat', (r, a) => {
    const left = ansiLengthOf(r, a(0)),
      right = ansiLengthOf(r, a(1));
    r.check(a(0), left + right + 1, true);
    r.data.copyWithin(a(0) + left, a(1), a(1) + right + 1);
    return ok(a(0), 2);
  });
  add('_mbslen', (r, a) => ok(ansiLengthOf(r, a(0)), 1));
  add('_mbschr', (r, a) => {
    const needle = a(1) & 0xff;
    for (let i = 0; ; i++) {
      if (r.data[a(0) + i] === needle) return ok(a(0) + i, 2);
      if (!r.data[a(0) + i]) return ok(0, 2);
    }
  });
  add('_mbsrchr', (r, a) => {
    const needle = a(1) & 0xff;
    let found = 0;
    for (let i = 0; ; i++) {
      if (r.data[a(0) + i] === needle) found = a(0) + i;
      if (!r.data[a(0) + i]) return ok(found, 2);
    }
  });
  add('_mbsicmp', strcmpImpl);
  add('_mbsnbicmp', (r, a) => {
    const count = a(2) >>> 0;
    for (let i = 0; i < count; i++) {
      const left = (r.data[a(0) + i] | 0x20) & 0xff,
        right = (r.data[a(1) + i] | 0x20) & 0xff;
      if (left !== right) return ok(left < right ? -1 : 1, 3);
      if (!left) break;
    }
    return ok(0, 3);
  });
  add('_mbscmp', strcmpImpl);
  add('_mbsncmp', (r, a) => {
    const count = a(2) >>> 0;
    for (let i = 0; i < count; i++) {
      const left = r.data[a(0) + i],
        right = r.data[a(1) + i];
      if (left !== right) return ok(left < right ? -1 : 1, 3);
      if (!left) break;
    }
    return ok(0, 3);
  });
  add('_mbsnlen', mbsNLen);
  add('_mbsnbcnt', mbsNLen);
  add('_mbsnccnt', mbsNLen);
  add('_mbscpy_s', mbsCopyS);
  add('_mbsncpy', ansiCopyN);
  add('_mbsncat', ansiCatN);
  add('_mbscspn', (r, a) => {
    const set = [];
    for (let i = 0; r.data[a(1) + i]; i++) set.push(r.data[a(1) + i]);
    let count = 0;
    while (r.data[a(0) + count] && !set.includes(r.data[a(0) + count])) count++;
    return ok(count, 2);
  });
  add('_mbsspn', (r, a) => {
    const set = [];
    for (let i = 0; r.data[a(1) + i]; i++) set.push(r.data[a(1) + i]);
    let count = 0;
    while (r.data[a(0) + count] && set.includes(r.data[a(0) + count])) count++;
    return ok(count, 2);
  });
  add('_mbspbrk', ansiBrk);
  add('_mbsstr', (r, a) => {
    const haystack = ansiLengthOf(r, a(0)),
      needle = ansiLengthOf(r, a(1));
    if (!needle) return ok(a(0), 2);
    for (let i = 0; i + needle <= haystack; i++) {
      let match = true;
      for (let j = 0; j < needle; j++)
        if (r.data[a(0) + i + j] !== r.data[a(1) + j]) {
          match = false;
          break;
        }
      if (match) return ok(a(0) + i, 2);
    }
    return ok(0, 2);
  });
  add('_mbstok', (r, a) => {
    const context = a(2);
    if (!context) return ok(0, 3);
    let cursor = a(0) >>> 0;
    if (!cursor) cursor = r.read32(context) >>> 0;
    if (!cursor) return ok(0, 3);
    const isDelimiter = (byte) => {
      for (let i = 0; r.data[a(1) + i]; i++) if (r.data[a(1) + i] === byte) return true;
      return false;
    };
    while (r.data[cursor] && isDelimiter(r.data[cursor])) cursor++;
    if (!r.data[cursor]) {
      r.write32(context, 0);
      return ok(0, 3);
    }
    const start = cursor;
    while (r.data[cursor] && !isDelimiter(r.data[cursor])) cursor++;
    if (r.data[cursor]) {
      r.data[cursor] = 0;
      r.write32(context, cursor + 1);
    } else r.write32(context, 0);
    return ok(start, 3);
  });
  add('_mbsset', (r, a) => mbsSet(r, a, 0xffffffff, a(1) & 0xff));
  add('_mbsnset', (r, a) => mbsSet(r, a, a(2) >>> 0, a(1) & 0xff));
  add('_mbsrev', mbsRev);
  add('_mbsinc', mbsInc);
  add('_mbsdec', (r, a) => mbsDec(r, a, 2));
  add('_mbsnextc', mbsNextC);
  add('_mbslwr', (r, a) => mbsCase(r, a, false));
  add('_mbsupr', (r, a) => mbsCase(r, a, true));
  add('_mbccpy', (r, a) => {
    r.data[a(0)] = r.data[a(1)];
    r.data[a(0) + 1] = 0;
    return ok(0, 2);
  });
  add('_mbclen', (r, a) => ok(r.data[a(0)] ? 1 : 0, 1));
  add('_mbctolower', (r, a) => ok(tolowerByte(r.data[a(0)]) & 0xff, 1));
  add('_mbctoupper', (r, a) => ok(toupperByte(r.data[a(0)]) & 0xff, 1));
  add('_mbbtombc', (r, a) => ok(a(0) & 0xff, 1));
  add('_mbctombb', (r, a) => ok(a(0) & 0xff, 1));

  // Environment.
  add('_putenv', (r, a) => putenvImpl(r, a, false));
  add('_wputenv', (r, a) => putenvImpl(r, a, true));
  add('_putenv_s', (r, a) => putenvS(r, a, false));
  add('_wputenv_s', (r, a) => putenvS(r, a, true));
  add('_dupenv_s', (r, a) => dupenv(r, a, false));
  add('_wdupenv_s', (r, a) => dupenv(r, a, true));
  add('_get_environ', (r, a) => getEnviron(r, a, false));
  add('_get_wenviron', (r, a) => getEnviron(r, a, true));
  add('getenv', (r, a) => getenvImpl(r, a, false));
  add('_wgetenv', (r, a) => getenvImpl(r, a, true));

  // Number helpers.
  add('rand', randImpl);
  add('srand', srandImpl);
  add('abs', (r, a) => absImpl(r, a, 32));
  add('labs', (r, a) => absImpl(r, a, 32));
  add('llabs', (r, a) => absImpl(r, a, 64));
  add('_abs64', (r, a) => absImpl(r, a, 64));
  add('div', (r, a) => divImpl(r, a, 2, 32, true));
  add('ldiv', (r, a) => divImpl(r, a, 2, 32, true));
  add('bsearch', bsearchImpl);
  add('bsearch_s', (r, a) => bsearchImpl(r, a, true));
  add('system', systemImpl);
  add('abort', abortImpl);
  // frexpf(float* value, int* exponent): the float is read through a pointer
  // (unlike frexp, whose double is on the stack) and the result is binary32.
  add('frexpf', (r, a) => {
    const value = readFloat32(r, a(0));
    let exponent = 0,
      mantissa = value;
    if (value && Number.isFinite(value)) {
      exponent = Math.floor(Math.log2(Math.abs(value))) + 1;
      mantissa = value / 2 ** exponent;
    }
    if (a(1)) {
      r.check(a(1), 4, true);
      r.write32(a(1), exponent | 0);
    }
    return float4(r, mantissa, 2);
  });

  // Math helpers.
  add('_logb', logbImpl);
  add('_logbf', (r, a) => float4(r, Math.log2(Math.abs(floatArg(r, a, 0))) | 0, 1));
  add('_nextafter', (r, a) => nextafterImpl(r, a, false));
  add('_nextafterf', (r, a) => nextafterImpl(r, a, true));
  add('_copysignf', (r, a) =>
    float4(r, Math.abs(floatArg(r, a, 0)) * (Math.sign(floatArg(r, a, 1)) || 1), 2),
  );
  add('_chgsignf', (r, a) => float4(r, -floatArg(r, a, 0), 1));
  add('_scalbf', (r, a) => float4(r, floatArg(r, a, 0) * 2 ** (a(1) | 0), 2));
  add('_hypotf', (r, a) => float4(r, Math.hypot(floatArg(r, a, 0), floatArg(r, a, 1)), 2));
  add('_fpclass', fpclassImpl);
  add('_fpclassf', (r, a) => {
    // _fpclassf takes a binary32 argument and classifies the same way.
    const bits = new Uint32Array([a(0) >>> 0]);
    const value = new DataView(bits.buffer).getFloat32(0, true);
    return ok(fpclassImpl(r, { 0: () => value, 1: () => 0 }, 1).result, 1);
  });
  add('_finite', (r, a) => ok(Number.isFinite(doubleArg(r, a, 0)) ? 1 : 0, 2));
  add('_isnan', (r, a) => ok(Number.isNaN(doubleArg(r, a, 0)) ? 1 : 0, 2));
  add('_hypot', (r, a) => double4(r, Math.hypot(doubleArg(r, a, 0), doubleArg(r, a, 2)), 4));
  add('_scalb', (r, a) => double4(r, doubleArg(r, a, 0) * 2 ** (a(2) | 0), 3));
  add('_cabs', (r, a) => double4(r, Math.hypot(a(0) | 0, a(1) | 0), 2));
  add('_j0', (r, a) => double4(r, hostBessel(0, doubleArg(r, a, 0)), 2));
  add('_j1', (r, a) => double4(r, hostBessel(1, doubleArg(r, a, 0)), 2));
  add('_y0', (r, a) => double4(r, hostBesselY(0, doubleArg(r, a, 0)), 2));
  add('_y1', (r, a) => double4(r, hostBesselY(1, doubleArg(r, a, 0)), 2));
  add('_jn', (r, a) => double4(r, hostBessel(a(0) | 0, doubleArg(r, a, 2)), 3));
  add('_yn', (r, a) => double4(r, hostBesselY(a(0) | 0, doubleArg(r, a, 2)), 3));

  // Current directory, absolute paths, split/join.
  add('_getcwd', (r, a) => getcwdImpl(r, a, false));
  add('_wgetcwd', (r, a) => getcwdImpl(r, a, true));
  add('_getdcwd', (r, a) => getdcwdImpl(r, a, false));
  add('_wgetdcwd', (r, a) => getdcwdImpl(r, a, true));
  add('_chdir', (r, a) => chdirImpl(r, a, false));
  add('_wchdir', (r, a) => chdirImpl(r, a, true));
  add('_getdrive', getdriveImpl);
  add('_chdrive', (r, a) => (a(0) === 3 ? ok(0, 1) : (setErrno(r, EACCES), ok(-1, 1))));
  add('_fullpath', (r, a) => fullpathImpl(r, a, false));
  add('_wfullpath', (r, a) => fullpathImpl(r, a, true));
  add('_splitpath', (r, a) => splitpathUnchecked(r, a, false));
  add('_wsplitpath', (r, a) => splitpathUnchecked(r, a, true));
  add('_splitpath_s', (r, a) => splitpathImpl(r, a, false));
  add('_wsplitpath_s', (r, a) => splitpathImpl(r, a, true));
  add('_makepath', (r, a) => makepathUnchecked(r, a, false));
  add('_wmakepath', (r, a) => makepathUnchecked(r, a, true));
  add('_makepath_s', (r, a) => makepathImpl(r, a, false));
  add('_wmakepath_s', (r, a) => makepathImpl(r, a, true));

  // Access, stat and directory search.
  add('_access', (r, a) => accessImpl(r, a, false));
  add('_waccess', (r, a) => accessImpl(r, a, true));
  add('_access_s', (r, a) => accessS(r, a, false));
  add('_waccess_s', (r, a) => accessS(r, a, true));
  const statEntry = (name, layout, wide) => add(name, (r, a) => statPath(r, a, wide, layout));
  const fstatEntry = (name, layout) => add(name, (r, a) => statDescriptor(r, a, layout));
  for (const [name, layout, wide] of [
    ['_stat', STAT_LAYOUTS.stat32, false],
    ['_stat32', STAT_LAYOUTS.stat32, false],
    ['_stat64', STAT_LAYOUTS.stat64, false],
    ['_stati64', STAT_LAYOUTS.stat32i64, false],
    ['_stat32i64', STAT_LAYOUTS.stat32i64, false],
    ['_stat64i32', STAT_LAYOUTS.stat64i32, false],
    ['_wstat', STAT_LAYOUTS.stat32, true],
    ['_wstat32', STAT_LAYOUTS.stat32, true],
    ['_wstat64', STAT_LAYOUTS.stat64, true],
    ['_wstati64', STAT_LAYOUTS.stat32i64, true],
    ['_wstat32i64', STAT_LAYOUTS.stat32i64, true],
    ['_wstat64i32', STAT_LAYOUTS.stat64i32, true],
  ])
    statEntry(name, layout, wide);
  for (const [name, layout] of [
    ['_fstat', STAT_LAYOUTS.stat32],
    ['_fstat32', STAT_LAYOUTS.stat32],
    ['_fstat64', STAT_LAYOUTS.stat64],
    ['_fstati64', STAT_LAYOUTS.stat32i64],
    ['_fstat32i64', STAT_LAYOUTS.stat32i64],
    ['_fstat64i32', STAT_LAYOUTS.stat64i32],
  ])
    fstatEntry(name, layout);
  const findEntry = (prefix, wide) => {
    add(`${prefix}first`, (r, a) => findfirstImpl(r, a, wide, FIND_LAYOUTS.find32));
    add(`${prefix}firsti64`, (r, a) => findfirstImpl(r, a, wide, FIND_LAYOUTS.find32i64));
    add(`${prefix}first64i32`, (r, a) => findfirstImpl(r, a, wide, FIND_LAYOUTS.find64i32));
    add(`${prefix}first64`, (r, a) => findfirstImpl(r, a, wide, FIND_LAYOUTS.find64));
    add(`${prefix}next`, (r, a) => findnextImpl(r, a, wide, FIND_LAYOUTS.find32));
    add(`${prefix}nexti64`, (r, a) => findnextImpl(r, a, wide, FIND_LAYOUTS.find32i64));
    add(`${prefix}next64i32`, (r, a) => findnextImpl(r, a, wide, FIND_LAYOUTS.find64i32));
    add(`${prefix}next64`, (r, a) => findnextImpl(r, a, wide, FIND_LAYOUTS.find64));
  };
  findEntry('_find', false);
  findEntry('_wfind', true);
  add('_findfirst32', (r, a) => findfirstImpl(r, a, false, FIND_LAYOUTS.find32));
  add('_findnext32', (r, a) => findnextImpl(r, a, false, FIND_LAYOUTS.find32));
  add('_wfindfirst32', (r, a) => findfirstImpl(r, a, true, FIND_LAYOUTS.find32));
  add('_wfindnext32', (r, a) => findnextImpl(r, a, true, FIND_LAYOUTS.find32));
  add('_findclose', findcloseImpl);

  // Rotations, byte swapping and the bounded integer-to-string conversions.
  add('_rotl', (r, a) => rotlImpl(r, a, true));
  add('_rotr', (r, a) => rotlImpl(r, a, false));
  add('_lrotl', (r, a) => rotlImpl(r, a, true));
  add('_lrotr', (r, a) => rotlImpl(r, a, false));
  add('_swab', swabImpl);
  add('_itoa_s', (r, a) =>
    integerToString(r, a, {
      wide: false,
      bits: 32,
      signed: true,
      bufferIndex: 1,
      sizeIndex: 2,
      valueIndex: 0,
      radixIndex: 3,
    }),
  );
  add('_ltoa_s', (r, a) =>
    integerToString(r, a, {
      wide: false,
      bits: 32,
      signed: true,
      bufferIndex: 1,
      sizeIndex: 2,
      valueIndex: 0,
      radixIndex: 3,
    }),
  );
  add('_ultoa_s', (r, a) =>
    integerToString(r, a, {
      wide: false,
      bits: 32,
      signed: false,
      bufferIndex: 1,
      sizeIndex: 2,
      valueIndex: 0,
      radixIndex: 3,
    }),
  );
  add('_itow_s', (r, a) =>
    integerToString(r, a, {
      wide: true,
      bits: 32,
      signed: true,
      bufferIndex: 1,
      sizeIndex: 2,
      valueIndex: 0,
      radixIndex: 3,
    }),
  );
  add('_ltow_s', (r, a) =>
    integerToString(r, a, {
      wide: true,
      bits: 32,
      signed: true,
      bufferIndex: 1,
      sizeIndex: 2,
      valueIndex: 0,
      radixIndex: 3,
    }),
  );
  add('_ultow_s', (r, a) =>
    integerToString(r, a, {
      wide: true,
      bits: 32,
      signed: false,
      bufferIndex: 1,
      sizeIndex: 2,
      valueIndex: 0,
      radixIndex: 3,
    }),
  );
  add('_i64toa_s', (r, a) =>
    integerToString(r, a, {
      wide: false,
      bits: 64,
      signed: true,
      bufferIndex: 2,
      sizeIndex: 3,
      valueIndex: 0,
      radixIndex: 4,
    }),
  );
  add('_ui64toa_s', (r, a) =>
    integerToString(r, a, {
      wide: false,
      bits: 64,
      signed: false,
      bufferIndex: 2,
      sizeIndex: 3,
      valueIndex: 0,
      radixIndex: 4,
    }),
  );
  add('_i64tow_s', (r, a) =>
    integerToString(r, a, {
      wide: true,
      bits: 64,
      signed: true,
      bufferIndex: 2,
      sizeIndex: 3,
      valueIndex: 0,
      radixIndex: 4,
    }),
  );
  add('_ui64tow_s', (r, a) =>
    integerToString(r, a, {
      wide: true,
      bits: 64,
      signed: false,
      bufferIndex: 2,
      sizeIndex: 3,
      valueIndex: 0,
      radixIndex: 4,
    }),
  );

  // Wide numeric conversion mirrors the byte forms over UTF-16 text.
  const wideIntegerValue = (bits, signed) => (r, a) => {
    const text = wideText(r, a(0));
    const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const parsed = parseInteger(text, 10, max, min);
    if (parsed?.range) setErrno(r, ERANGE);
    const value = parsed ? parsed.value : 0n;
    return bits === 64
      ? {
          result: Number(BigInt.asUintN(32, value)),
          resultHigh: Number(BigInt.asIntN(32, value >> 32n)),
          argc: 1,
        }
      : ok(Number(BigInt.asIntN(32, value)) | 0, 1);
  };
  add('_wtoi', wideIntegerValue(32, true));
  add('_wtol', wideIntegerValue(32, true));
  add('_wtoi64', wideIntegerValue(64, true));
  add('_atoi64', (r, a) => {
    const parsed = parseInteger(ansiText(r, a(0)), 10, (1n << 63n) - 1n, -(1n << 63n));
    const value = parsed ? parsed.value : 0n;
    return {
      result: Number(BigInt.asUintN(32, value)),
      resultHigh: Number(BigInt.asIntN(32, value >> 32n)),
      argc: 1,
    };
  });
  add('_wtof', (r, a) => {
    const parsed = parseFloatPrefix(wideText(r, a(0)));
    return double4(r, parsed ? parsed.value : 0, 1);
  });

  // The single-byte code-page conversions.
  add('btowc', (r, a) => ok((a(0) & 0xff) < 0x80 || a(0) === 0 ? a(0) & 0xff : 0xffff, 1));
  add('wctob', (r, a) => ok((a(0) & 0xffff) < 0x80 ? a(0) & 0xff : -1, 1));
  add('mblen', (r, a) => ok(a(0) ? 1 : 0, 2));
  add('mbtowc', (r, a) => mbtowcImpl(r, a, 3));
  add('mbrlen', (r, a) =>
    ok(mbtowcImpl(r, { 0: () => 0, 1: () => a(0), 2: () => a(1) }, 3).result, 3),
  );
  add('mbrtowc', (r, a) => {
    const source = a(1) >>> 0,
      count = a(2) >>> 0;
    if (!source || !count) return ok(0, 4);
    const result = mbtowcImpl(r, { 0: () => a(0), 1: () => source, 2: () => count }, 4);
    return ok(result.result === 1 ? 1 : result.result, 4);
  });
  add('wctomb', (r, a) => wctombImpl(r, a, 2));
  add('wcrtomb', (r, a) => wctombImpl(r, { 0: () => a(0), 1: () => a(1) }, 3));
  add('mbstowcs', (r, a) => mbstowcsImpl(r, a, 3));
  add('wcstombs', (r, a) => wcstombsImpl(r, a, 3));
  add('_mbstowcs_s', (r, a) =>
    mbstowcsImpl(r, { 0: () => a(1), 1: () => a(3), 2: () => a(4), 3: () => a(0) }, 5),
  );
  add('mbstowcs_s', (r, a) =>
    mbstowcsImpl(r, { 0: () => a(1), 1: () => a(3), 2: () => a(4), 3: () => a(0) }, 5),
  );
  add('_wcstombs_s', (r, a) =>
    wcstombsImpl(r, { 0: () => a(1), 1: () => a(3), 2: () => a(4), 3: () => a(0) }, 5),
  );
  add('wcstombs_s', (r, a) =>
    wcstombsImpl(r, { 0: () => a(1), 1: () => a(3), 2: () => a(4), 3: () => a(0) }, 5),
  );
  add('wctomb_s', (r, a) => {
    const out = a(0),
      buffer = a(1),
      size = a(2) >>> 0,
      code = a(3) & 0xffff;
    const result = wctombImpl(r, { 0: () => buffer, 1: () => code }, 4);
    if (out) r.write32(out, result.result < 0 ? 0xffffffff : result.result);
    void size;
    return ok(result.result < 0 ? 22 : 0, 4);
  });
  add('wcrtomb_s', (r, a) => {
    const out = a(0),
      buffer = a(1),
      size = a(2) >>> 0,
      code = a(3) & 0xffff;
    const result = wctombImpl(r, { 0: () => buffer, 1: () => code }, 5);
    if (out) r.write32(out, result.result < 0 ? 0xffffffff : result.result);
    void size;
    return ok(result.result < 0 ? 22 : 0, 5);
  });

  // Locale.
  add('localeconv', localeconvImpl);
  add('setlocale', setlocaleImpl);
  add('_wsetlocale', setlocaleImpl);
  add('_get_current_locale', (r) => ok(currentLocaleHandle(r), 0));
  add('_create_locale', (r) => ok(currentLocaleHandle(r), 2));
  add('_wcreate_locale', (r) => ok(currentLocaleHandle(r), 2));
  add('_free_locale', () => ok(0, 1));
  add('_configthreadlocale', () => ok(0, 1));

  // List search helpers.
  add('_lfind', (r, a) => lfindImpl(r, a, { search: false, withContext: false, argc: 5 }));
  add('_lfind_s', (r, a) => lfindImpl(r, a, { search: false, withContext: true, argc: 6 }));
  add('_lsearch', (r, a) => lfindImpl(r, a, { search: true, withContext: false, argc: 5 }));
  add('_lsearch_s', (r, a) => lfindImpl(r, a, { search: true, withContext: true, argc: 6 }));

  // Byte-string extras.
  add('__strncnt', strncntImpl);
  add('_strnset', (r, a) => strsetImpl(r, a, true));
  add('_strset', (r, a) => strsetImpl(r, a, false));
  add('_strlwr_s', (r, a) => strCaseS(r, a, false, 2));
  add('_strupr_s', (r, a) => strCaseS(r, a, true, 2));
  add('_strlwr_s_l', (r, a) => strCaseS(r, a, false, 3));
  add('_strupr_s_l', (r, a) => strCaseS(r, a, true, 3));
  add('_stricmp_l', strcmpImpl);
  add('_strnicmp_l', strcmpImpl);
  add('_wcsicmp_l', (r, a) => wideCompare(r, a, 0xffffffff));
  add('_wcsnicmp_l', (r, a) => wideCompare(r, a, a(2) >>> 0));
  add('_strcoll_l', ansiColl);
  add('_wcscoll_l', (r, a) => wideCompare(r, a, 0xffffffff));
  add('_strxfrm_l', strxfrmImpl);

  // Process and console queries.
  add('_getpid', (r) => ok(r.processId ?? 4242, 0));
  add('_beep', (r, a) => {
    const frequency = a(0) | 0,
      duration = a(1) | 0;
    if (frequency < 37 || frequency > 32767 || duration > 10000) return ok(-1, 2);
    r.request('beep', { frequency, duration });
    return ok(0, 2);
  });
  add('_sleep', async (r, a) => {
    const milliseconds = a(0) >>> 0;
    if (milliseconds > 10000) throw Error('_sleep exceeds prototype 10-second limit');
    await r.threads.delay(milliseconds);
    return ok(0, 1);
  });
  add('_get_osplatform', () => ok(2, 0));
  add('_get_osver', (r, a) => {
    if (a(0)) r.write32(a(0), 0x0a280000 | 0x0a28);
    return ok(0, 1);
  });
  add('_get_winmajor', (r, a) => {
    if (a(0)) r.write32(a(0), 6);
    return ok(0, 1);
  });
  add('_get_winminor', (r, a) => {
    if (a(0)) r.write32(a(0), 2);
    return ok(0, 1);
  });
  add('_get_pgmptr', (r, a) => {
    if (a(0)) r.write32(a(0), r.allocString(r.exe.replaceAll('/', '\\')));
    return ok(0, 1);
  });
  add('_get_wpgmptr', (r, a) => {
    if (a(0)) r.write32(a(0), r.allocString(r.exe.replaceAll('/', '\\'), true));
    return ok(0, 1);
  });
  add('_heapchk', () => ok(0xffffffff, 0)); // -1: the CRT heap is not the guest heap.
  add('_heapmin', () => ok(0, 0));
  add('_heapset', () => ok(0, 1));
  add('_heapwalk', () => ok(0xffffffff, 1));
  add('signal', (r, a) => {
    // The runtime delivers no signals; report the previous handler and accept
    // the registration so a program's own bookkeeping stays consistent.
    const previous = r.crtSignals?.get(a(0)) ?? 0;
    r.crtSignals ??= new Map();
    r.crtSignals.set(a(0), a(1) >>> 0);
    return ok(previous, 2);
  });
  add('raise', () => ok(0, 1));
  add('_fpieee_flt', () => ok(0, 4));
}

// ---------------------------------------------------------------------------
// A second group of CRT entry points: the single-byte code-page conversions,
// the C locale, the byte/word rotation helpers, the list search helpers, and
// the small process/console queries a console program reaches for. Each is
// grounded in the same guest model as the rest of the module, and the ones with
// no honest answer (a real locale database, a child process) report the CRT's
// documented failure instead of inventing a result.
function mbtowcImpl(r, a, argc) {
  const destination = a(0),
    source = a(1) >>> 0,
    count = a(2) | 0;
  if (!source) return ok(0, argc);
  if (count <= 0) return ok(-1, argc);
  const byte = r.data[source];
  if (!byte) return ok(0, argc);
  // The code page is single-byte: only bytes below 0x80 have a UTF-16 unit.
  if (byte >= 0x80) {
    setErrno(r, 42); // EILSEQ
    return ok(-1, argc);
  }
  if (destination) r.guestMemory.write(destination, byte, 2);
  return ok(1, argc);
}
function wctombImpl(r, a, argc) {
  const destination = a(0),
    code = a(1) & 0xffff;
  if (!destination) return ok(0, argc);
  if (!code) {
    r.data[destination] = 0;
    return ok(0, argc);
  }
  if (code >= 0x80) {
    setErrno(r, 42);
    return ok(-1, argc);
  }
  r.data[destination] = code;
  return ok(1, argc);
}
// mbstowcs/wcstombs convert whole strings. The count bounds the number of
// produced units; a NUL terminator is written when there is room, and an
// unrepresentable unit makes the conversion fail with EILSEQ and SIZE_MAX.
function mbstowcsImpl(r, a, argc) {
  const bounded = argc === 5;
  const destination = a(0) >>> 0,
    source = a(1) >>> 0;
  const count = a(2) >>> 0;
  let converted = 0;
  for (; ; converted++) {
    const byte = r.data[source + converted];
    if (!byte) break;
    if (bounded && count && converted >= count) break;
    if (byte >= 0x80) {
      setErrno(r, 42);
      if (bounded && a(3)) r.write32(a(3), 0);
      return ok(0xffffffff, argc);
    }
    if (destination) r.guestMemory.write(destination + converted * 2, byte, 2);
  }
  if (destination && (!bounded || !count || converted < count))
    r.guestMemory.write(destination + converted * 2, 0, 2);
  if (bounded && a(3)) r.write32(a(3), converted + 1);
  return ok(converted, argc);
}
function wcstombsImpl(r, a, argc) {
  const bounded = argc === 5;
  const destination = a(0) >>> 0,
    source = a(1) >>> 0;
  const count = a(2) >>> 0;
  let converted = 0;
  for (; ; converted++) {
    const code = r.guestMemory.read(source + converted * 2, 2);
    if (!code) break;
    if (bounded && count && converted >= count) break;
    if (code >= 0x80) {
      setErrno(r, 42);
      if (bounded && a(3)) r.write32(a(3), 0);
      return ok(0xffffffff, argc);
    }
    if (destination) r.data[destination + converted] = code;
  }
  if (destination && (!bounded || !count || converted < count)) r.data[destination + converted] = 0;
  if (bounded && a(3)) r.write32(a(3), converted + 1);
  return ok(converted, argc);
}
// The C locale's lconv: the decimal point is ".", every other string is empty
// and the digit counts are CHAR_MAX, matching Wine's cloc_lconv.
function localeconvImpl(r) {
  return ok(
    cell(r, '_lconv', (rt) => {
      const table = rt.allocate(64);
      rt.write32(table, rt.allocString('.'));
      for (let i = 1; i < 10; i++) rt.write32(table + i * 4, rt.allocString(''));
      rt.data[table + 40] = 0x7f; // int_frac_digits = CHAR_MAX
      rt.data[table + 41] = 0x7f; // frac_digits = CHAR_MAX
      return table;
    }),
    0,
  );
}
// setlocale records the requested name and answers with it (the runtime has one
// locale, so there is nothing else to switch to). _get_current_locale returns
// that same persistent handle, and every _create_locale call answers with one
// shared, valid handle because the locale contents are identical.
function setlocaleImpl(r, a) {
  const requested = a(1) ? r.string(a(1)) : '';
  if (requested) r.crtLocaleName = requested;
  r.crtLocaleName ??= 'C';
  return ok(
    cell(r, '_locale_name', (rt) => rt.allocString(r.crtLocaleName)),
    2,
  );
}
function currentLocaleHandle(r) {
  return cell(r, '_current_locale', (rt) => {
    const handle = rt.allocate(32, true);
    rt.write32(handle, rt.allocString(r.crtLocaleName ?? 'C'));
    return handle;
  });
}
// _lfind walks an array of fixed-size records with the guest comparator and
// returns a match; _lsearch also appends the key when there is no match.
// _lfind/_lsearch take a two-argument comparator (key, element); the _s forms add
// a context word that is passed first (context, key, element). _lsearch also
// appends the key when nothing matched and grows the caller's count.
async function lfindImpl(r, a, { search, withContext, argc }) {
  const key = a(0),
    base = a(1),
    countPointer = a(2),
    size = a(3) >>> 0,
    compare = a(4) >>> 0;
  const context = withContext ? a(5) : 0;
  if (!size || !compare || !countPointer) return ok(0, argc);
  const count = r.read32(countPointer) >>> 0;
  for (let i = 0; i < count; i++) {
    const element = base + i * size;
    const result = await r.callGuest(
      compare,
      withContext ? [context, key, element] : [key, element],
      'cdecl',
    );
    if (result === 0) return ok(element, argc);
  }
  if (!search) return ok(0, argc);
  if (count > 1 << 20) throw Error('_lsearch count limit exceeded');
  r.check(base + count * size, size, true);
  r.data.copyWithin(base + count * size, key, key + size);
  r.write32(countPointer, count + 1);
  return ok(base + count * size, argc);
}
// __strncnt counts the leading characters that are not the given byte.
function strncntImpl(r, a) {
  const byte = a(1) & 0xff || 0x20;
  let count = 0;
  while (r.data[a(0) + count] && r.data[a(0) + count] !== byte) count++;
  return ok(count, 2);
}
// _strnset/_strset fill with a byte up to a count or the terminator.
function strsetImpl(r, a, bounded) {
  const value = a(1) & 0xff;
  let count = bounded ? a(2) >>> 0 : 0xffffffff;
  if (bounded) r.check(a(0), 1, true);
  for (let i = 0; i < count; i++) {
    if (!bounded && !r.data[a(0) + i]) break;
    r.data[a(0) + i] = value;
  }
  return ok(a(0), bounded ? 3 : 2);
}
// _strlwr_s/_strupr_s validate the destination size and report errno_t.
function strCaseS(r, a, upper, argc) {
  const destination = a(0) >>> 0,
    size = a(1) >>> 0;
  if (!destination || !size) {
    setErrno(r, EINVAL);
    return ok(EINVAL, argc);
  }
  r.check(destination, size, true);
  let i = 0;
  for (; i < size && r.data[destination + i]; i++) {
    const byte = r.data[destination + i];
    if (upper) r.data[destination + i] = byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
    else r.data[destination + i] = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  }
  if (i >= size) {
    setErrno(r, ERANGE);
    return ok(ERANGE, argc);
  }
  return ok(0, argc);
}
