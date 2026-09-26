// Synchronous PE32 NT file services backed by Runtime's bounded virtual files.
import { resolveGuestPath } from './guest-paths.js';
import { fileMetadata, writeFileMetadata, touchFile } from './file-metadata.js';
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
  // Synchronous non-directory files only; never pretend to honor async I/O,
  // delete-on-close, EAs, reparse points, allocation hints or security policies.
  // SEQUENTIAL_ONLY (0x4) and RANDOM_ACCESS (0x800) are cache hints. Package
  // files are already memory-resident; both retain ordinary read/seek semantics.
  if (
    argument(4) ||
    argument(9) ||
    argument(10) ||
    options & ~0x864 ||
    !(options & 0x20) ||
    access & ~0xc012019f ||
    disposition === 0
  )
    return complete(NOT_SUPPORTED);
  if (!(access & 0x100000)) return complete(INVALID_PARAMETER);
  const named = objectPath(runtime, argument(2));
  if (named.status) return complete(named.status);
  const path = named.path,
    exists = runtime.files.has(path);
  // Attributes on an existing FILE_OPEN/FILE_OPEN_IF do not change that file.
  if (!(exists && [1, 3].includes(disposition)) && argument(5) & ~0xa0)
    return complete(NOT_SUPPORTED);
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  if (parent && ![...runtime.files.keys()].some((name) => name.startsWith(parent)))
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
      (readAccess ? 0x80000000 : 0) | (writeAccess ? 0x40000000 : 0),
      share,
    )
  )
    return complete(0xc0000043);
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
    access: ((readAccess ? 0x80000000 : 0) | (writeAccess ? 0x40000000 : 0)) >>> 0,
    ntAccess: access,
    share,
    options,
    inherit: !!(runtime.read32(argument(2) + 12) & 2),
    appendOnly: !!(access & 4) && !(access & 0x40000002),
  });
  runtime.write32(argument(0), handle);
  return complete(SUCCESS, !exists ? 2 : truncate ? 3 : 1);
}

function information(runtime, argument, set) {
  const complete = iosb(runtime, argument(1));
  if (!complete) return ACCESS_VIOLATION;
  const opened = regular(runtime, argument(0));
  if (!opened) return complete(INVALID_HANDLE);
  const kind = argument(4) >>> 0;
  const size =
    !set && kind === 4
      ? 40
      : !set && kind === 34
        ? 56
        : kind === 5 && !set
          ? 24
          : kind === 14 || (kind === 20 && set)
            ? 8
            : 0;
  if (!size) return complete(NOT_SUPPORTED);
  if (kind === 14 && !(opened.access & 0xc0000000)) return complete(ACCESS_DENIED);
  if ([4, 34].includes(kind) && !((opened.ntAccess ?? opened.access) & 0x80000080))
    return complete(ACCESS_DENIED);
  if (argument(3) >>> 0 < size) return complete(0xc0000004); // INFO_LENGTH_MISMATCH
  const buffer = argument(2) >>> 0;
  if (!checked(runtime, buffer, size, !set)) return complete(ACCESS_VIOLATION);
  const bytes = runtime.files.get(opened.path);
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
    runtime.view.setBigInt64(buffer, BigInt(Math.ceil(bytes.length / 4096) * 4096), true);
    runtime.view.setBigInt64(buffer + 8, BigInt(bytes.length), true);
    runtime.write32(buffer + 16, 1); // one link; not pending deletion or a directory
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
      (opened.access & 0x40000000 && !(share & 2))
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
  if (argument(1) || argument(2) || argument(3) || argument(8))
    throw Error(`Unsupported asynchronous ${name}`);
}

function read(runtime, argument) {
  synchronous(argument, 'NtReadFile');
  const complete = iosb(runtime, argument(4));
  if (!complete) return ACCESS_VIOLATION;
  const opened = regular(runtime, argument(0));
  if (!opened) return complete(INVALID_HANDLE);
  if (!(opened.access & 0x80000000)) return complete(ACCESS_DENIED);
  const count = argument(6) >>> 0;
  if (count > MAX_IO) throw Error('NtReadFile exceeds per-call limit');
  if (!checked(runtime, argument(5), count, true)) return complete(ACCESS_VIOLATION);
  const start = offset(runtime, argument(7), opened);
  if (start.status) return complete(start.status);
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
  const complete = iosb(runtime, argument(4));
  if (!complete) return ACCESS_VIOLATION;
  const count = argument(6) >>> 0;
  if (count > MAX_IO) throw Error('NtWriteFile exceeds per-call limit');
  if (!checked(runtime, argument(5), count)) return complete(ACCESS_VIOLATION);
  const handleValue = argument(0) >>> 0;
  const bytes = runtime.data.slice(argument(5) >>> 0, (argument(5) >>> 0) + count);
  if (handleValue === 1 || handleValue === 2) {
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
  if (!isPipe && !regular(runtime, handle)) return complete(INVALID_HANDLE);
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
  if (!regular(runtime, value)) return null;
  runtime.handles.delete(value);
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

export const fileNtServices = {
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
