// Synchronous PE32 NT file services backed by Runtime's bounded virtual files.
import {
  acquireFileLock,
  waitFileLock,
  releaseFileLock,
  releaseHandleLocks,
  fileLockConflict,
  FILE_LOCK_CONFLICT,
  LOCK_NOT_GRANTED,
} from './file-locks.js';
import { syncObjects, SYNC } from './sync-objects.js';
import { resolveGuestPath } from './guest-paths.js';
import { fileMetadata, fileIdentity, writeFileMetadata, touchFile } from './file-metadata.js';
import { virtualNames, matchWildcard } from './guest-directory.js';
const SUCCESS = 0;
const ACCESS_VIOLATION = 0xc0000005;
const INVALID_HANDLE = 0xc0000008;
const INVALID_PARAMETER = 0xc000000d;
const END_OF_FILE = 0xc0000011;
const ACCESS_DENIED = 0xc0000022;
const BUFFER_TOO_SMALL = 0xc0000023;
const DISK_FULL = 0xc000007f;
const FILE_DEVICE_DISK = 7;
const FILE_DEVICE_NAMED_PIPE = 0x11;
const MAX_IO = 4 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_FILESYSTEM = 128 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const NOT_SUPPORTED = 0xc00000bb;
const NAME_NOT_FOUND = 0xc0000034;
const PATH_NOT_FOUND = 0xc000003a;

function objectPath(runtime, pointer, allowRoot = false) {
  if (!checked(runtime, pointer, 24)) return { status: ACCESS_VIOLATION };
  if (runtime.read32(pointer) !== 24) return { status: INVALID_PARAMETER };
  // Root-directory handles and caller-supplied security are separate services.
  if (
    runtime.read32(pointer + 4) ||
    runtime.read32(pointer + 12) & ~0x42 ||
    runtime.read32(pointer + 16) ||
    runtime.read32(pointer + 20)
  )
    return { status: NOT_SUPPORTED };
  const name = runtime.read32(pointer + 8);
  if (!checked(runtime, name, 8)) return { status: ACCESS_VIOLATION };
  const length = runtime.view.getUint16(name, true);
  const capacity = runtime.view.getUint16(name + 2, true);
  const buffer = runtime.read32(name + 4);
  if (!length || length & 1 || length > capacity || length > 32766)
    return { status: INVALID_PARAMETER };
  if (!checked(runtime, buffer, length)) return { status: ACCESS_VIOLATION };
  let path = '';
  for (let i = 0; i < length; i += 2)
    path += String.fromCharCode(runtime.view.getUint16(buffer + i, true));
  // NT absolute names have already been normalized by Wine's DOS path routines.
  if (!path.startsWith('\\??\\')) return { status: PATH_NOT_FOUND };
  try {
    return { path: resolveGuestPath(path, '', { allowRoot }) };
  } catch {
    return { status: PATH_NOT_FOUND };
  }
}

