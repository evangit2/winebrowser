import { resolveGuestPath } from './guest-paths.js';

const INFO_SIZE = 72;
const DOS = 0x20534f44;
const MEM = 0x204d454d;
const RIFF = 0x46464952;
const LIST = 0x5453494c;
const result = (value, argc) => ({ result: value >>> 0, argc });
const handles = (r) => (r.mmioHandles ??= new Map());
const find = (r, id) => handles(r).get(id >>> 0);
const position = (s) => (s.buffer ? s.start + s.next : s.offset);

function fill(r, s, at) {
  s.start = at;
  s.next = 0;
  s.count = Math.min(s.size, Math.max(0, s.bytes.length - at));
  if (s.count) r.data.set(s.bytes.subarray(at, at + s.count), s.buffer);
  s.disk = at + s.count;
}

function seek(r, s, at) {
  if (s.buffer) {
    if (at >= s.start && at <= s.start + s.count) s.next = at - s.start;
    else fill(r, s, at);
  } else s.offset = s.disk = at;
  return at;
}

function info(r, s, p) {
  r.check(p, INFO_SIZE, true);
  r.data.fill(0, p, p + INFO_SIZE);
  const words = [
    s.flags,
    s.memory ? MEM : DOS,
    0,
    0,
    0,
    s.size,
    s.buffer,
    s.buffer ? s.buffer + s.next : 0,
    s.buffer ? s.buffer + s.count : 0,
    s.buffer ? s.buffer + s.size : 0,
    s.buffer ? s.start : 0,
    s.disk,
    0,
    0,
    0,
    0,
    0,
    s.id,
  ];
  // PE32 MMIOINFO has eighteen DWORDs; hmmio is at offset 68.
  words.forEach((value, i) => r.write32(p + i * 4, value));
}

function coherent(r, s, p) {
  r.check(p, INFO_SIZE);
  if (r.read32(p + 20) !== s.size || r.read32(p + 24) !== s.buffer) return false;
  for (const offset of [28, 32, 36]) {
    const value = r.read32(p + offset);
    if (value < s.buffer || value > s.buffer + s.size) return false;
  }
  return true;
}

function open(r, a, wide) {
  const p = a(1) >>> 0;
  const flags = a(2) >>> 0;
  if (p) r.check(p, INFO_SIZE, true);
  const fail = (error) => {
    if (p) r.write32(p + 12, error);
    return result(0, 3);
  };
  // Read-only package files and caller-owned memory streams. Custom I/O
  // procedures, filesystem mutations and write buffers have no host backend.
  if (flags & ~0x10070 || (p && r.read32(p + 8))) return fail(259);
  if (handles(r).size >= 256) return fail(271);
  const proc = p ? r.read32(p + 4) : 0;
  const memory = !a(0) && proc === MEM;
  let bytes;
  if (memory) {
    const buffer = r.read32(p + 24),
      size = r.read32(p + 20) | 0;
    if (!buffer || size <= 0) return fail(11);
    r.check(buffer, size);
    bytes = r.data.subarray(buffer, buffer + size);
  } else {
    if (!a(0) || (proc && proc !== DOS)) return fail(259);
    try {
      const path = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
      bytes = r.files.get(path);
    } catch {
      return fail(267);
    }
    if (!bytes) return fail(257);
  }
  let buffer = p ? r.read32(p + 24) : 0;
  let size = p ? r.read32(p + 20) | 0 : 0;
  let owned = false;
  if (size < 0 || size > 1024 * 1024) return fail(11);
  if (!buffer && flags & 0x10000) {
    size ||= 8192;
    buffer = r.allocate(size);
    if (!buffer) return fail(258);
    owned = true;
  } else if (!buffer) size = 0;
  if (buffer && !size) return fail(11);
  if (buffer) r.check(buffer, size, true);
  const id = (r.nextMmioHandle ??= 0x6a000);
  r.nextMmioHandle += 4;
  const s = {
    id,
    flags,
    bytes,
    memory,
    buffer,
    size,
    owned,
    start: 0,
    next: 0,
    count: 0,
    disk: 0,
    offset: 0,
  };
  handles(r).set(id, s);
  if (memory) {
    s.count = size;
    s.disk = size;
  }
  if (p) info(r, s, p);
  return result(id, 3);
}

