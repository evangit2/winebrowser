import { parseCommandLine } from './command-line.js';
import { resolveGuestPath } from './guest-paths.js';
import { SYNC, syncObjects } from './sync-objects.js';
import { processLookup } from './process-session.js';
import { PROCESS_LAYOUT } from './process-layout.js';

const invalid = (status) => {
  throw Object.assign(Error('Invalid process creation request'), { status });
};
function checked(r, pointer, size, write = false) {
  if (!pointer) invalid(SYNC.FAULT);
  try {
    r.check(pointer, size, write);
  } catch {
    invalid(SYNC.FAULT);
  }
}
function wide(r, pointer, length) {
  if (length & 1 || length > 65532) invalid(SYNC.INVALID);
  checked(r, pointer, length);
  let text = '';
  for (let i = 0; i < length; i += 2)
    text += String.fromCharCode(r.view.getUint16(pointer + i, true));
  if (text.includes('\0')) invalid(SYNC.INVALID);
  return text;
}
function unicode(r, pointer) {
  const length = r.view.getUint16(pointer, true),
    capacity = r.view.getUint16(pointer + 2, true);
  if (length > capacity) invalid(SYNC.INVALID);
  return length ? wide(r, r.read32(pointer + 4), length) : '';
}
function environment(r, pointer) {
  if (!pointer) return undefined;
  const entries = [];
  let text = '';
  for (let i = 0; i < 32768; i++) {
    checked(r, pointer + i * 2, 2);
    const c = r.view.getUint16(pointer + i * 2, true);
    if (c) text += String.fromCharCode(c);
    else if (!text) return { ansi: entries.slice(), wide: entries };
    else {
      entries.push(text);
      text = '';
    }
  }
  invalid(SYNC.INVALID);
}
function attributes(r, pointer) {
  if (!pointer) return false;
  checked(r, pointer, 24);
  if (r.read32(pointer) !== 24) invalid(SYNC.INVALID);
  if (
    r.read32(pointer + 4) ||
    r.read32(pointer + 8) ||
    r.read32(pointer + 12) & ~2 ||
    r.read32(pointer + 16) ||
    r.read32(pointer + 20)
  )
    invalid(SYNC.UNSUPPORTED);
  return !!(r.read32(pointer + 12) & 2);
}
function imageInfo(r, pointer, child) {
  const pe = child.pe;
  r.data.fill(0, pointer, pointer + 48);
  r.write32(pointer, pe.entryPoint);
  r.write32(pointer + 8, pe.stackReserve);
  r.write32(pointer + 12, pe.stackCommit);
  r.write32(pointer + 16, pe.subsystem);
  const bytes = child.files.get(child.exe),
    header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const optional = header.getUint32(0x3c, true) + 24;
  r.guestMemory.write(pointer + 20, header.getUint16(optional + 50, true), 2);
  r.guestMemory.write(pointer + 22, header.getUint16(optional + 48, true), 2);
  r.guestMemory.write(pointer + 24, header.getUint16(optional + 40, true), 2);
  r.guestMemory.write(pointer + 26, header.getUint16(optional + 42, true), 2);
  r.guestMemory.write(pointer + 28, pe.characteristics, 2);
  r.guestMemory.write(pointer + 30, header.getUint16(optional + 70, true), 2);
  r.guestMemory.write(pointer + 32, pe.machine, 2);
  r.data[pointer + 34] = 1;
  r.write32(pointer + 36, header.getUint32(optional + 88, true));
  r.write32(pointer + 40, bytes.length);
  r.write32(pointer + 44, header.getUint32(optional + 64, true));
}
function create(r, a) {
  try {
    checked(r, a(0), 4, true);
    checked(r, a(1), 4, true);
    // This pinned Wine build leaves PS_CREATE_INFO uninitialized and its Unix
    // implementation does not read/write it. Follow that ABI, not guessed fields.
    if (!r.processSession) return SYNC.UNSUPPORTED;
    if (a(2) & ~0x1fffff || a(3) & ~0x1fffff) return SYNC.ACCESS;
    if (a(6) & ~0x200 || a(7) & ~1) return SYNC.UNSUPPORTED;
    const processInherit = attributes(r, a(4)),
      threadInherit = attributes(r, a(5));
    const params = a(8),
      list = a(10);
    checked(r, params, 0x90);
    if (!(r.read32(params + 8) & 1)) return SYNC.UNSUPPORTED;
    // Redirected/inherited handles require shared kernel object ownership.
    if (
      ![0, 1, 0xffffffff].includes(r.read32(params + 0x1c)) ||
      ![0, 2, 0xffffffff].includes(r.read32(params + 0x20))
    )
      return SYNC.UNSUPPORTED;
    checked(r, list, 4);
    const size = r.read32(list);
    if (size < 4 || size > 260 || (size - 4) % 16) return SYNC.INVALID;
    checked(r, list, size);
    let image = unicode(r, params + 0x38);
    const outputs = [],
      seen = new Set();
    for (let p = list + 4; p < list + size; p += 16) {
      const type = r.read32(p),
        length = r.read32(p + 4),
        value = r.read32(p + 8),
        returned = r.read32(p + 12);
      if (seen.has(type)) return SYNC.INVALID;
      seen.add(type);
      if (type === 0x20005) image = wide(r, value, length);
      else if ([0x10003, 0x10004, 6].includes(type)) {
        const expected = type === 0x10003 ? 8 : type === 6 ? 48 : 4;
        if (length !== expected) return SYNC.INVALID;
        checked(r, value, length, true);
        if (returned) checked(r, returned, 4, true);
        outputs.push({ type, value, length, returned });
      } else if (type === 0x6001c) {
        if (length !== 2 || value !== 0x14c) return 0xc000012f;
      } else return SYNC.UNSUPPORTED;
    }
    let cwd;
    try {
      cwd = resolveGuestPath(unicode(r, params + 0x24), r.cwd, { allowRoot: true });
    } catch {
      return SYNC.PATH;
    }
    if (
      cwd &&
      ![...r.files.keys()].some((p) => p.toLowerCase().startsWith(cwd.toLowerCase() + '/'))
    )
      return SYNC.PATH;
    const resolved = r.processSession.resolveImage(image, r.cwd);
    if (resolved.status) return resolved.status;
    const commandLine = unicode(r, params + 0x40),
      args = parseCommandLine(commandLine);
    const created = r.processSession.create(
      {
        exe: resolved.exe,
        cwd: cwd ? cwd + '/' : '',
        commandLine,
        argv0: args[0],
        args: args.slice(1),
        environment: environment(r, r.read32(params + 0x48)),
        suspended: !!(a(7) & 1),
      },
      r,
    );
    if (created.status) return created.status;
    const handles = r.processSession.handles(
      r,
      created.record,
      a(2),
      a(3),
      processInherit,
      threadInherit,
    );
    if (handles.status) {
      r.processSession.terminate(created.record, 0xc0000120);
      return handles.status;
    }
    for (const out of outputs) {
      if (out.type === 0x10003) {
        r.write32(out.value, created.record.id);
        r.write32(out.value + 4, created.record.thread.id);
      } else if (out.type === 0x10004) r.write32(out.value, created.record.thread.teb);
      else imageInfo(r, out.value, created.record.runtime);
      if (out.returned) r.write32(out.returned, out.length);
    }
    r.write32(a(0), handles.process);
    r.write32(a(1), handles.thread);
    r.processSession.start(created.record);
    return 0;
  } catch (error) {
    if (error.status) return error.status;
    throw error;
  }
}
export const childProcessNtServices = {
  NtCreateUserProcess: { argc: 11, call: create },
  NtOpenProcess: {
    argc: 4,
    call(r, a) {
      try {
        checked(r, a(0), 4, true);
        const inherit = attributes(r, a(2));
        checked(r, a(3), 8);
        if (a(1) & ~0x1fffff || r.read32(a(3) + 4)) return SYNC.UNSUPPORTED;
        const process = r.processSession?.records.get(r.read32(a(3)));
        if (!process) return 0xc000000b; // STATUS_INVALID_CID
        const opened = syncObjects(r).openHandle(process.object, a(1), inherit);
        if (!opened.status) r.write32(a(0), opened.handle);
        return opened.status;
      } catch (error) {
        if (error.status) return error.status;
        throw error;
      }
    },
  },
};
export function queryProcessBasic(r, a) {
  if (a(3) !== 24) return 0xc0000004;
  const found = processLookup(r, a(0), 0x400);
  if (found.status) return found.status;
  try {
    checked(r, a(2), 24, true);
    if (a(4)) checked(r, a(4), 4, true);
    const p = found.process;
    [p.done ? p.code : 259, PROCESS_LAYOUT.peb, 1, 8, p.id, p.parentId].forEach((v, i) =>
      r.write32(a(2) + i * 4, v),
    );
    if (a(4)) r.write32(a(4), 24);
    return 0;
  } catch (error) {
    return error.status ?? SYNC.FAULT;
  }
}