function create(runtime, argument) {
  const complete = iosb(runtime, argument(3));
  if (!complete || !checked(runtime, argument(0), 4, true)) return ACCESS_VIOLATION;
  const access = argument(1) >>> 0,
    share = argument(6) >>> 0;
  const disposition = argument(7) >>> 0,
    options = argument(8) >>> 0;
  if (disposition > 5 || share & ~7) return complete(INVALID_PARAMETER);
  // Synchronous data I/O, metadata and directory handles. This volume
  // contains no reparse points; OPEN_REPARSE_POINT therefore follows the same
  // path. EAs, allocation hints and caller security remain unsupported.
  // SEQUENTIAL_ONLY (0x4) and RANDOM_ACCESS (0x800) are cache hints. Package
  // files are already memory-resident; both retain ordinary read/seek semantics.
  if (
    argument(4) ||
    argument(9) ||
    argument(10) ||
    options & ~0x205865 ||
    (!(options & 0x20) && !!(access & 0xc0000007)) ||
    access & ~0xc013019f ||
    disposition === 0
  )
    return complete(NOT_SUPPORTED);
  if (options & 1 && options & 0x40) return complete(INVALID_PARAMETER);
  if (options & 0x1000 && !(access & 0x10000)) return complete(ACCESS_DENIED);
  if (!(access & 0x100000)) return complete(INVALID_PARAMETER);
  const named = objectPath(runtime, argument(2), true);
  if (named.status) return complete(named.status);
  const metadata = fileMetadata(runtime, named.path);
  if (metadata.directory && options & 0x40) return complete(0xc00000ba);
  if (options & 1 || metadata.directory) {
    if (runtime.handles.size >= 4096) return complete(0xc000009a);
    if (![1, 2, 3].includes(disposition) || options & 0x1040 || argument(5) & ~0x90)
      return complete(NOT_SUPPORTED);
    const info = fileMetadata(runtime, named.path);
    if (!info.status && !info.directory) return complete(0xc0000103); // NOT_A_DIRECTORY
    if (!info.status && disposition === 2) return complete(0xc0000035);
    if (info.status) {
      if (disposition === 1) return complete(info.status);
      const parent = named.path.includes('/')
        ? named.path.slice(0, named.path.lastIndexOf('/'))
        : '';
      const parentInfo = fileMetadata(runtime, parent);
      if (parentInfo.status || !parentInfo.directory) return complete(PATH_NOT_FOUND);
      runtime.virtualDirectories ??= new Set();
      if (runtime.virtualDirectories.size >= 4096) return complete(0xc000009a);
      runtime.virtualDirectories.add(named.path + '/');
      touchFile(runtime, named.path, { created: true });
    }
    const handle = runtime.nextHandle++;
    runtime.handles.set(handle, {
      kind: 'file-directory',
      path: named.path,
      ntAccess: access,
      access,
      share,
      options,
      inherit: !!(runtime.read32(argument(2) + 12) & 2),
    });
    runtime.write32(argument(0), handle);
    return complete(SUCCESS, info.status ? 2 : 1);
  }
  const path = named.path,
    exists = runtime.files.has(path);
  if (runtime.pendingFileDeletes?.has(path)) return complete(0xc0000056); // DELETE_PENDING
  // Attributes on an existing FILE_OPEN/FILE_OPEN_IF do not change that file.
  if (!(exists && [1, 3].includes(disposition)) && argument(5) & ~0xa0)
    return complete(NOT_SUPPORTED);
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  if (parent && !fileMetadata(runtime, parent.slice(0, -1)).directory)
    return complete(PATH_NOT_FOUND);
  if ([...runtime.files.keys()].some((name) => name.startsWith(path + '/')))
    return complete(0xc00000ba); // directory
  if (!exists && (disposition === 1 || disposition === 4)) return complete(NAME_NOT_FOUND);
  if (exists && disposition === 2) return complete(0xc0000035); // collision
  const readAccess = !!(access & 0x80000001),
    writeAccess = !!(access & 0x40000006);
  const truncate = exists && (disposition === 4 || disposition === 5);
  if (truncate && !(access & 0x40000002)) return complete(ACCESS_DENIED);
  if (truncate && runtime.fileSections?.canResize(path, 0) === false) return complete(0xc0000243); // STATUS_USER_MAPPED_FILE
  if (
    fileShareConflict(
      runtime,
      path,
      (readAccess ? 0x80000000 : 0) | (writeAccess ? 0x40000000 : 0) | (access & 0x10000),
      share,
    )
  )
    return complete(0xc0000043);
  if (options & 0x1000 && runtime.fileSections?.canResize(path, 0) === false)
    return complete(ACCESS_DENIED);
  if (runtime.handles.size >= 4096 || (!exists && runtime.files.size >= 4096))
    return complete(0xc000009a);
  const handle = runtime.nextHandle++;
  if (!exists || truncate) {
    runtime.files.set(path, new Uint8Array());
    touchFile(runtime, path, { created: !exists, write: true });
    runtime.dirty.add(path);
  }
  runtime.handles.set(handle, {
    path,
    position: 0,
    access:
      ((readAccess ? 0x80000000 : 0) | (writeAccess ? 0x40000000 : 0) | (access & 0x10000)) >>> 0,
    deleteOnClose: !!(options & 0x1000),
    ntAccess: access,
    share,
    options,
    inherit: !!(runtime.read32(argument(2) + 12) & 2),
    appendOnly: !!(access & 4) && !(access & 0x40000002),
  });
  if (options & 0x1000) (runtime.pendingFileDeletes ??= new Set()).add(path);
  runtime.write32(argument(0), handle);
  return complete(SUCCESS, !exists ? 2 : truncate ? 3 : 1);
}

