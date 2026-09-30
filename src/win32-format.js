// Keep formatting semantics in Wine guest code. These adapters only translate
// the caller's x86 varargs stack to Wine's va_list entry point and preserve ABI.
//
// The Wine body is user32's *stdcall* `wvsprintfA/W`, which pops its three
// arguments itself. A guest entry point the ABI marks cdecl — Wine's
// msvcrt.spec lists `vsprintf`, `vswprintf` and the `vsnprintf`/`_snprintf`
// family as `@ cdecl`, and the `@ varargs` forms (`sprintf`, `swprintf`,
// `_snprintf`, `sprintf_s`) are cleaned up by the caller — must not have those
// words removed a second time: the runtime already leaves a cdecl caller's stack
// alone. Declaring the wrong convention pops words that belong to the caller and
// corrupts the stack of every program that used the function.
//
// On entry the thunk has not yet popped the return address, so ESP points at it:
// the first argument is at ESP+4, the nth at ESP+4+n*4, and the `...` block
// begins just past the last named argument.
const FORMAT_CAPACITY = 1024; // user32's wsprintf A/W output limit.

// The guest body, resolved once per runtime. It is the unchanged Wine function,
// not a reimplementation.
async function formatterAddress(r, wide) {
  const symbol = `wvsprintf${wide ? 'W' : 'A'}`;
  r.wineFormatExports ??= new Map();
  const cached = r.wineFormatExports.get(symbol);
  if (cached !== undefined) return cached;
  if (!r.wineFormatModule) {
    await r.loadLibrary('wine-format.dll');
    r.wineFormatModule = r.graph.modules.get('wine-format.dll');
  }
  const address = await r.resolveExport(r.wineFormatModule, symbol);
  r.wineFormatExports.set(symbol, address);
  return address;
}

// Formats through the Wine body into a scratch buffer and reads the text back, so
// the bounded entry points can apply their own size rules to real output. A
// result of exactly FORMAT_CAPACITY means the formatted text is at least that
// long (the body caps its output), which is the ceiling every variant shares.
async function wineFormatText(r, wide, spec, valuePointer) {
  r.wineFormatScratch ??= new Map();
  if (!r.wineFormatScratch.has(wide))
    r.wineFormatScratch.set(wide, r.allocate(FORMAT_CAPACITY * (wide ? 2 : 1)));
  const scratch = r.wineFormatScratch.get(wide);
  const address = await formatterAddress(r, wide);
  const written = (await r.callGuest(address, [scratch, spec, valuePointer])) | 0;
  const codes = [];
  for (let i = 0; i < FORMAT_CAPACITY; i++) {
    const code = wide ? r.guestMemory.read(scratch + i * 2, 2) : r.data[scratch + i];
    if (!code) break;
    codes.push(code);
  }
  return { codes, truncated: written >= FORMAT_CAPACITY };
}

// The stream entry points (printf/fprintf and their wide forms) live in
// msvcrt.js, which owns the FILE* table; they only need the formatter body's
// text, so expose that step instead of duplicating the Wine call.
export async function formatText(r, wide, spec, valuePointer) {
  return wineFormatText(r, wide, spec, valuePointer);
}

// The va_list a `...` block starts at for an entry point with `named` named
// arguments: ESP still points at the return address when a thunk runs.
export function variadicPointer(r, named) {
  return (r.cpu.r[4].value >>> 0) + (named + 1) * 4;
}

// Writes `codes` into a guest buffer with the caller's capacity, following the
// CRT's contract: at most capacity-1 characters and always a terminator.
function writeBounded(r, buffer, capacity, codes, limit = capacity - 1, wide = false) {
  const count = Math.min(codes.length, Math.max(0, limit));
  for (let i = 0; i < count; i++) {
    if (wide) r.guestMemory.write(buffer + i * 2, codes[i], 2);
    else r.data[buffer + i] = codes[i] & 0xff;
  }
  if (wide) r.guestMemory.write(buffer + count * 2, 0, 2);
  else r.data[buffer + count] = 0;
  return count;
}

