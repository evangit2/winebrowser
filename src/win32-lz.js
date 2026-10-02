import { resolveGuestPath, packageDosPath } from './guest-paths.js';
const ok = (result, argc) => ({ result: result >>> 0, argc });
const SIGNATURE = [0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33];
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
function header(bytes) {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  if (bytes.length < 14) throw Object.assign(Error('Truncated SZDD header'), { lzError: -3 });
  if (bytes[8] !== 0x41) throw Object.assign(Error('Unsupported SZDD algorithm'), { lzError: -8 });
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(10, true);
  if (size > MAX_EXPANDED_BYTES)
    throw Object.assign(Error('SZDD expansion exceeds file limit'), { lzError: -5 });
  return { size, last: bytes[9] };
}
// Microsoft SZDD's LZSS stream: an initially space-filled 4 KB ring, LSB-first
// literal flags and 12-bit offsets. Backreferences may overlap their output.
export function expandSZDD(bytes) {
  const info = header(bytes);
  if (!info) return bytes;
  const output = new Uint8Array(info.size),
    ring = new Uint8Array(4096).fill(0x20);
  let input = 14,
    position = 0xff0,
    out = 0;
  const take = () => {
    if (input >= bytes.length) throw Object.assign(Error('Truncated SZDD stream'), { lzError: -3 });
    return bytes[input++];
  };
  while (out < output.length) {
    const flags = take();
    for (let bit = 0; bit < 8 && out < output.length; bit++) {
      if (flags & (1 << bit)) {
        const b = take();
        output[out++] = b;
        ring[position] = b;
        position = (position + 1) & 4095;
      } else {
        const low = take(),
          high = take(),
          offset = low | ((high & 0xf0) << 4),
          count = (high & 15) + 3;
        for (let n = 0; n < count && out < output.length; n++) {
          const b = ring[(offset + n) & 4095];
          output[out++] = b;
          ring[position] = b;
          position = (position + 1) & 4095;
        }
      }
    }
  }
  return output;
}
function lzStates(r) {
  return (r.lzFiles ??= new Map());
}
function init(r, handle) {
  if (lzStates(r).has(handle)) return handle;
  const file = r.handles.get(handle);
  if (!file || !file.path || !(file.access & 0x80000000)) return -1;
  file.position = 0;
  const bytes = r.files.get(file.path);
  try {
    if (!header(bytes)) return handle;
    for (let id = 0x400; id < 0x410; id++)
      if (!lzStates(r).has(id) && !r.handles.has(id)) {
        lzStates(r).set(id, { raw: handle, bytes: expandSZDD(bytes), position: 0 });
        return id;
      }
    return -5;
  } catch (e) {
    return e.lzError ?? -3;
  }
}
function fileFor(r, handle) {
  const compressed = lzStates(r).get(handle);
  if (compressed) return compressed;
  const raw = r.handles.get(handle);
  return raw?.path && raw.access & 0x80000000
    ? {
        get position() {
          return raw.position;
        },
        set position(v) {
          raw.position = v;
        },
        bytes: r.files.get(raw.path),
      }
    : null;
}
function read(r, a) {
  const file = fileFor(r, a(0)),
    count = a(2) | 0;
  if (!file) return ok(-1, 3);
  if (count < 0) return ok(-7, 3);
  const length = Math.min(count, Math.max(0, file.bytes.length - file.position));
  if (length) {
    r.check(a(1), length, true);
    r.data.set(file.bytes.subarray(file.position, file.position + length), a(1));
  }
  file.position += length;
  return ok(length, 3);
}
function seek(r, a) {
  const handle = a(0),
    file = fileFor(r, handle),
    offset = a(1) | 0,
    origin = a(2);
  if (!file) return ok(-1, 3);
  // LZSeek's compressed SEEK_END uses length - offset (historical Windows ABI).
  const position =
    origin === 0
      ? offset
      : origin === 1
        ? file.position + offset
        : origin === 2
          ? file.bytes.length + (lzStates(r).has(handle) ? -offset : offset)
          : -1;
  if (
    position < 0 ||
    position > 0x7fffffff ||
    (lzStates(r).has(handle) && position > file.bytes.length)
  )
    return ok(-7, 3);
  file.position = position;
  return ok(position, 3);
}
function close(r, handle) {
  const file = lzStates(r).get(handle);
  lzStates(r).delete(handle);
  r.handles.delete(file?.raw ?? handle);
}
function mangle(name) {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')),
    dot = name.indexOf('.', slash + 1);
  return dot < 0 ? name + '._' : name.length - dot - 1 < 3 ? name + '_' : name.slice(0, -1) + '_';
}
function open(r, a, wide) {
  const name = wide ? r.wideString(a(0)) : r.string(a(0)),
    ofs = a(1),
    mode = a(2) & 0xffff;
  if (!ofs) return ok(-1, 3);
  r.check(ofs, 136, true);
  if (mode & ~(0x70 | 3 | 0x1000)) {
    r.view.setUint16(ofs + 2, 87, true);
    return ok(-1, 3);
  }
  let selected = name,
    path;
  try {
    path = resolveGuestPath(selected, r.cwd);
  } catch {
    r.view.setUint16(ofs + 2, 123, true);
    return ok(-1, 3);
  }
  if (!r.files.has(path) && !(mode & 0x1000)) {
    selected = mangle(name);
    try {
      path = resolveGuestPath(selected, r.cwd);
    } catch {
      return ok(-1, 3);
    }
  }
  const pointer = r.allocString(selected, wide);
  let result;
  try {
    const access = (mode & 3) === 1 ? 0x40000000 : (mode & 3) === 2 ? 0xc0000000 : 0x80000000;
    const args = [pointer, access, 3, 0, mode & 0x1000 ? 2 : 3, 0, 0];
    result = r.apiProvider.get('kernel32.dll!CreateFile' + (wide ? 'W' : 'A'))(
      r,
      (i) => args[i],
    ).result;
  } finally {
    r.free(pointer);
  }
  if (result === 0xffffffff) {
    r.view.setUint16(ofs + 2, r.lastError, true);
    return ok(-1, 3);
  }
  const full = packageDosPath(path),
    encoded = new TextEncoder().encode(full);
  r.data.fill(0, ofs, ofs + 136);
  r.data[ofs] = 136;
  r.data[ofs + 1] = 1;
  r.data.set(encoded.subarray(0, 127), ofs + 8);
  if ((mode & ~0x70) === 0) {
    const initialized = init(r, result);
    if (initialized > 0) result = initialized;
  }
  return ok(result, 3);
}
function copy(r, a) {
  let source = a(0),
    temporary = false;
  if (!lzStates(r).has(source)) {
    const initialized = init(r, source);
    if (initialized < 0) return ok(initialized, 2);
    temporary = initialized !== source;
    source = initialized;
  }
  const file = fileFor(r, source),
    dest = r.handles.get(a(1));
  if (!file) return ok(-1, 2);
  if (!dest?.path || !(dest.access & 0x40000000)) return ok(-2, 2);
  const bytes = file.bytes.subarray(file.position),
    pointer = r.allocate(bytes.length + 4);
  try {
    r.data.set(bytes, pointer);
    const args = [a(1), pointer, bytes.length, pointer + bytes.length, 0];
    const result = r.apiProvider.get('kernel32.dll!WriteFile')(r, (i) => args[i]);
    if (!result.result) return ok(-4, 2);
    const count = r.read32(pointer + bytes.length);
    file.position += count;
    const raw = r.handles.get(lzStates(r).get(source)?.raw ?? source);
    if (raw && r.fileTimes?.has(raw.path))
      r.fileTimes.set(dest.path, { ...r.fileTimes.get(raw.path) });
    return ok(count, 2);
  } finally {
    r.free(pointer);
    if (temporary) close(r, source);
  }
}
function expandedName(r, a, wide) {
  const input = wide ? r.wideString(a(0)) : r.string(a(0));
  let path;
  try {
    path = resolveGuestPath(input, r.cwd);
  } catch {
    return ok(-1, 2);
  }
  const bytes = r.files.get(path);
  if (!bytes) return ok(-1, 2);
  let output = input;
  try {
    const info = header(bytes);
    if (info) {
      const slash = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\')),
        dot = input.indexOf('.', slash + 1);
      if (dot >= 0) {
        if (dot === input.length - 1) output = input.slice(0, -1);
        else if (input.endsWith('_')) {
          const lastLetter = [...input].reverse().find((c) => /[a-z]/i.test(c));
          let last = String.fromCharCode(info.last);
          last = lastLetter === lastLetter?.toUpperCase() ? last.toUpperCase() : last.toLowerCase();
          output = input.slice(0, -1) + last;
        }
      }
    }
  } catch (e) {
    return ok(e.lzError ?? -3, 2);
  }
  const width = wide ? 2 : 1;
  r.check(a(1), (output.length + 1) * width, true);
  for (let i = 0; i <= output.length; i++)
    r.guestMemory.write(a(1) + i * width, i < output.length ? output.charCodeAt(i) : 0, width);
  return ok(1, 2);
}
export const lzApis = {};
for (const dll of ['lz32.dll', 'kernel32.dll'])
  Object.assign(lzApis, {
    [`${dll}!LZInit`]: (r, a) => ok(init(r, a(0)), 1),
    [`${dll}!LZOpenFileA`]: (r, a) => open(r, a, false),
    [`${dll}!LZOpenFileW`]: (r, a) => open(r, a, true),
    [`${dll}!LZRead`]: read,
    [`${dll}!LZSeek`]: seek,
    [`${dll}!LZCopy`]: copy,
    [`${dll}!LZClose`]: (r, a) => {
      close(r, a(0));
      return ok(0, 1);
    },
    [`${dll}!GetExpandedNameA`]: (r, a) => expandedName(r, a, false),
    [`${dll}!GetExpandedNameW`]: (r, a) => expandedName(r, a, true),
    [`${dll}!LZStart`]: () => ok(1, 0),
    [`${dll}!LZDone`]: () => ok(0, 0),
  });