function information(runtime, argument, set) {
  const complete = iosb(runtime, argument(1));
  if (!complete) return ACCESS_VIOLATION;
  const opened = regular(runtime, argument(0)) ?? directoryHandle(runtime, argument(0));
  if (!opened) return complete(INVALID_HANDLE);
  const kind = argument(4) >>> 0;
  if (opened.kind === 'file-directory' && set && kind !== 4) return complete(NOT_SUPPORTED);
  if (set && kind === 4) {
    if (argument(3) < 40) return complete(0xc0000004);
    if (!checked(runtime, argument(2), 40)) return complete(ACCESS_VIOLATION);
    if (!((opened.ntAccess ?? opened.access) & 0x40000100)) return complete(ACCESS_DENIED);
    const buffer = argument(2),
      attributes = runtime.read32(buffer + 32);
    if (attributes && ![0x20, 0x80].includes(attributes)) return complete(NOT_SUPPORTED);
    const previous = fileMetadata(runtime, opened.path),
      next = {};
    for (const [i, key] of ['creation', 'access', 'write', 'change'].entries()) {
      const value = runtime.view.getBigInt64(buffer + i * 8, true);
      if (value < 0n) return complete(NOT_SUPPORTED);
      next[key] = value || previous[key];
    }
    runtime.fileTimes ??= new Map();
    runtime.fileTimes.set(opened.path, next);
    return complete(SUCCESS);
  }
  if (set && kind === 13) {
    if (argument(3) < 1) return complete(0xc0000004);
    if (!checked(runtime, argument(2), 1)) return complete(ACCESS_VIOLATION);
    if (!(opened.access & 0x10000)) return complete(ACCESS_DENIED);
    const pending = !!runtime.data[argument(2)];
    if (
      pending &&
      (fileShareConflict(runtime, opened.path, 0x10000, 7) ||
        runtime.fileSections?.canResize(opened.path, 0) === false)
    )
      return complete(ACCESS_DENIED);
    opened.deleteOnClose = pending;
    runtime.pendingFileDeletes ??= new Set();
    if (pending) runtime.pendingFileDeletes.add(opened.path);
    else if (![...runtime.handles.values()].some((h) => h.path === opened.path && h.deleteOnClose))
      runtime.pendingFileDeletes.delete(opened.path);
    return complete(SUCCESS);
  }
  const size =
    !set && kind === 4
      ? 40
      : !set && kind === 34
        ? 56
        : kind === 68 && !set
          ? 72
          : kind === 5 && !set
            ? 24
            : kind === 14 || (kind === 20 && set)
              ? 8
              : 0;
  if (!size) {
    runtime.emit({
      type: 'log',
      text: `Unavailable file information class ${kind} (${set ? 'set' : 'query'})`,
    });
    return complete(NOT_SUPPORTED);
  }
  if (kind === 14 && !(opened.access & 0xc0000000)) return complete(ACCESS_DENIED);
  if ([4, 34, 68].includes(kind) && !((opened.ntAccess ?? opened.access) & 0x80000080))
    return complete(ACCESS_DENIED);
  if (argument(3) >>> 0 < size) return complete(0xc0000004); // INFO_LENGTH_MISMATCH
  const buffer = argument(2) >>> 0;
  if (!checked(runtime, buffer, size, !set)) return complete(ACCESS_VIOLATION);
  const bytes = runtime.files.get(opened.path);
  if (!set && kind === 68) {
    const info = fileMetadata(runtime, opened.path);
    runtime.data.fill(0, buffer, buffer + size);
    runtime.view.setBigInt64(buffer, BigInt(fileIdentity(runtime, opened.path)), true);
    for (const [i, key] of ['creation', 'access', 'write', 'change'].entries())
      runtime.view.setBigInt64(buffer + 8 + i * 8, info[key], true);
    runtime.view.setBigInt64(buffer + 40, BigInt(info.allocation), true);
    runtime.view.setBigInt64(buffer + 48, BigInt(info.size), true);
    runtime.write32(buffer + 56, info.attributes);
    runtime.write32(buffer + 64, 1);
    runtime.write32(buffer + 68, opened.ntAccess ?? opened.access);
    return complete(SUCCESS, size);
  }
  if (set) {
    const value = runtime.view.getBigInt64(buffer, true);
    if (value < 0 || value > BigInt(MAX_FILE)) return complete(INVALID_PARAMETER);
    if (kind === 14) opened.position = Number(value);
    else {
      if (!(opened.access & 0x40000000) || opened.appendOnly) return complete(ACCESS_DENIED);
      if (runtime.fileSections?.canResize(opened.path, Number(value)) === false)
        return complete(0xc0000243);
      const total = [...runtime.files.values()].reduce((sum, file) => sum + file.length, 0);
      if (total - bytes.length + Number(value) > MAX_FILESYSTEM) return complete(DISK_FULL);
      const resized = new Uint8Array(Number(value));
      resized.set(bytes.subarray(0, resized.length));
      runtime.files.set(opened.path, resized);
      runtime.fileSections?.fileChanged(opened.path);
      touchFile(runtime, opened.path, { write: true });
      runtime.dirty.add(opened.path);
    }
    return complete(SUCCESS);
  }
  if (kind === 4 || kind === 34) {
    writeFileMetadata(runtime, buffer, fileMetadata(runtime, opened.path), kind === 34);
    return complete(SUCCESS, size);
  }
  runtime.data.fill(0, buffer, buffer + size);
  if (kind === 14) runtime.view.setBigInt64(buffer, BigInt(opened.position), true);
  else {
    runtime.view.setBigInt64(buffer, BigInt(Math.ceil((bytes?.length ?? 0) / 4096) * 4096), true);
    runtime.view.setBigInt64(buffer + 8, BigInt(bytes?.length ?? 0), true);
    runtime.write32(buffer + 16, 1); // one link
    runtime.data[buffer + 20] = Number(runtime.pendingFileDeletes?.has(opened.path) ?? false);
    runtime.data[buffer + 21] = Number(opened.kind === 'file-directory');
  }
  return complete(SUCCESS, size);
}