export async function format(
  r,
  a,
  wide,
  {
    variadic = false,
    fixedArguments = variadic ? 2 : 3,
    convention = variadic ? 'cdecl' : 'stdcall',
  },
) {
  const args = [a(0), a(1), variadic ? (r.cpu.r[4].value >>> 0) + (fixedArguments + 1) * 4 : a(2)];
  return {
    result: await r.callGuest(await formatterAddress(r, wide), args),
    // A cdecl caller removes its own arguments, so the handler must not.
    argc: convention === 'cdecl' ? 0 : fixedArguments,
    convention,
  };
}

// `_snprintf`-family semantics, which Wine's msvcrt implements in wcs.c: the
// result is always NUL-terminated, and the return value is the length the
// formatted text would have had, so a caller can size its buffer and retry.
async function boundedSnprintf(r, wide, { buffer, capacity, spec, valuePointer }) {
  if (capacity === 0) return -1;
  const { codes, truncated } = await wineFormatText(r, wide, spec, valuePointer);
  writeBounded(r, buffer, capacity, codes, capacity - 1, wide);
  return truncated ? FORMAT_CAPACITY : codes.length;
}

// `_snprintf_s`/`_vsnprintf_s`: a size-checked form that reports ERANGE and
// clears the destination rather than returning a truncated string.
async function boundedSnprintfS(r, wide, { buffer, sizeOfBuffer, count, spec, valuePointer }) {
  if (!sizeOfBuffer) return -1;
  const truncate = count === 0xffffffff; // _TRUNCATE
  // Wine's rule: write at most `count + 1` bytes, or the whole buffer when the
  // caller asked to truncate.
  const limit = truncate || sizeOfBuffer < count + 1 ? sizeOfBuffer : count + 1;
  const { codes, truncated } = await wineFormatText(r, wide, spec, valuePointer);
  const length = truncated ? FORMAT_CAPACITY : codes.length;
  if (length >= limit) {
    if (!truncate && count > sizeOfBuffer) {
      // Too small even for the requested prefix: report ERANGE and clear it.
      r.data.fill(0, buffer, buffer + sizeOfBuffer * (wide ? 2 : 1));
      return 0x22; // ERANGE
    }
    writeBounded(r, buffer, limit, codes, limit - 1, wide);
    return -1;
  }
  writeBounded(r, buffer, limit, codes, length, wide);
  return length;
}

// `sprintf_s`/`vsprintf_s`: the buffer must hold the whole result. An undersized
// one is cleared and reported, never silently truncated.
async function boundedSprintfS(r, wide, { buffer, sizeOfBuffer, spec, valuePointer }) {
  if (!sizeOfBuffer) return -1;
  const { codes, truncated } = await wineFormatText(r, wide, spec, valuePointer);
  const length = truncated ? FORMAT_CAPACITY : codes.length;
  if (length >= sizeOfBuffer) {
    r.data.fill(0, buffer, buffer + sizeOfBuffer * (wide ? 2 : 1));
    return 0x22; // ERANGE
  }
  writeBounded(r, buffer, sizeOfBuffer, codes, length, wide);
  return length;
}

export const formatApis = {};
for (const wide of [false, true]) {
  const suffix = wide ? 'W' : 'A';
  // wsprintfA/W are varargs (cdecl); wvsprintfA/W take a va_list and are stdcall.
  formatApis[`user32.dll!wsprintf${suffix}`] = (r, a) => format(r, a, wide, { variadic: true });
  formatApis[`user32.dll!wvsprintf${suffix}`] = (r, a) => format(r, a, wide, {});
}

