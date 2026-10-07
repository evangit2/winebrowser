import { decodeAnsi, encodeAnsi, decodeOem, encodeOem } from './encoding.js';
import { processApis } from './win32-process.js';

const TEXT = 1,
  OEM = 7,
  UNICODE = 13,
  LOCALE = 16;
const textFormats = [TEXT, OEM, UNICODE];
const ok = (result, argc) => ({ result: result >>> 0, argc });
const fail = (r, error, argc) => {
  r.lastError = error;
  return ok(0, argc);
};
const state = (r) => (r.clipboard ??= { owner: 0, formats: new Map(), sequence: 0 });
const thread = (r) => r.threads?.current?.id ?? 1;
const opened = (r) => r.clipboardOpen?.thread === thread(r);

// The application's native Kernel32 may own movable HGLOBALs. Use its real
// locking/allocation routines, rather than interpreting native heap headers.
async function global(r, name, args) {
  const module = r.graph.findLoaded('kernel32.dll');
  if (module?.mapped && !module.host) return r.callGuest(await r.resolveExport(module, name), args);
  return (await processApis['kernel32.dll!' + name](r, (i) => args[i] ?? 0)).result;
}
async function snapshot(r, handle) {
  const size = await global(r, 'GlobalSize', [handle]);
  if (!size) return null;
  const pointer = await global(r, 'GlobalLock', [handle]);
  if (!pointer) return null;
  try {
    r.check(pointer, size);
    return r.data.slice(pointer, pointer + size);
  } finally {
    await global(r, 'GlobalUnlock', [handle]);
  }
}
async function release(r, row) {
  if (row?.handle) await global(r, 'GlobalFree', [row.handle]);
}
async function materialize(r, row) {
  if (row.handle) return row.handle;
  if (!row.bytes) return 0;
  const handle = await global(r, 'GlobalAlloc', [0x42, row.bytes.length]);
  if (!handle) return 0;
  const pointer = await global(r, 'GlobalLock', [handle]);
  if (!pointer) {
    await global(r, 'GlobalFree', [handle]);
    return 0;
  }
  r.check(pointer, row.bytes.length, true);
  r.data.set(row.bytes, pointer);
  await global(r, 'GlobalUnlock', [handle]);
  row.handle = handle;
  return handle;
}
function decode(bytes, format) {
  if (format === UNICODE) {
    let length = 0;
    while (length + 1 < bytes.length && (bytes[length] || bytes[length + 1])) length += 2;
    // Preserve UTF-16 code units, including unmatched surrogates.
    let value = '';
    for (let i = 0; i < length; i += 2)
      value += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return value;
  }
  const end = bytes.indexOf(0),
    data = bytes.subarray(0, end < 0 ? bytes.length : end);
  return format === OEM ? decodeOem(data) : decodeAnsi(data);
}
function encode(text, format) {
  if (format === UNICODE) {
    const bytes = new Uint8Array((text.length + 1) * 2),
      view = new DataView(bytes.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
    return bytes;
  }
  const data = (format === OEM ? encodeOem(text) : encodeAnsi(text)).bytes;
  const bytes = new Uint8Array(data.length + 1);
  bytes.set(data);
  return bytes;
}
function synthesize(r) {
  const s = state(r),
    source = textFormats.find((f) => s.formats.has(f));
  if (!source) return;
  if (!s.formats.has(LOCALE))
    s.formats.set(LOCALE, { bytes: Uint8Array.of(9, 4, 0, 0), handle: 0 });
  // Native Wine appends the two omitted text formats in this order at Close.
  for (const format of [TEXT, OEM, UNICODE])
    if (!s.formats.has(format)) s.formats.set(format, { source, handle: 0 });
}
export function openClipboard(r, owner) {
  if (owner && !r.windows.windows.has(owner)) return fail(r, 1400, 1);
  if (r.clipboardOpen && !opened(r)) return fail(r, 5, 1);
  r.clipboardOpen = { owner, thread: thread(r) };
  state(r);
  return ok(1, 1);
}
export async function emptyClipboard(r) {
  if (!opened(r)) return fail(r, 1418, 0);
  const s = state(r),
    error = r.lastError;
  if (s.owner && r.windows.windows.has(s.owner)) await r.windows.send(s.owner, 0x307);
  for (const row of s.formats.values()) await release(r, row);
  s.formats.clear();
  s.owner = r.clipboardOpen.owner;
  s.sequence++;
  r.lastError = error;
  return ok(1, 0);
}
export async function setClipboardData(r, format, handle) {
  const s = state(r);
  if (!opened(r) && !(r.clipboardRendering === format && s.owner)) return fail(r, 1418, 2);
  if (!format) return fail(r, 87, 2);
  // GDI object formats require their own ownership protocol, not HGLOBAL.
  if ([2, 3, 9, 14].includes(format)) return fail(r, 120, 2);
  const error = r.lastError,
    bytes = handle ? await snapshot(r, handle) : null;
  if (handle && !bytes) return fail(r, 6, 2);
  const previous = s.formats.get(format);
  if (previous?.handle !== handle) await release(r, previous);
  for (const row of s.formats.values())
    if (row.source === format) {
      await release(r, row);
      row.handle = 0;
      row.bytes = null;
    }
  s.formats.set(format, { bytes, handle, delayed: !handle });
  s.sequence++;
  r.lastError = handle ? 0 : error;
  return ok(handle, 2);
}
export function closeClipboard(r) {
  if (!opened(r)) return fail(r, 1418, 0);
  synthesize(r);
  r.clipboardOpen = null;
  return ok(1, 0);
}
async function data(r, format, active = new Set()) {
  const s = state(r);
  let row = s.formats.get(format);
  if (!row || active.has(format)) return null;
  active.add(format);
  if (row.delayed && r.clipboardRendering === format) return null;
  if (row.delayed && s.owner && r.windows.windows.has(s.owner)) {
    const previous = r.clipboardRendering;
    r.clipboardRendering = format;
    try {
      await r.windows.send(s.owner, 0x305, format);
    } finally {
      r.clipboardRendering = previous;
    }
    row = s.formats.get(format);
  }
  if (row?.source && !row.bytes) {
    const source = await data(r, row.source, active);
    if (source?.bytes) row.bytes = encode(decode(source.bytes, row.source), format);
  }
  return row?.bytes ? row : null;
}
export async function getClipboardData(r, format) {
  if (!opened(r)) return fail(r, 1418, 1);
  const row = await data(r, format);
  if (!row) return ok(0, 1);
  const handle = await materialize(r, row);
  if (handle) r.lastError = 0;
  return ok(handle, 1);
}
export async function clipboardText(r) {
  const s = state(r);
  for (const format of [UNICODE, TEXT, OEM]) {
    if (!s.formats.has(format)) continue;
    const row = await data(r, format);
    if (row) return decode(row.bytes, format);
  }
  return null;
}
export async function publishClipboardText(r, owner, text, wide) {
  if (!openClipboard(r, owner).result) return false;
  try {
    await emptyClipboard(r);
    const row = { bytes: encode(text, wide ? UNICODE : TEXT), handle: 0 };
    const handle = await materialize(r, row);
    if (!handle) return false;
    state(r).formats.set(wide ? UNICODE : TEXT, row);
    state(r).sequence++;
    return true;
  } finally {
    closeClipboard(r);
  }
}
export async function destroyClipboardOwner(r, hwnd) {
  const s = state(r);
  if (s.owner !== hwnd) return;
  await r.windows.send(hwnd, 0x306); // WM_RENDERALLFORMATS; owner opens/sets data.
  for (const [format, row] of s.formats) if (row.delayed) s.formats.delete(format);
  for (const [format, row] of s.formats)
    if (row.source && !s.formats.has(row.source) && !row.bytes) s.formats.delete(format);
  s.owner = 0;
}
export const clipboardApis = {
  'user32.dll!OpenClipboard': (r, a) => openClipboard(r, a(0)),
  'user32.dll!EmptyClipboard': emptyClipboard,
  'user32.dll!CloseClipboard': closeClipboard,
  'user32.dll!SetClipboardData': (r, a) => setClipboardData(r, a(0), a(1)),
  'user32.dll!GetClipboardData': (r, a) => getClipboardData(r, a(0)),
  'user32.dll!GetClipboardOwner': (r) => ok(state(r).owner, 0),
  'user32.dll!GetOpenClipboardWindow': (r) => ok(r.clipboardOpen?.owner ?? 0, 0),
  'user32.dll!CountClipboardFormats': (r) => ok(state(r).formats.size, 0),
  'user32.dll!IsClipboardFormatAvailable': (r, a) => ok(state(r).formats.has(a(0)), 1),
  'user32.dll!GetClipboardSequenceNumber': (r) => ok(state(r).sequence, 0),
  'user32.dll!EnumClipboardFormats': (r, a) => {
    if (!opened(r)) return fail(r, 1418, 1);
    const formats = [...state(r).formats.keys()],
      previous = a(0);
    const index = previous ? formats.indexOf(previous) : -1;
    if (previous && index < 0) return fail(r, 87, 1);
    r.lastError = 0;
    return ok(formats[index + 1] ?? 0, 1);
  },
  'user32.dll!GetPriorityClipboardFormat': (r, a) => {
    const s = state(r),
      count = a(1) | 0;
    if (!s.formats.size) return ok(0, 2);
    if (count < 0) return fail(r, 87, 2);
    r.check(a(0), count * 4);
    for (let i = 0; i < count; i++) {
      const format = r.read32(a(0) + i * 4);
      if (s.formats.has(format)) return ok(format, 2);
    }
    return ok(0xffffffff, 2);
  },
};