export function fileShareConflict(runtime, path, access, share) {
  for (const opened of runtime.handles.values()) {
    if (opened.path !== path) continue;
    const previousShare = opened.share ?? 7;
    if (
      (access & 0x80000000 && !(previousShare & 1)) ||
      (access & 0x40000000 && !(previousShare & 2)) ||
      (opened.access & 0x80000000 && !(share & 1)) ||
      (opened.access & 0x40000000 && !(share & 2)) ||
      (access & 0x10000 && !(previousShare & 4)) ||
      (opened.access & 0x10000 && !(share & 4))
    )
      return true;
  }
  return false;
}

function checked(runtime, address, size, write = false) {
  try {
    if (size) runtime.check(address >>> 0, size, write);
    return true;
  } catch {
    return false;
  }
}

function iosb(runtime, address) {
  if (!checked(runtime, address, 8, true)) return null;
  return (status, information = 0) => {
    runtime.write32(address, status);
    runtime.write32(address + 4, information);
    return status;
  };
}

function regular(runtime, handle) {
  const opened = runtime.handles.get(handle >>> 0);
  return opened && runtime.files.has(opened.path) ? opened : null;
}

function directoryHandle(runtime, handle) {
  const opened = runtime.handles.get(handle >>> 0);
  return opened?.kind === 'file-directory' ? opened : null;
}

function offset(runtime, pointer, opened, append = false) {
  if (!pointer) return { value: opened.position >>> 0 };
  if (!checked(runtime, pointer, 8)) return { status: ACCESS_VIOLATION };
  const value = runtime.view.getBigInt64(pointer, true);
  if (value === -2n) return { value: opened.position >>> 0 };
  if (append && value === -1n) return { value: runtime.files.get(opened.path).length };
  if (value < 0 || value > BigInt(MAX_FILE)) return { status: INVALID_PARAMETER };
  return { value: Number(value) };
}