function read(r, a) {
  const s = find(r, a(0));
  const length = a(2) | 0;
  if (!s || length < 0) return result(-1, 3);
  if (!length) return result(0, 3);
  r.check(a(1), length, true);
  let copied = 0;
  while (copied < length && position(s) < s.bytes.length) {
    if (!s.buffer) {
      const n = Math.min(length - copied, s.bytes.length - s.offset);
      r.data.set(s.bytes.subarray(s.offset, s.offset + n), a(1) + copied);
      s.offset += n;
      s.disk = s.offset;
      copied += n;
    } else {
      if (s.next >= s.count) fill(r, s, position(s));
      const n = Math.min(length - copied, s.count - s.next);
      if (!n) break;
      r.data.copyWithin(a(1) + copied, s.buffer + s.next, s.buffer + s.next + n);
      s.next += n;
      copied += n;
    }
  }
  return result(copied, 3);
}

function descend(r, a) {
  const s = find(r, a(0));
  if (!s) return result(5, 4);
  if (![0, 0x10, 0x20, 0x40].includes(a(3))) return result(11, 4);
  r.check(a(1), 20, true);
  const wantedId = r.read32(a(1)),
    wantedType = r.read32(a(1) + 8);
  let at = position(s),
    limit = s.bytes.length;
  if (a(2)) {
    r.check(a(2), 20);
    const start = r.read32(a(2) + 12),
      size = r.read32(a(2) + 4);
    limit = start + size;
    if (limit > s.bytes.length || at < start || at > limit) return result(265, 4);
  }
  const v = new DataView(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength);
  while (at + 8 <= limit) {
    const id = v.getUint32(at, true),
      size = v.getUint32(at + 4, true);
    const data = at + 8,
      end = data + size;
    if (end > limit) return result(272, 4);
    const container = id === RIFF || id === LIST;
    if (container && size < 4) return result(272, 4);
    const type = container ? v.getUint32(data, true) : 0;
    const matches =
      a(3) === 0 ||
      (a(3) === 0x10 && id === wantedId) ||
      (a(3) === 0x20 && id === RIFF && type === wantedType) ||
      (a(3) === 0x40 && id === LIST && type === wantedType);
    if (matches) {
      [id, size, type, data, 0].forEach((value, i) => r.write32(a(1) + i * 4, value));
      seek(r, s, data + (container ? 4 : 0));
      return result(0, 4);
    }
    at = end + (size & 1);
  }
  return result(265, 4);
}

export const mmioApis = {
  'winmm.dll!mmioOpenA': (r, a) => open(r, a, false),
  'winmm.dll!mmioOpenW': (r, a) => open(r, a, true),
  'winmm.dll!mmioClose': (r, a) => {
    const s = find(r, a(0));
    if (!s) return result(5, 2);
    if (a(1) & ~0x10) return result(11, 2);
    handles(r).delete(s.id);
    if (s.owned) r.free(s.buffer);
    return result(0, 2);
  },
  'winmm.dll!mmioRead': read,
  'winmm.dll!mmioSeek': (r, a) => {
    const s = find(r, a(0));
    if (!s || ![0, 1, 2].includes(a(2))) return result(-1, 3);
    const at = (a(1) | 0) + [0, position(s), s.bytes.length][a(2)];
    if (at < 0 || at > 0x7fffffff) return result(-1, 3);
    return result(seek(r, s, at), 3);
  },
  'winmm.dll!mmioGetInfo': (r, a) => {
    const s = find(r, a(0));
    if (!s) return result(5, 3);
    info(r, s, a(1));
    return result(0, 3);
  },
  'winmm.dll!mmioSetInfo': (r, a) => {
    const s = find(r, a(0));
    if (!s) return result(5, 3);
    if (!coherent(r, s, a(1))) return result(11, 3);
    if (r.read32(a(1)) & 0x10000000) return result(262, 3);
    s.next = r.read32(a(1) + 28) - s.buffer;
    s.count = r.read32(a(1) + 32) - s.buffer;
    return result(0, 3);
  },
  'winmm.dll!mmioAdvance': (r, a) => {
    const s = find(r, a(0));
    if (!s) return result(5, 3);
    if (!s.buffer) return result(266, 3);
    if (a(2) !== 0) return result(a(2) === 1 ? 262 : 11, 3);
    if (a(1) && !coherent(r, s, a(1))) return result(11, 3);
    fill(r, s, s.disk);
    if (a(1)) info(r, s, a(1));
    return result(0, 3);
  },
  'winmm.dll!mmioDescend': descend,
  'winmm.dll!mmioAscend': (r, a) => {
    const s = find(r, a(0));
    if (!s) return result(5, 3);
    r.check(a(1), 20);
    if (a(2) || r.read32(a(1) + 16) & 0x10000000) return result(11, 3);
    const size = r.read32(a(1) + 4),
      data = r.read32(a(1) + 12);
    const end = data + size + (size & 1);
    if (data + size > s.bytes.length || end > 0x7fffffff) return result(272, 3);
    seek(r, s, end);
    return result(0, 3);
  },
};
