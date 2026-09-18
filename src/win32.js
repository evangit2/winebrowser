import { registryApis } from './win32-registry.js';
import { d3d9Apis } from './d3d9.js';
import { formatApis } from './win32-format.js';
import { processApis } from './win32-process.js';
import { audioApis } from './win32-audio.js';
import { gdiApis } from './win32-gdi.js';
import { windowApis } from './win32-windows.js';
import { acceleratorApis } from './win32-accelerators.js';
import { normalizePath } from './package.js';

// This small API provider is a bootstrap shim for the imported Win32 calls.
// Once Wine guest DLLs are available, this provider can be replaced by them.
// Runtime owns the common stdcall thunk mechanics; handlers here implement API behavior.
export const API_NAMES = {
  'kernel32.dll': [
    'ExitProcess',
    'GetStdHandle',
    'WriteFile',
    'ReadFile',
    'CreateFileA',
    'CreateFileW',
    'CloseHandle',
    'GetLastError',
    'SetLastError',
    'GetTickCount',
    'Sleep',
    'Beep',
    'GetModuleHandleA',
  ],
  'user32.dll': ['MessageBoxA', 'MessageBoxW'],
};

for (const key of [
  ...Object.keys(processApis),
  ...Object.keys(audioApis),
  ...Object.keys(gdiApis),
  ...Object.keys(windowApis),
  ...Object.keys(acceleratorApis),
  ...Object.keys(formatApis),
  ...Object.keys(registryApis),
  ...Object.keys(d3d9Apis),
]) {
  const [dll, name] = key.split('!');
  API_NAMES[dll] ??= [];
  if (!API_NAMES[dll].includes(name)) API_NAMES[dll].push(name);
}

export const importKey = (dll, name) => `${dll.toLowerCase()}!${name}`;

function success(result = 0, argc = 0) {
  return { result, argc };
}

function failure(runtime, error, argc = 0) {
  runtime.lastError = error;
  return success(0, argc);
}

function exitProcess(runtime, argument) {
  runtime.exitCode = argument(0);
  return success(0, 1);
}

function getStdHandle(runtime, argument) {
  const id = argument(0);
  const handle = id === 0xfffffff5 ? 1 : id === 0xfffffff4 ? 2 : null;
  return handle === null ? failure(runtime, 6, 1) : success(handle, 1);
}

function getLastError(runtime) {
  return success(runtime.lastError);
}

function setLastError(runtime, argument) {
  runtime.lastError = argument(0);
  return success(0, 1);
}

function getTickCount() {
  return success(Math.floor(performance.now()) >>> 0);
}

function getModuleHandle(runtime, argument) {
  if (argument(0)) throw Error('Named module resolution is not implemented');
  return success(runtime.pe.imageBase, 1);
}

async function sleep(_runtime, argument) {
  const milliseconds = argument(0);
  if (milliseconds > 10000) throw Error('Sleep exceeds prototype 10-second limit');
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return success(0, 1);
}

async function beep(runtime, argument) {
  const frequency = argument(0);
  const duration = argument(1);
  if (frequency < 37 || frequency > 32767 || duration > 10000) return failure(runtime, 87, 2);
  return success(await runtime.request('beep', { frequency, duration }), 2);
}

async function messageBox(runtime, argument, wide = false) {
  const owner = argument(0);
  const options = argument(3);
  if (options & ~0x70 || ![0, 0x10, 0x20, 0x30, 0x40].includes(options))
    throw Error('MessageBox currently supports MB_OK with standard icons only');
  const window = owner ? runtime.windows.windows.get(owner) : null;
  if (owner && !window) return failure(runtime, 1400, 4);
  const detail = {
    owner,
    icon: { 16: 'error', 32: 'question', 48: 'warning', 64: 'information' }[options] ?? null,
    text: argument(1) ? (wide ? runtime.wideString(argument(1)) : runtime.string(argument(1))) : '',
    title: argument(2)
      ? wide
        ? runtime.wideString(argument(2))
        : runtime.string(argument(2))
      : 'Error',
  };
  const wasEnabled = window && window.enabled !== false;
  try {
    if (wasEnabled) {
      window.enabled = false;
      runtime.windows.emit(window);
      await runtime.windows.send(owner, 0xa, 0); // WM_ENABLE
    }
    return success(await runtime.request('messagebox', detail), 4);
  } finally {
    if (wasEnabled && runtime.windows.windows.has(owner)) {
      window.enabled = true;
      runtime.windows.emit(window);
      await runtime.windows.send(owner, 0xa, 1);
      runtime.emit({ type: 'window-focus', windowId: owner });
    }
  }
}