function synchronous(argument, name) {
  // KernelBase supplies the OVERLAPPED pointer as ApcContext even for a
  // synchronous file and no completion routine. With no APC/completion port
  // attached, the opaque context has no effect on immediate completion.
  if (argument(2) || argument(8)) throw Error(`Unsupported asynchronous ${name}`);
}

function ioCompletion(runtime, argument) {
  const complete = iosb(runtime, argument(4));
  if (!complete) return { status: ACCESS_VIOLATION };
  const handle = (argument(1) & ~1) >>> 0;
  if (!handle) return { complete };
  const event = syncObjects(runtime).lookup(handle, 'sync-event', SYNC.MODIFY);
  if (event.status) return { status: event.status };
  return {
    complete: (status, count = 0) => {
      const result = complete(status, count);
      syncObjects(runtime).change(handle, 'set');
      return result;
    },
  };
}

function read(runtime, argument) {
  synchronous(argument, 'NtReadFile');
  const io = ioCompletion(runtime, argument);
  if (io.status) return io.status;
  const { complete } = io;
  if (directoryHandle(runtime, argument(0))) return complete(0xc00000ba);
  const opened = regular(runtime, argument(0));
  if (!opened) return complete(INVALID_HANDLE);
  if (!(opened.access & 0x80000000)) return complete(ACCESS_DENIED);
  const count = argument(6) >>> 0;
  if (count > MAX_IO) throw Error('NtReadFile exceeds per-call limit');
  if (!checked(runtime, argument(5), count, true)) return complete(ACCESS_VIOLATION);
  const start = offset(runtime, argument(7), opened);
  if (start.status) return complete(start.status);
  if (fileLockConflict(runtime, argument(0), start.value, count))
    return complete(FILE_LOCK_CONFLICT);
  const source = runtime.files.get(opened.path);
  const transferred = Math.min(count, Math.max(0, source.length - start.value));
  if (transferred)
    runtime.data.set(source.subarray(start.value, start.value + transferred), argument(5) >>> 0);
  opened.position = start.value + transferred;
  if (transferred) touchFile(runtime, opened.path, { read: true });
  if (count && !transferred) return complete(END_OF_FILE);
  return complete(SUCCESS, transferred);
}

function write(runtime, argument) {
  synchronous(argument, 'NtWriteFile');
  const io = ioCompletion(runtime, argument);
  if (io.status) return io.status;
  const { complete } = io;
  if (directoryHandle(runtime, argument(0))) return complete(0xc00000ba);
  const count = argument(6) >>> 0;
  if (count > MAX_IO) throw Error('NtWriteFile exceeds per-call limit');
  if (!checked(runtime, argument(5), count)) return complete(ACCESS_VIOLATION);
  const handleValue = argument(0) >>> 0;
  const bytes = runtime.data.slice(argument(5) >>> 0, (argument(5) >>> 0) + count);
  if (handleValue === 1 || handleValue === 2) {
    if (runtime.closedStandardOutputs?.has(handleValue)) return complete(INVALID_HANDLE);
    if (argument(7)) return complete(INVALID_PARAMETER);
    runtime.stdoutBytes = (runtime.stdoutBytes || 0) + count;
    if (runtime.stdoutBytes > MAX_OUTPUT) throw Error('Console output limit exceeded');
    if (count)
      runtime.emit({ type: 'stdout', text: new TextDecoder('windows-1252').decode(bytes) });
    return complete(SUCCESS, count);
  }
  const opened = regular(runtime, handleValue);
  if (!opened) return complete(INVALID_HANDLE);
  if (!(opened.access & 0x40000000)) return complete(ACCESS_DENIED);
  const start = offset(runtime, argument(7), opened, true);
  if (start.status) return complete(start.status);
  if (opened.appendOnly) start.value = runtime.files.get(opened.path).length;
  if (start.value + count > MAX_FILE) return complete(DISK_FULL);
  if (fileLockConflict(runtime, handleValue, start.value, count, true))
    return complete(FILE_LOCK_CONFLICT);
  const previous = runtime.files.get(opened.path);
  const newLength = Math.max(previous.length, start.value + count);
  const total = [...runtime.files.values()].reduce((sum, file) => sum + file.length, 0);
  if (total + newLength - previous.length > MAX_FILESYSTEM) return complete(DISK_FULL);
  const updated = new Uint8Array(newLength);
  updated.set(previous);
  updated.set(bytes, start.value);
  runtime.files.set(opened.path, updated);
  runtime.fileSections?.fileChanged(opened.path);
  if (count) touchFile(runtime, opened.path, { write: true });
  opened.position = start.value + count;
  runtime.dirty.add(opened.path);
  return complete(SUCCESS, count);
}

