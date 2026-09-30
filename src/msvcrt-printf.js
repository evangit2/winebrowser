// The printf-family entry points that name a stream rather than a buffer:
// printf/fprintf/vprintf/vfprintf and their wide, _s and _sc forms. They reuse
// the same Wine formatter body as the buffer forms (win32-format.js) and differ
// only in where the text goes — stdout, a caller's FILE*, or nowhere when the
// caller is asking for the length.
//
// Argument layouts are from msvcrt.spec: printf(fmt, ...), fprintf(stream, fmt,
// ...), vprintf(fmt, va), vfprintf(stream, fmt, va), with the wide forms taking
// a UTF-16 format string. All of them are cdecl, so the caller removes its own
// arguments and the handler reports argc 0.
import { encodeAnsi } from './encoding.js';
import { formatText, variadicPointer } from './win32-format.js';

const FORMAT_CAPACITY_LIMIT = 1024; // the Wine body's own output ceiling.
const ok = (result = 0, argc = 0) => ({ result, argc });

export function registerStreamPrintf(
  apis,
  { streamFor, standardStreams, writeStream, errnoCell, fputc, fgetc },
) {
  const consoleStream = (r) => streamFor(r, standardStreams(r).addresses[1]);
  // Emits `codes` to a stream. The wide form narrows each UTF-16 unit to one
  // byte for the byte-oriented console and files the runtime models; a unit with
  // no single-byte representation becomes `?` rather than being dropped.
  const writeFormatted = (r, stream, codes, wide) => {
    if (!stream || !stream.open) return -1;
    const bytes = wide
      ? Uint8Array.from(codes, (code) =>
          code < 0x80 ? code : encodeAnsi(String.fromCharCode(code), 0x3f).bytes[0],
        )
      : Uint8Array.from(codes, (code) => code & 0xff);
    return writeStream(r, stream, bytes);
  };
  // One entry point's work: format through Wine's body, then either write the
  // text or (for the _sc forms) report its length.
  const streamFormat = async (r, wide, { stream, spec, valuePointer, countOnly }) => {
    const { codes, truncated } = await formatText(r, wide, spec, valuePointer);
    const length = truncated ? FORMAT_CAPACITY_LIMIT : codes.length;
    if (countOnly) return length;
    const target = stream === undefined ? consoleStream(r) : streamFor(r, stream);
    return writeFormatted(r, target, codes, wide) < 0 ? -1 : length;
  };
  // Every entry point here is cdecl and leaves the caller's arguments alone, so
  // the response reports argc 0 and the formatted length as the result.
  const add = (name, handler) => {
    if (apis[`msvcrt.dll!${name}`]) return;
    apis[`msvcrt.dll!${name}`] = async (r, a) => ({
      result: (await handler(r, a)) | 0,
      argc: 0,
      convention: 'cdecl',
    });
  };
  // Every variadic form reads its `...` block from the caller's stack past the
  // named arguments; the va_list forms take the list as a named argument. The
  // wide entry points are the `w`-prefixed names (wprintf, fwprintf, ...), a
  // distinct spelling from the ANSI ones rather than an A/W suffix.
  const plans = [
    {
      wide: false,
      printf: 'printf',
      printfS: 'printf_s',
      scprintf: '_scprintf',
      vprintf: 'vprintf',
      vprintfS: 'vprintf_s',
      vscprintf: '_vscprintf',
      fprintf: 'fprintf',
      fprintfS: 'fprintf_s',
      vfprintf: 'vfprintf',
      vfprintfS: 'vfprintf_s',
      fprintfL: '_fprintf_l',
    },
    {
      wide: true,
      printf: 'wprintf',
      printfS: 'wprintf_s',
      scprintf: '_scwprintf',
      vprintf: 'vwprintf',
      vprintfS: 'vwprintf_s',
      vscprintf: '_vscwprintf',
      fprintf: 'fwprintf',
      fprintfS: 'fwprintf_s',
      vfprintf: 'vfwprintf',
      vfprintfS: 'vfwprintf_s',
      fprintfL: '_fwprintf_l',
    },
  ];
  for (const plan of plans) {
    const { wide } = plan;
    const variadic =
      (spec, named, rest = {}) =>
      (r, a) =>
        streamFormat(r, wide, { ...rest, spec: a(spec), valuePointer: variadicPointer(r, named) });
    const fromList =
      (spec, list, rest = {}) =>
      (r, a) =>
        streamFormat(r, wide, { ...rest, spec: a(spec), valuePointer: a(list) });
    add(plan.printf, variadic(0, 1));
    add(plan.printfS, variadic(0, 1));
    add(plan.scprintf, variadic(0, 1, { countOnly: true }));
    add(plan.vprintf, fromList(0, 1));
    add(plan.vprintfS, fromList(0, 1));
    add(plan.vscprintf, fromList(0, 1, { countOnly: true }));
    // fprintf/vfprintf name their stream as the first argument.
    for (const form of [plan.fprintf, plan.fprintfS])
      add(form, (r, a) =>
        streamFormat(r, wide, { stream: a(0), spec: a(1), valuePointer: variadicPointer(r, 2) }),
      );
    for (const form of [plan.vfprintf, plan.vfprintfS])
      add(form, (r, a) => streamFormat(r, wide, { stream: a(0), spec: a(1), valuePointer: a(2) }));
    // The `_l` stream forms add a locale_t between the format and the varargs.
    add(plan.fprintfL, (r, a) =>
      streamFormat(r, wide, { stream: a(0), spec: a(1), valuePointer: variadicPointer(r, 3) }),
    );
  }
  // The single-character stream forms.
  add('putc', fputc);
  add('getc', fgetc);
  add('putwchar', (r, a) =>
    fputc(r, (index) => (index === 0 ? a(0) : standardStreams(r).addresses[1]), 2),
  );
  add('getwchar', (r) =>
    fgetc(r, (index) => (index === 0 ? standardStreams(r).addresses[0] : 0), 1),
  );
  add('getchar', (r) =>
    fgetc(r, (index) => (index === 0 ? standardStreams(r).addresses[0] : 0), 1),
  );
  add('fputchar', (r, a) =>
    fputc(r, (index) => (index === 0 ? a(0) : standardStreams(r).addresses[1]), 2),
  );
  // _putch/_putwch write one character to the console and return it.
  add('_putch', (r, a) => {
    writeStream(r, consoleStream(r), Uint8Array.of(a(0) & 0xff));
    return ok(a(0) & 0xff, 1);
  });
  add('_putwch', (r, a) => {
    writeStream(r, consoleStream(r), Uint8Array.of(a(0) & 0xff));
    return ok(a(0) & 0xffff, 1);
  });
  // _putws writes a wide string to the console.
  add('_putws', (r, a) => {
    const text = r.wideString(a(0));
    writeFormatted(
      r,
      consoleStream(r),
      [...text].map((character) => character.charCodeAt(0)),
      true,
    );
    return ok(0, 1);
  });
  // ungetc cannot push a character back into the virtual files the runtime
  // models; reporting EOF is the documented failure rather than a silent lie.
  add('ungetc', () => ok(0xffffffff, 2));
  add('ungetwc', () => ok(0xffffffff, 2));
  // perror prints the caller's prefix, a colon and the current error text.
  for (const wide of [false, true]) {
    add(wide ? '_wperror' : 'perror', (r, a) => {
      const prefix = a(0) ? (wide ? r.wideString(a(0)) : r.string(a(0))) : '';
      const code = r.read32(errnoCell(r, 'errno')) | 0;
      const text = `${prefix ? `${prefix}: ` : ''}Error ${code}\n`;
      writeStream(r, streamFor(r, standardStreams(r).addresses[2]), encodeAnsi(text).bytes);
      return ok(0, 1);
    });
  }
  // Buffering hints are accepted and ignored: the runtime's streams are written
  // through immediately, which is a legal unbuffered implementation.
  add('setvbuf', () => ok(0, 4));
  add('setbuf', () => ok(0, 2));
  add('_setmaxstdio', (r, a) => ok(a(0), 1));
  add('_getmaxstdio', () => ok(512, 0));
  add('_flushall', () => ok(0, 0));
  add('_fcloseall', () => ok(0, 0));
}