// The msvcrt printf family shares the same real Wine body. Its exports carry no
// A/W suffix — the ANSI and wide forms are distinct names (`sprintf` and
// `swprintf`) — and msvcrt.spec marks the `v`/`_v` forms `@ cdecl` and the
// varargs forms cleaned up by the caller, so the adapter reports cdecl for all of
// them. Argument order and the bounded size rules follow Wine's msvcrt.spec and
// the implementations in its wcs.c.
const cdecl = { convention: 'cdecl' };
const ansiNames = {
  sprintf: { variadic: true },
  vsprintf: { fixedArguments: 3 },
  vsnprintf: { fixedArguments: 4 },
  _vsnprintf: { fixedArguments: 4 },
  snprintf: { fixedArguments: 4 },
  _snprintf: { fixedArguments: 4 },
};
const wideNames = {
  swprintf: { variadic: true },
  _swprintf: { variadic: true },
  vswprintf: {},
  _vswprintf: {},
};
for (const [name, plan] of Object.entries(ansiNames))
  formatApis[`msvcrt.dll!${name}`] = (r, a) => format(r, a, false, { ...cdecl, ...plan });
for (const [name, plan] of Object.entries(wideNames))
  formatApis[`msvcrt.dll!${name}`] = (r, a) => format(r, a, true, { ...cdecl, ...plan });

// Bounded variants. Each entry names the argument index of its buffer, size and
// optional count, the format string, and how many named arguments precede the
// `...` block (a locale_t sits between the format and the varargs in the `_l`
// forms, and the runtime has one locale). Signatures are Wine's msvcrt.spec and
// the `_snprintf` family in its wcs.c.
const bounded = [
  // name, wide, rule, buffer, size, count, format, namedArguments
  ['_snprintf', false, 'snprintf', 0, 1, null, 2, 3],
  ['_snprintf_c', false, 'snprintf', 0, 1, null, 2, 3],
  ['_snprintf_l', false, 'snprintf', 0, 1, null, 2, 4],
  ['_snprintf_s', false, 'snprintf_s', 0, 1, 2, 3, 4],
  ['_snprintf_s_l', false, 'snprintf_s', 0, 1, 2, 3, 5],
  ['sprintf_s', false, 'sprintf_s', 0, 1, null, 2, 3],
  ['swprintf_s', true, 'sprintf_s', 0, 1, null, 2, 3],
  ['_swprintf_c', true, 'snprintf', 0, 1, null, 2, 3],
  ['_swprintf_s_l', true, 'sprintf_s', 0, 1, null, 2, 4],
  // The `v` forms take a va_list argument instead of a `...` block.
  ['_vsnprintf_s', false, 'snprintf_s', 0, 1, 2, 3, 5],
  ['vsprintf_s', false, 'sprintf_s', 0, 1, null, 2, 4],
];
for (const [
  name,
  wide,
  kind,
  bufferIndex,
  sizeIndex,
  countIndex,
  specIndex,
  namedArguments,
] of bounded) {
  const variadic = !name.startsWith('_v') && !name.startsWith('v');
  formatApis[`msvcrt.dll!${name}`] = (r, a) =>
    formatBounded(r, wide, {
      variadic,
      kind,
      buffer: a(bufferIndex),
      size: sizeIndex === null ? 0 : a(sizeIndex) >>> 0,
      count: countIndex === null ? 0 : a(countIndex) >>> 0,
      spec: a(specIndex),
      namedArguments,
      // The va_list, when the entry point takes one, is the last named argument.
      valuePointer: a(namedArguments - 1),
    });
}

// Shared adapter for the bounded entry points: it locates the va_list (either the
// caller's `...` block or a named argument), dispatches on the size rule, and
// reports cdecl so the caller's own cleanup is preserved.
async function formatBounded(r, wide, plan) {
  const valuePointer = plan.variadic
    ? (r.cpu.r[4].value >>> 0) + (plan.namedArguments + 1) * 4
    : plan.valuePointer;
  const handler =
    plan.kind === 'snprintf'
      ? boundedSnprintf
      : plan.kind === 'snprintf_s'
        ? boundedSnprintfS
        : boundedSprintfS;
  const result = await handler(r, wide, {
    buffer: plan.buffer,
    capacity: plan.size ?? 0,
    sizeOfBuffer: plan.size ?? 0,
    count: plan.count ?? 0,
    spec: plan.spec,
    valuePointer,
  });
  return { result: result | 0, argc: 0, convention: 'cdecl' };
}