function queryVolume(runtime, argument) {
  const complete = iosb(runtime, argument(1));
  if (!complete) return ACCESS_VIOLATION;
  const handle = argument(0) >>> 0;
  const isPipe = handle === 1 || handle === 2;
  if (isPipe && runtime.closedStandardOutputs?.has(handle)) return complete(INVALID_HANDLE);
  if (!isPipe && !regular(runtime, handle) && !directoryHandle(runtime, handle))
    return complete(INVALID_HANDLE);
  if (argument(4) >>> 0 === 1) {
    if (isPipe) return complete(INVALID_PARAMETER);
    const length = argument(3) >>> 0;
    if (length < 18) return complete(BUFFER_TOO_SMALL);
    if (!checked(runtime, argument(2), length, true)) return complete(ACCESS_VIOLATION);
    const buffer = argument(2) >>> 0,
      label = 'WineBrowser';
    runtime.data.fill(0, buffer, buffer + length);
    runtime.view.setBigInt64(buffer, runtime.packageFileTime, true);
    runtime.write32(buffer + 8, 0x57425231);
    runtime.write32(buffer + 12, label.length * 2);
    const characters = Math.min(label.length, Math.floor((length - 18) / 2));
    for (let i = 0; i < characters; i++)
      runtime.view.setUint16(buffer + 18 + i * 2, label.charCodeAt(i), true);
    return complete(characters === label.length ? SUCCESS : 0x80000005, 18 + characters * 2);
  }
  if (argument(4) >>> 0 !== 4)
    throw Error(`Unsupported Wine volume information class ${argument(4) >>> 0}`);
  const length = argument(3) >>> 0;
  if (length < 8) return complete(BUFFER_TOO_SMALL);
  if (!checked(runtime, argument(2), 8, true)) return complete(ACCESS_VIOLATION);
  runtime.write32(argument(2), isPipe ? FILE_DEVICE_NAMED_PIPE : FILE_DEVICE_DISK);
  runtime.write32((argument(2) >>> 0) + 4, 0);
  return complete(SUCCESS, 8);
}

export function closeFileHandle(runtime, handle) {
  const value = handle >>> 0;
  if (runtime.handles.get(value)?.kind === 'file-directory') {
    runtime.handles.delete(value);
    return SUCCESS;
  }
  if (value === 1 || value === 2) {
    const closed = (runtime.closedStandardOutputs ??= new Set());
    if (closed.has(value)) return INVALID_HANDLE;
    closed.add(value);
    return SUCCESS;
  }
  if (!regular(runtime, value)) return null;
  releaseHandleLocks(runtime, value);
  const opened = runtime.handles.get(value);
  runtime.handles.delete(value);
  if (
    runtime.pendingFileDeletes?.has(opened.path) &&
    ![...runtime.handles.values()].some((handle) => handle.path === opened.path)
  ) {
    runtime.files.delete(opened.path);
    runtime.fileTimes?.delete(opened.path);
    runtime.pendingFileDeletes.delete(opened.path);
    runtime.dirty.add(opened.path);
  }
  return SUCCESS;
}

function queryAttributes(runtime, argument, full) {
  if (!checked(runtime, argument(1), full ? 56 : 40, true)) return ACCESS_VIOLATION;
  const named = objectPath(runtime, argument(0), true);
  if (named.status) return named.status;
  const info = fileMetadata(runtime, named.path);
  if (info.status) return info.status;
  writeFileMetadata(runtime, argument(1), info, full);
  return SUCCESS;
}

