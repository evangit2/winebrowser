// The scanf family: real scanning over guest bytes. Wine implements these in
// dlls/msvcrt/scanf.h; the conversions, field widths, length modifiers and
// assignment-suppression rules below follow that header and the C standard.
// Nothing here reuses the printf formatter, because scanning is a different
// machine: it consumes input and writes through the caller's pointers.
const ok = (result = 0, argc = 0) => ({ result, argc });
const EOF = -1;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
const MAX_FIELD = 1 << 20;

// A cursor over a code-unit sequence. Codes are bytes for the ANSI forms and
// UTF-16 units for the wide ones, so one scanner serves both.
function cursorOf(codes) {
  return {
    position: 0,
    peek() {
      return this.position < codes.length ? codes[this.position] : null;
    },
    next() {
      return this.position < codes.length ? codes[this.position++] : null;
    },
    unget() {
      if (this.position > 0) this.position--;
    },
  };
}
function stringCodes(r, pointer, wide) {
  const codes = [];
  if (!pointer) return codes;
  for (let i = 0; i < MAX_FIELD; i++) {
    const code = wide ? r.guestMemory.read(pointer + i * 2, 2) : r.data[pointer + i];
    if (!code) break;
    codes.push(code);
  }
  return codes;
}
// The printable form of a scanned field, so the numeric parsers can reuse the
// same digit/base rules the string-to-number functions use.
function codesToText(codes) {
  return codes.map((code) => String.fromCharCode(code)).join('');
}
// One conversion's result written through the caller's pointer. Widths follow
// the MSVC rules: `h`/`hh` narrow, `l`/`ll`/`I64` widen, `L` selects long double.
function storeInteger(r, pointer, value, length, signed, argc) {
  const low = BigInt.asUintN(32, value);
  const high = BigInt.asIntN(32, value >> 32n);
  switch (length) {
    case 'hh':
      r.check(pointer, 1, true);
      r.data[pointer] = Number(BigInt.asUintN(8, value));
      break;
    case 'h':
      r.check(pointer, 2, true);
      r.guestMemory.write(pointer, Number(BigInt.asUintN(16, value)), 2);
      break;
    case 'l':
    case 'L':
      r.check(pointer, 4, true);
      r.write32(pointer, Number(BigInt.asIntN(32, value)));
      break;
    case 'll':
    case 'I64':
      r.check(pointer, 8, true);
      r.view.setBigInt64(pointer, BigInt.asIntN(64, value), true);
      break;
    default:
      r.check(pointer, 4, true);
      r.write32(pointer, Number(signed ? BigInt.asIntN(32, value) : low));
  }
  return ok(0, argc);
}
// A double/float destination. The value goes to memory, not to a register, so
// this is the one place where the CRT's scanning and formatting differ in ABI.
function storeFloat(r, pointer, value, length, argc) {
  if (length === 'l' || length === 'L') {
    // long double in the MSVC layout is the x87 80-bit extended form, 10 bytes
    // padded to 16 in an array; printf-family floats keep the same width.
    r.check(pointer, 16, true);
    r.data.fill(0, pointer, pointer + 16);
    const view = new DataView(r.data.buffer, r.data.byteOffset + pointer, 10);
    writeExtended80(view, value);
  } else if (length === 'h') {
    // `%hf`/`%hF` are the float forms MSVC added for C99 compatibility.
    r.check(pointer, 4, true);
    new DataView(r.data.buffer, r.data.byteOffset + pointer, 4).setFloat32(0, value, true);
  } else {
    r.check(pointer, 8, true);
    r.view.setFloat64(pointer, value, true);
  }
  return ok(0, argc);
}
// Encode a double into the 10-byte x87 extended format the MSVC long double
// uses, at the layout `fld`/`fstp` expect.
function writeExtended80(view, value) {
  if (value === 0) {
    view.setUint8(0, 0);
    return;
  }
  const negative = value < 0;
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude)) {
    view.setBigUint64(0, magnitude > 0 ? 0x8000000000000000n : 0xc000000000000000n, true);
    view.setUint16(8, 0x7fff, true);
    return;
  }
  let exponent = Math.floor(Math.log2(magnitude));
  let mantissa = magnitude / 2 ** exponent;
  // Normalize into [1, 2) and take 64 explicit significand bits.
  const significand = BigInt(Math.round(mantissa * 2 ** 63));
  view.setBigUint64(0, significand, true);
  view.setUint16(8, (exponent + 16383) | (negative ? 0x8000 : 0), true);
}

