// Synchronous PE32 NT file services backed by Runtime's bounded virtual files.
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
  if (start.value + count > MAX_FILE) return complete(DISK_FULL);
  const previous = runtime.files.get(opened.path);
  const newLength = Math.max(previous.length, start.value + count);
  const total = [...runtime.files.values()].reduce((sum, file) => sum + file.length, 0);
  if (total + newLength - previous.length > MAX_FILESYSTEM) return complete(DISK_FULL);
  const updated = new Uint8Array(newLength);
  updated.set(previous);
  updated.set(bytes, start.value);
  runtime.files.set(opened.path, updated);
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

export const fileNtServices = {
  NtQueryVolumeInformationFile: { argc: 5, call: queryVolume },
  NtReadFile: { argc: 9, call: read },
  NtWriteFile: { argc: 9, call: write },
};
