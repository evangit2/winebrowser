// Browser host services needed by ordinary PE startup and Wine's guest helpers.
// This file owns no guest instruction execution or PE parsing.
const ok = (result = 0, argc = 0) => ({ result, argc });
const fail = (r, error, argc = 0) => {
  r.lastError = error;
  return ok(0, argc);
};
function writeString(r, address, value, wide = false) {
  for (let i = 0; i <= value.length; i++)
    r.guestMemory.write(
      address + i * (wide ? 2 : 1),
      i === value.length ? 0 : value.charCodeAt(i),
      wide ? 2 : 1,
    );
  return address;
}
export function quoteArgument(value) {
  if (value && !/[\s"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
function moduleHandle(r, a, wide) {
  if (!a(0)) return ok(r.pe.imageBase, 1);
  const name = (wide ? r.wideString(a(0)) : r.string(a(0)))
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .toLowerCase();
  const module = r.graph.modules.get(name) || r.graph.modules.get(name + '.dll');
  return module ? ok(module.base, 1) : fail(r, 126, 1);
}
async function procAddress(r, a) {
  const module = [...r.graph.modules.values()].find((m) => m.base === a(0));
  if (!module) return fail(r, 6, 2);
  const symbol = a(1) < 65536 ? a(1) : r.string(a(1));
  try {
    return ok(await r.resolveExport(module, symbol), 2);
  } catch (error) {
    if (!error.win32Error) throw error;
    return fail(r, error.win32Error, 2);
  }
}
async function loadLibrary(r, a, wide) {
  const name = wide ? r.wideString(a(0)) : r.string(a(0));
  try {
    return ok(await r.loadLibrary(name), 1);
  } catch (e) {
    if (!e.win32Error) throw e;
    r.emit({ type: 'log', text: e.message });
    return fail(r, e.win32Error, 1);
  }
}
function localAlloc(r, a) {
  if (a(0) & ~0x40) return fail(r, 87, 2);
  return ok(r.allocate(a(1), !!(a(0) & 0x40)), 2);
}
function localFree(r, a) {
  if (!a(0)) return ok(0, 1);
  if (!r.free(a(0))) {
    r.lastError = 6;
    return ok(a(0), 1);
  }
  return ok(0, 1);
}
function heapAlloc(r, a) {
  if (a(0) !== 0x50000000 || a(1) & ~0xc) return fail(r, 87, 3);
  return ok(r.allocate(a(2), !!(a(1) & 8)), 3);
}
function heapFree(r, a) {
  if (a(0) !== 0x50000000 || a(1)) return fail(r, 87, 3);
  return r.free(a(2)) ? ok(1, 3) : fail(r, 6, 3);
}
function commandLine(r, wide) {
  const name = wide ? 'commandLineW' : 'commandLineA';
  r[name] ??= r.allocString([r.exe, ...r.args].map(quoteArgument).join(' '), wide);
  return ok(r[name]);
}
function moduleFilename(r, a, wide) {
  if (a(0) && a(0) !== r.pe.imageBase) return fail(r, 126, 3);
  if (!a(2)) return fail(r, 122, 3);
  const value = r.exe.replaceAll('/', '\\'),
    length = Math.min(value.length, a(2) - 1);
  writeString(r, a(1), value.slice(0, length), wide);
  if (value.length >= a(2)) {
    r.lastError = 122;
    return ok(a(2), 3);
  }
  return ok(value.length, 3);
}
function wideToMulti(r, a) {
  const cp = a(0),
    flags = a(1),
    input = a(2),
    count = a(3) | 0,
    out = a(4),
    capacity = a(5);
  if (![0, 1252, 65001].includes(cp) || flags)
    throw Error('Unsupported WideCharToMultiByte codepage/flags');
  if (count === 0 || count < -1) return fail(r, 87, 8);
  if (count > 1048576) throw Error('WideCharToMultiByte input limit');
  let value;
  if (count === -1) value = r.wideString(input) + '\0';
  else {
    value = '';
    for (let i = 0; i < count; i++)
      value += String.fromCharCode(r.guestMemory.read(input + i * 2, 2));
  }
  let bytes,
    used = false;
  if (cp === 65001) {
    if (a(6) || a(7)) return fail(r, 87, 8);
    bytes = new TextEncoder().encode(value);
  } else {
    const decoder = new TextDecoder('windows-1252'),
      mapping = new Map();
    for (let i = 0; i < 256; i++) mapping.set(decoder.decode(new Uint8Array([i])), i);
    bytes = Uint8Array.from(
      [...value].map((c) => {
        if (mapping.has(c)) return mapping.get(c);
        used = true;
        return a(6) ? r.guestMemory.read(a(6), 1) : 63;
      }),
    );
  }
  if (a(7)) r.write32(a(7), +used);
  if (!capacity) return ok(bytes.length, 8);
  if (bytes.length > capacity) return fail(r, 122, 8);
  r.check(out, bytes.length, true);
  r.data.set(bytes, out);
  return ok(bytes.length, 8);
}
function formatWide(r, a) {
  const format = r.wideString(a(1));
  let va = a(2),
    index = 0,
    result = '';
  while (index < format.length) {
    if (format[index] !== '%') {
      result += format[index++];
      continue;
    }
    index++;
    if (format[index] === '%') {
      result += '%';
      index++;
      continue;
    }
    const spec = /^(0?)(\d*)([sSduUxXc])/.exec(format.slice(index));
    if (!spec) throw Error('Unsupported wvsprintfW format');
    index += spec[0].length;
    const value = r.read32(va);
    va += 4;
    const type = spec[3];
    let part =
      type === 's'
        ? r.wideString(value)
        : type === 'S'
          ? r.string(value)
          : type === 'c'
            ? String.fromCharCode(value)
            : type === 'd'
              ? String(value | 0)
              : type === 'x' || type === 'X'
                ? value.toString(16)
                : String(value);
    if (type === 'X') part = part.toUpperCase();
    const pad = Number(spec[2] || 0);
    if (pad > 1024) throw Error('wvsprintfW width limit');
    result += part.padStart(pad, spec[1] ? '0' : ' ');
    if (result.length >= 1024) throw Error('wvsprintfW output limit');
  }
  writeString(r, a(0), result, true);
  return ok(result.length, 3);
}
async function messageWide(r, a) {
  if (a(0) || a(3) & ~0xf0) throw Error('Unsupported MessageBoxW owner/buttons');
  return ok(
    await r.request('messagebox', {
      text: r.wideString(a(1)),
      title: r.wideString(a(2)),
      flags: a(3),
    }),
    4,
  );
}
export const processApis = {
  'kernel32.dll!GetProcessHeap': () => ok(0x50000000),
  'kernel32.dll!HeapAlloc': heapAlloc,
  'kernel32.dll!HeapFree': heapFree,
  'kernel32.dll!LocalAlloc': localAlloc,
  'kernel32.dll!LocalFree': localFree,
  'kernel32.dll!GetCommandLineW': (r) => commandLine(r, true),
  'kernel32.dll!GetCommandLineA': (r) => commandLine(r, false),
  'kernel32.dll!GetModuleHandleW': (r, a) => moduleHandle(r, a, true),
  'kernel32.dll!GetModuleHandleA': (r, a) => moduleHandle(r, a, false),
  'kernel32.dll!GetProcAddress': procAddress,
  'kernel32.dll!LoadLibraryW': (r, a) => loadLibrary(r, a, true),
  'kernel32.dll!LoadLibraryA': (r, a) => loadLibrary(r, a, false),
  'kernel32.dll!GetModuleFileNameW': (r, a) => moduleFilename(r, a, true),
  'kernel32.dll!GetModuleFileNameA': (r, a) => moduleFilename(r, a, false),
  'kernel32.dll!WideCharToMultiByte': wideToMulti,
  'kernel32.dll!lstrlenW': (r, a) => ok(r.wideString(a(0)).length, 1),
  'kernel32.dll!lstrlenA': (r, a) => ok(r.string(a(0)).length, 1),
  'kernel32.dll!lstrcpyA': (r, a) => ok(writeString(r, a(0), r.string(a(1))), 2),
  'kernel32.dll!lstrcpyW': (r, a) => ok(writeString(r, a(0), r.wideString(a(1)), true), 2),
  'user32.dll!MessageBoxW': messageWide,
  'user32.dll!wvsprintfW': formatWide,
};