// The conversion characters that consume no assignment destination.
const ASSIGNABLE = 'diouxXeEfFgGaAcspn';
// Numeric conversions and the base each one implies; `i` accepts a prefix.
const INTEGER_BASES = { d: 10, u: 10, i: 0, o: 8, x: 16, X: 16 };
const FLOAT_CONVERSIONS = 'eEfFgGaA';

function isDigitCode(code) {
  return code !== null && code >= 0x30 && code <= 0x39;
}
function digitValue(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41 + 10;
  return -1;
}
function setForCodes(text) {
  const set = new Set();
  let index = 0;
  let negate = false;
  if (text[index] === '^') {
    negate = true;
    index++;
  }
  if (text[index] === ']') {
    set.add(0x5d);
    index++;
  }
  for (; index < text.length && text[index] !== ']'; index++) {
    if (text[index] === '-' && index > 0 && text[index + 1] && text[index + 1] !== ']') {
      for (
        let code = text[index - 1].charCodeAt(0) + 1;
        code <= text[index + 1].charCodeAt(0);
        code++
      )
        set.add(code);
      index++;
    } else set.add(text[index].charCodeAt(0));
  }
  return { set, negate, next: index };
}
// One conversion's parsed shape: `%` [*] [width] [length] conversion.
function parseSpecification(format, index) {
  let i = index + 1;
  const suppression = format[i] === '*';
  if (suppression) i++;
  let width = '';
  while (i < format.length && format[i] >= '0' && format[i] <= '9') width += format[i++];
  let length = '';
  const two = format.slice(i, i + 2);
  if (two === 'hh' || two === 'll') {
    length = two;
    i += 2;
  } else if (format.slice(i, i + 3) === 'I64' || format.slice(i, i + 3) === 'I32') {
    length = format.slice(i, i + 3);
    i += 3;
  } else if ('hlLjzt'.includes(format[i] || '')) {
    length = format[i++];
  }
  const conversion = format[i] || '';
  return {
    suppression,
    width: width ? Number.parseInt(width, 10) : 0,
    length,
    conversion,
    next: i + 1,
  };
}
// Consumes a run matching the set (or not matching, when negated), bounded by
// the field width. Reports the consumed codes so the caller can store them.
function scanSet(cursor, set, negate, width) {
  const taken = [];
  while (taken.length < (width || MAX_FIELD)) {
    const code = cursor.peek();
    if (code === null) break;
    if (set.has(code) === negate) break;
    taken.push(code);
    cursor.next();
  }
  return taken;
}
// Skips input whitespace the way every non-`c`/`[`/`n` conversion does.
function skipWhitespace(cursor) {
  while (WHITESPACE.has(cursor.peek())) cursor.next();
}
// Reads an optionally signed integer in the given base (0 means "infer").
function scanInteger(cursor, bases, width) {
  const taken = [];
  if (cursor.peek() === 0x2b || cursor.peek() === 0x2d) taken.push(cursor.next());
  let radix = bases;
  const length = () => taken.length < (width || MAX_FIELD);
  if ((bases === 16 || bases === 0) && cursor.peek() === 0x30 && length()) {
    const save = cursor.position;
    taken.push(cursor.next());
    const marker = cursor.peek();
    if (marker === 0x78 || marker === 0x58) {
      taken.push(cursor.next());
      radix = 16;
    } else {
      radix = bases === 0 ? 8 : bases;
      cursor.position = save;
      taken.pop();
    }
  }
  let digits = 0;
  while (length()) {
    const value = digitValue(cursor.peek());
    if (value < 0 || value >= radix) break;
    taken.push(cursor.next());
    digits++;
  }
  if (!digits) return null;
  return codesToText(taken);
}
// The float grammar: sign, digits with an optional point, an optional exponent.
function scanFloat(cursor, width) {
  const taken = [];
  const limit = () => taken.length < (width || MAX_FIELD);
  if ((cursor.peek() === 0x2b || cursor.peek() === 0x2d) && limit()) taken.push(cursor.next());
  let digits = 0;
  while (isDigitCode(cursor.peek()) && limit()) {
    taken.push(cursor.next());
    digits++;
  }
  if (cursor.peek() === 0x2e && limit()) {
    taken.push(cursor.next());
    while (isDigitCode(cursor.peek()) && limit()) {
      taken.push(cursor.next());
      digits++;
    }
  }
  if (!digits) return null;
  const exponent = cursor.peek();
  if ((exponent === 0x65 || exponent === 0x45) && limit()) {
    const save = taken.length;
    taken.push(cursor.next());
    let exponentDigits = 0;
    if ((cursor.peek() === 0x2b || cursor.peek() === 0x2d) && limit()) taken.push(cursor.next());
    while (isDigitCode(cursor.peek()) && limit()) {
      taken.push(cursor.next());
      exponentDigits++;
    }
    if (!exponentDigits) {
      // An `e` with no exponent is part of the next conversion's input.
      while (taken.length > save) {
        taken.pop();
        cursor.unget();
      }
    }
  }
  return codesToText(taken);
}