function byteRangeLock(r, a, unlock) {
  const io = a(unlock ? 1 : 4),
    complete = io ? iosb(r, io) : (status) => status;
  if (!complete) return ACCESS_VIOLATION;
  const opened = regular(r, a(0));
  if (!opened) return complete(INVALID_HANDLE);
  if (!(opened.access & 0xc0000000)) return complete(ACCESS_DENIED);
  if ((!unlock && a(2)) || a(unlock ? 4 : 7)) return complete(NOT_SUPPORTED);
  const event = unlock ? 0 : (a(1) & ~1) >>> 0;
  if (event) {
    const found = syncObjects(r).lookup(event, 'sync-event', SYNC.MODIFY);
    if (found.status) return complete(found.status);
  }
  const offset = a(unlock ? 2 : 5),
    count = a(unlock ? 3 : 6);
  if (!checked(r, offset, 8) || !checked(r, count, 8)) return complete(ACCESS_VIOLATION);
  const start = r.view.getBigInt64(offset, true),
    length = r.view.getBigInt64(count, true);
  if (start < 0 || length <= 0 || start + length > 0x7fffffffffffffffn)
    return complete(INVALID_PARAMETER);
  const status = unlock
    ? releaseFileLock(r, a(0), start, length)
    : acquireFileLock(r, a(0), start, length, !!a(9));
  const finish = (status) => {
    const result = complete(status);
    if (!status && event) syncObjects(r).change(event, 'set');
    return result;
  };
  if (!unlock && status === LOCK_NOT_GRANTED && !a(8))
    return waitFileLock(r, a(0), start, length, !!a(9)).then(finish);
  return finish(status);
}

export const fileNtServices = {
  NtQueryDirectoryFile: { argc: 11, call: queryDirectory },
  // stdout/stderr are write-only byte pipes. CRT isatty/pipe probes must see
  // a normal NT failure for a read control request, rather than a host trap.
  NtFsControlFile: {
    argc: 10,
    call: (r, a) => {
      const complete = iosb(r, a(4));
      if (!complete) return ACCESS_VIOLATION;
      if (a(1) || a(2)) return complete(NOT_SUPPORTED);
      const handle = a(0) >>> 0;
      if (handle === 1 || handle === 2) {
        if (r.closedStandardOutputs?.has(handle)) return complete(INVALID_HANDLE);
        return complete(a(5) === 0x11400c ? ACCESS_DENIED : 0xc0000010);
      }
      return complete(regular(r, handle) ? 0xc0000010 : INVALID_HANDLE);
    },
  },
  NtLockFile: { argc: 10, call: (r, a) => byteRangeLock(r, a, false) },
  NtUnlockFile: { argc: 5, call: (r, a) => byteRangeLock(r, a, true) },
  NtFlushBuffersFile: {
    argc: 2,
    call: (r, a) => {
      const complete = iosb(r, a(1));
      if (!complete) return ACCESS_VIOLATION;
      const opened = regular(r, a(0));
      if (!opened) return complete(INVALID_HANDLE);
      if (!(opened.access & 0x40000000)) return complete(ACCESS_DENIED);
      // Writes already update the shared memory volume atomically. The worker
      // exports dirty files to browser storage after the process run completes.
      return complete(SUCCESS);
    },
  },
  NtQueryAttributesFile: { argc: 2, call: (r, a) => queryAttributes(r, a, false) },
  NtQueryFullAttributesFile: { argc: 2, call: (r, a) => queryAttributes(r, a, true) },
  NtCreateFile: { argc: 11, call: create },
  NtOpenFile: {
    argc: 6,
    call: (runtime, argument) =>
      create(
        runtime,
        (index) =>
          [
            argument(0),
            argument(1),
            argument(2),
            argument(3),
            0,
            0,
            argument(4),
            1,
            argument(5),
            0,
            0,
          ][index],
      ),
  },
  NtQueryInformationFile: {
    argc: 5,
    call: (runtime, argument) => information(runtime, argument, false),
  },
  NtSetInformationFile: {
    argc: 5,
    call: (runtime, argument) => information(runtime, argument, true),
  },
  NtQueryVolumeInformationFile: { argc: 5, call: queryVolume },
  NtReadFile: { argc: 9, call: read },
  NtWriteFile: { argc: 9, call: write },
};