function createFile(runtime, argument, wide = false) {
  const access = argument(1);
  const mode = argument(4);
  if (
    argument(2) > 7 ||
    argument(3) ||
    argument(5) & ~0x80 ||
    argument(6) ||
    ![0x80000000, 0x40000000, 0xc0000000].includes(access) ||
    ![2, 3].includes(mode)
  ) {
    throw Error('Unsupported CreateFileA flags/access/disposition');
  }

  let path;
  try {
    // Validate the guest path before adding cwd so absolute paths cannot be
    // accidentally converted into relative paths beneath the package root.
    const requestedPath = normalizePath(
      (wide ? runtime.wideString(argument(0)) : runtime.string(argument(0))).replaceAll('\\', '/'),
    );
    path = normalizePath(runtime.cwd + requestedPath);
  } catch {
    runtime.lastError = 123;
    return success(0xffffffff, 7);
  }

  if (mode === 3 && !runtime.files.has(path)) {
    runtime.lastError = 2;
    return success(0xffffffff, 7);
  }
  if (mode === 2) {
    if (!(access & 0x40000000)) {
      runtime.lastError = 5;
      return success(0xffffffff, 7);
    }
    runtime.files.set(path, new Uint8Array());
    runtime.dirty.add(path);
  }

  if (runtime.handles.size >= 4096) throw Error('Open handle limit exceeded');
  if (runtime.files.size > 4096) throw Error('Virtual file count limit exceeded');
  const handle = runtime.nextHandle++;
  runtime.handles.set(handle, { path, position: 0, access });
  return success(handle, 7);
}

function readFile(runtime, argument) {
  if (argument(4)) throw Error('Overlapped I/O unsupported');
  const handle = runtime.handles.get(argument(0));
  if (!handle || !(handle.access & 0x80000000)) return failure(runtime, 6, 5);

  const bytes = runtime.files.get(handle.path);
  const count = Math.min(argument(2), Math.max(0, bytes.length - handle.position));
  const address = argument(1);
  runtime.check(address, count, true);
  runtime.data.set(bytes.subarray(handle.position, handle.position + count), address);
  handle.position += count;
  runtime.write32(argument(3), count);
  return success(1, 5);
}

function writeFile(runtime, argument) {
  if (argument(4)) throw Error('Overlapped I/O unsupported');
  const count = argument(2);
  if (count > 4 * 1024 * 1024) throw Error('WriteFile exceeds per-call limit');
  const address = argument(1);
  runtime.check(address, count);
  const bytes = runtime.data.slice(address, address + count);
  const handleValue = argument(0);

  if (handleValue === 1 || handleValue === 2) {
    runtime.stdoutBytes = (runtime.stdoutBytes || 0) + count;
    if (runtime.stdoutBytes > 1024 * 1024) throw Error('Console output limit exceeded');
    runtime.emit({ type: 'stdout', text: new TextDecoder('windows-1252').decode(bytes) });
  } else {
    const handle = runtime.handles.get(handleValue);
    if (!handle || !(handle.access & 0x40000000)) return failure(runtime, 6, 5);
    if (handle.position + count > 16 * 1024 * 1024) throw Error('Virtual file size limit exceeded');
    const previousBytes = runtime.files.get(handle.path);
    const newLength = Math.max(previousBytes.length, handle.position + count);
    const total = [...runtime.files.values()].reduce((sum, b) => sum + b.length, 0);
    if (total + newLength - previousBytes.length > 128 * 1024 * 1024)
      throw Error('Virtual filesystem size limit exceeded');
    const updatedBytes = new Uint8Array(newLength);
    updatedBytes.set(previousBytes);
    updatedBytes.set(bytes, handle.position);
    runtime.files.set(handle.path, updatedBytes);
    handle.position += count;
    runtime.dirty.add(handle.path);
  }

  runtime.write32(argument(3), count);
  return success(1, 5);
}

function closeHandle(runtime, argument) {
  return runtime.handles.delete(argument(0)) ? success(1, 1) : failure(runtime, 6, 1);
}

/** Provide the explicitly supported Win32 imports for a single Runtime. */
export function createWin32ApiProvider() {
  return new Map([
    ...Object.entries(processApis),
    ...Object.entries(audioApis),
    ...Object.entries(gdiApis),
    ...Object.entries(windowApis),
    ...Object.entries(acceleratorApis),
    ...Object.entries(formatApis),
    ...Object.entries(registryApis),
    ...Object.entries(d3d9Apis),
    ['kernel32.dll!ExitProcess', exitProcess],
    ['kernel32.dll!GetStdHandle', getStdHandle],
    ['kernel32.dll!WriteFile', writeFile],
    ['kernel32.dll!ReadFile', readFile],
    ['kernel32.dll!CreateFileA', createFile],
    ['kernel32.dll!CreateFileW', (r, a) => createFile(r, a, true)],
    ['kernel32.dll!CloseHandle', closeHandle],
    ['kernel32.dll!GetLastError', getLastError],
    ['kernel32.dll!SetLastError', setLastError],
    ['kernel32.dll!GetTickCount', getTickCount],
    ['kernel32.dll!Sleep', sleep],
    ['kernel32.dll!Beep', beep],
    ['user32.dll!MessageBoxA', messageBox],
    ['user32.dll!MessageBoxW', (r, a) => messageBox(r, a, true)],
  ]);
}