// Where one conversion's result goes. A suppressed conversion consumes input
// but stores nothing, which is why the destination is resolved lazily.
function storeCodes(r, pointer, codes, destinationWide, terminate) {
  const unit = destinationWide ? 2 : 1;
  const total = codes.length + (terminate ? 1 : 0);
  r.check(pointer, total * unit, true);
  for (let i = 0; i < codes.length; i++) {
    if (destinationWide) r.guestMemory.write(pointer + i * 2, codes[i], 2);
    else r.data[pointer + i] = codes[i] & 0xff;
  }
  if (terminate) {
    if (destinationWide) r.guestMemory.write(pointer + codes.length * 2, 0, 2);
    else r.data[pointer + codes.length] = 0;
  }
}
// Whether a conversion's `l`/`L` modifier makes the *destination* wide. In the
// ANSI forms `%ls` writes wchar_t; in the wide forms `%s` already does, and
// `%hs` is the narrow one.
function destinationWide(scanWide, length) {
  if (scanWide) return length !== 'h';
  return length === 'l' || length === 'L';
}
// Runs one format string over `codes`, storing through the varargs block that
// `valuePointer` addresses. Returns the number of assignments, or EOF when the
// first directive failed on empty input.
function runScan(r, codes, format, scanWide, valuePointer) {
  const cursor = cursorOf(codes);
  let assigned = 0;
  let failed = false;
  let index = 0;
  // C99 7.19.6.2: an input failure before the first conversion reports EOF,
  // while a conversion that simply does not match the available input reports
  // the number of assignments (zero, when nothing was assigned).
  const inputEmpty = codes.length === 0;
  const nextDestination = () => {
    const pointer = r.read32(valuePointer) >>> 0;
    valuePointer += 4;
    return pointer;
  };
  while (index < format.length && !failed) {
    const character = format[index];
    if (WHITESPACE.has(character.charCodeAt(0))) {
      // Format whitespace matches any run of input whitespace, including none.
      while (WHITESPACE.has(cursor.peek())) cursor.next();
      index++;
      continue;
    }
    if (character !== '%') {
      if (cursor.peek() !== character.charCodeAt(0)) {
        failed = true;
        break;
      }
      cursor.next();
      index++;
      continue;
    }
    if (format[index + 1] === '%') {
      if (cursor.peek() !== 0x25) {
        failed = true;
        break;
      }
      cursor.next();
      index += 2;
      continue;
    }
    const spec = parseSpecification(format, index);
    index = spec.next;
    const conversion = spec.conversion;
    if (conversion === 'n') {
      // %n reports how much input has been consumed; the conversion counts as an
      // assignment but consumes nothing.
      if (!spec.suppression)
        storeInteger(r, nextDestination(), BigInt(cursor.position), spec.length, true, 0);
      assigned++;
      continue;
    }
    if (conversion === 'c' || conversion === 's' || conversion === '[') {
      let taken;
      if (conversion === 'c') {
        // %c reads exactly `width` characters (default 1) and adds no NUL.
        const count = spec.width || 1;
        taken = [];
        for (let i = 0; i < count; i++) {
          const code = cursor.next();
          if (code === null) break;
          taken.push(code);
        }
        if (!taken.length) {
          failed = true;
          break;
        }
      } else if (conversion === 's') {
        skipWhitespace(cursor);
        taken = [];
        const limit = spec.width || MAX_FIELD;
        while (taken.length < limit) {
          const code = cursor.peek();
          if (code === null || WHITESPACE.has(code)) break;
          taken.push(code);
          cursor.next();
        }
        if (!taken.length) {
          failed = true;
          break;
        }
      } else {
        // the `[` set: the bracket contents start right after the conversion.
        const parsed = setForCodes(format.slice(index));
        taken = scanSet(cursor, parsed.set, parsed.negate, spec.width);
        index += parsed.next + 1;
        if (!taken.length) {
          failed = true;
          break;
        }
      }
      if (!spec.suppression) {
        storeCodes(
          r,
          nextDestination(),
          taken,
          destinationWide(scanWide, spec.length),
          conversion !== 'c',
        );
        assigned++;
      }
      continue;
    }
    const bases = INTEGER_BASES[conversion];
    if (bases !== undefined || conversion === 'p') {
      skipWhitespace(cursor);
      const text = scanInteger(cursor, conversion === 'p' ? 16 : bases, spec.width);
      if (text === null) {
        failed = true;
        break;
      }
      const unsigned = 'uoxXp'.includes(conversion);
      const value = parseScannedInteger(text, conversion === 'p' ? 16 : bases, unsigned);
      if (!spec.suppression) {
        storeInteger(r, nextDestination(), value, spec.length, !unsigned, 0);
        assigned++;
      }
      continue;
    }
    if (FLOAT_CONVERSIONS.includes(conversion)) {
      skipWhitespace(cursor);
      const text = scanFloat(cursor, spec.width);
      if (text === null) {
        failed = true;
        break;
      }
      if (!spec.suppression) {
        storeFloat(r, nextDestination(), Number.parseFloat(text), spec.length, 0);
        assigned++;
      }
      continue;
    }
    // An unknown conversion is a malformed format string, not a silent skip.
    throw Error(`Unsupported scanf conversion '%${conversion}'`);
  }
  return {
    assigned,
    failed,
    // Wine reads one character before it examines the format at all, so only an
    // input that is already empty at that point is an input failure. A
    // conversion that cannot match non-empty input is a matching failure, which
    // reports the assignment count instead.
    eof: inputEmpty && format.length > 0 && assigned === 0,
    consumed: cursor.position,
  };
}
// Text produced by scanInteger -> the numeric value, honouring the base prefix
// the scanner consumed and clamping to the destination's own width.
function parseScannedInteger(text, bases, unsigned) {
  let negative = false;
  let body = text;
  if (body[0] === '+' || body[0] === '-') {
    negative = body[0] === '-';
    body = body.slice(1);
  }
  let radix = bases === 0 ? 10 : bases;
  if ((bases === 16 || bases === 0) && body.startsWith('0x')) radix = 16;
  else if (bases === 0 && body.startsWith('0')) radix = 8;
  let value = 0n;
  for (const character of body.startsWith('0x') && radix === 16 ? body.slice(2) : body) {
    const digit = Number.parseInt(character, radix);
    if (Number.isNaN(digit)) break;
    value = value * BigInt(radix) + BigInt(digit);
  }
  if (negative) value = -value;
  return unsigned ? BigInt.asUintN(32, value) : value;
}
// The format string's width follows the entry point: the wide forms take a
// UTF-16 format, the ANSI ones bytes.
function readFormat(r, pointer, scanWide) {
  return scanWide ? r.wideString(pointer) : r.string(pointer);
}
// The public result of one scan: EOF for an input failure, otherwise the number
// of assignments (C99 7.19.6.2).
function scanResult(result) {
  return result.eof ? EOF : result.assigned;
}
// The va_list a `...` block starts at, given how many named arguments precede it.
function varargsPointer(r, namedArguments) {
  return (r.cpu.r[4].value >>> 0) + (namedArguments + 1) * 4;
}
export function registerScanf(apis, { streamFor, standardStreams, touchRead }) {
  const add = (name, handler) => {
    if (apis[`msvcrt.dll!${name}`]) return;
    apis[`msvcrt.dll!${name}`] = async (r, a) => ({
      result: (await handler(r, a)) | 0,
      argc: 0,
      convention: 'cdecl',
    });
  };
  // One string-scanning entry point: the input is the first argument (after an
  // optional maximum count) and the format follows it.
  const scanString = (name, scanWide, { lengthIndex }) => {
    const formatIndex = lengthIndex === null ? 1 : 2;
    const named = formatIndex + 1;
    add(name, (r, a) => {
      const input = a(0);
      if (!input) return EOF;
      let codes = stringCodes(r, input, scanWide);
      if (lengthIndex !== null) codes = codes.slice(0, a(lengthIndex) >>> 0);
      return scanResult(
        runScan(
          r,
          codes,
          readFormat(r, a(formatIndex), scanWide),
          scanWide,
          varargsPointer(r, named),
        ),
      );
    });
    // The matching `v` form takes the va_list as the last named argument.
    add(`${name.startsWith('_') ? `_v${name.slice(1)}` : `v${name}`}`, (r, a) => {
      const input = a(0);
      if (!input) return EOF;
      let codes = stringCodes(r, input, scanWide);
      if (lengthIndex !== null) codes = codes.slice(0, a(lengthIndex) >>> 0);
      return scanResult(
        runScan(r, codes, readFormat(r, a(formatIndex), scanWide), scanWide, a(named - 1)),
      );
    });
  };
  // sscanf(input, format, ...) and swscanf(input, format, ...).
  scanString('sscanf', false, { lengthIndex: null });
  scanString('swscanf', true, { lengthIndex: null });
  scanString('_snscanf', false, { lengthIndex: 1 });
  scanString('_snwscanf', true, { lengthIndex: 1 });
  scanString('sscanf_s', false, { lengthIndex: null });
  scanString('swscanf_s', true, { lengthIndex: null });
  scanString('_snscanf_s', false, { lengthIndex: 1 });
  scanString('_snwscanf_s', true, { lengthIndex: 1 });
  // The locale forms add a locale_t after the format.
  for (const [name, scanWide] of [
    ['_sscanf_l', false],
    ['_swscanf_l', true],
    ['_sscanf_s_l', false],
    ['_swscanf_s_l', true],
  ]) {
    add(name, (r, a) => {
      const input = a(0);
      if (!input) return EOF;
      const codes = stringCodes(r, input, scanWide);
      return scanResult(
        runScan(r, codes, readFormat(r, a(1), scanWide), scanWide, varargsPointer(r, 3)),
      );
    });
  }
  // The stream forms read the rest of the caller's stream and commit only the
  // bytes the scanner consumed, which is what fscanf's file-position contract
  // requires. Nothing beyond the last successful conversion is eaten.
  const streamInput = (r, stream, scanWide) => {
    const bytes = r.files.get(stream.path) ?? new Uint8Array();
    const codes = [];
    for (let i = stream.position; i < bytes.length; i++) {
      codes.push(scanWide ? bytes[i] : bytes[i]);
    }
    return {
      codes,
      commit: (count) => {
        stream.position += count;
        stream.eof = false;
        touchRead(r, stream.path);
      },
    };
  };
  const scanStream = (name, scanWide, { formatIndex, named, withLocale }) => {
    add(name, (r, a) => {
      const stream = streamFor(r, a(0));
      if (!stream || !stream.open) return EOF;
      if (stream.standard === 'stdin') {
        stream.eof = true;
        return EOF;
      }
      const input = streamInput(r, stream, scanWide);
      const result = runScan(
        r,
        input.codes,
        readFormat(r, a(formatIndex), scanWide),
        scanWide,
        varargsPointer(r, withLocale ? named + 1 : named),
      );
      input.commit(result.consumed);
      return scanResult(result);
    });
  };
  scanStream('fscanf', false, { formatIndex: 1, named: 2, withLocale: false });
  scanStream('fwscanf', true, { formatIndex: 1, named: 2, withLocale: false });
  scanStream('fscanf_s', false, { formatIndex: 1, named: 2, withLocale: false });
  scanStream('fwscanf_s', true, { formatIndex: 1, named: 2, withLocale: false });
  scanStream('_fscanf_l', false, { formatIndex: 1, named: 2, withLocale: true });
  scanStream('_fwscanf_l', true, { formatIndex: 1, named: 2, withLocale: true });
  scanStream('_fscanf_s_l', false, { formatIndex: 1, named: 2, withLocale: true });
  scanStream('_fwscanf_s_l', true, { formatIndex: 1, named: 2, withLocale: true });
  // The console forms read stdin, which the headless runtime models as empty.
  for (const name of [
    'scanf',
    'wscanf',
    'scanf_s',
    'wscanf_s',
    '_scanf_l',
    '_wscanf_l',
    '_scanf_s_l',
    '_wscanf_s_l',
  ])
    add(name, () => EOF);
  for (const name of [
    '_cscanf',
    '_cwscanf',
    '_cscanf_l',
    '_cwscanf_l',
    '_cscanf_s',
    '_cwscanf_s',
    '_cscanf_s_l',
    '_cwscanf_s_l',
  ])
    add(name, () => EOF);
}