function queryDirectory(r, a) {
  const complete = iosb(r, a(4));
  if (!complete) return ACCESS_VIOLATION;
  const opened = r.handles.get(a(0));
  if (opened?.kind !== 'file-directory') return complete(INVALID_HANDLE);
  if (!(opened.ntAccess & 1)) return complete(ACCESS_DENIED);
  if (a(1) || a(2) || a(3)) return complete(NOT_SUPPORTED);
  const kind = a(7),
    header = { 1: 64, 2: 68, 3: 94, 12: 12, 37: 104, 60: 88, 63: 114 }[kind];
  if (!header) return complete(NOT_SUPPORTED);
  if (!checked(r, a(5), a(6), true)) return complete(ACCESS_VIOLATION);
  if (a(10) || !opened.enumeration) {
    let pattern = '*';
    if (a(9)) {
      if (!checked(r, a(9), 8)) return complete(ACCESS_VIOLATION);
      const length = r.view.getUint16(a(9), true),
        max = r.view.getUint16(a(9) + 2, true),
        buffer = r.read32(a(9) + 4);
      if (length & 1 || length > max || length > 32766) return complete(INVALID_PARAMETER);
      if (!checked(r, buffer, length)) return complete(ACCESS_VIOLATION);
      pattern = '';
      for (let i = 0; i < length; i += 2)
        pattern += String.fromCharCode(r.view.getUint16(buffer + i, true));
      // Wine encodes DOS wildcard tokens when preparing FindFirstFile masks.
      pattern = pattern.replaceAll('<', '*').replaceAll('>', '?').replaceAll('"', '.');
      if (pattern === '*.*') pattern = '*';
      if (pattern.includes('/') || pattern.includes('\\') || pattern.includes('\0'))
        return complete(INVALID_PARAMETER);
    }
    const prefix = opened.path ? opened.path + '/' : '';
    opened.enumeration = {
      index: 0,
      entries: [...virtualNames(r, prefix).keys()]
        .filter((name) => matchWildcard(pattern, name))
        .map((name) => ({ name, path: prefix + name })),
    };
  }
  const scan = opened.enumeration;
  if (scan.index >= scan.entries.length) return complete(scan.index ? 0x80000006 : NAME_NOT_FOUND);
  let used = 0,
    previous = null;
  while (scan.index < scan.entries.length) {
    const entry = scan.entries[scan.index],
      nameBytes = entry.name.length * 2,
      size = Math.ceil((header + nameBytes) / 8) * 8;
    if (used + size > a(6)) return used ? complete(SUCCESS, used) : complete(BUFFER_TOO_SMALL);
    const pointer = a(5) + used,
      info = fileMetadata(r, entry.path);
    r.data.fill(0, pointer, pointer + size);
    r.write32(pointer + 4, scan.index);
    if (kind === 12) r.write32(pointer + 8, nameBytes);
    else {
      for (const [i, key] of ['creation', 'access', 'write', 'change'].entries())
        r.view.setBigInt64(pointer + 8 + i * 8, info[key], true);
      r.view.setBigInt64(pointer + 40, BigInt(info.size), true);
      r.view.setBigInt64(pointer + 48, BigInt(info.allocation), true);
      r.write32(pointer + 56, info.attributes);
      r.write32(pointer + 60, nameBytes);
      if ([60, 63].includes(kind))
        r.view.setBigUint64(pointer + 72, BigInt(fileIdentity(r, entry.path)), true);
      if (kind === 37) r.view.setBigUint64(pointer + 96, BigInt(fileIdentity(r, entry.path)), true);
    }
    for (let i = 0; i < entry.name.length; i++)
      r.view.setUint16(pointer + header + i * 2, entry.name.charCodeAt(i), true);
    if (previous !== null) r.write32(previous, pointer - previous);
    previous = pointer;
    used += size;
    scan.index++;
    if (a(8)) break;
  }
  return complete(SUCCESS, used);
}
