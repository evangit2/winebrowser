import { releaseHandleLocks, fileLockConflict } from './file-locks.js';
import { shellFolderApis } from './win32-shell-folders.js';
import { lzApis } from './win32-lz.js';
import { legacyUiApis } from './win32-legacy-ui.js';
import { dpiApis } from './win32-dpi.js';
import { pathApis } from './win32-paths.js';
import { registryApis } from './win32-registry.js';
import { comApis } from './win32-com.js';
import { dinput8Apis } from './dinput8.js';
import { d3d9Apis } from './d3d9.js';
import { vulkanApis } from './vulkan.js';
import { paintApis } from './win32-paint.js';
import { d3d12Apis, dxgiApis } from './d3d12.js';
import { d3d10Apis } from './d3d10.js';
import { openglApis } from './opengl.js';
import { d3dCompilerApis } from './d3dcompiler.js';
import { formatApis } from './win32-format.js';
import { processApis } from './win32-process.js';
import { syncApis } from './win32-sync.js';
import { threadApis } from './win32-threads.js';
import { duplicateApis } from './duplicate-handle.js';
import { audioApis } from './win32-audio.js';
import { gdiApis } from './win32-gdi.js';
import { windowApis } from './win32-windows.js';
import { menuApis } from './win32-menus.js';
import {
  imeApis,
  comDlgApis,
  serialApis,
  imeExtraApis,
  dialogExtraApis,
} from './win32-ime-dialogs.js';
import { dialogApis } from './win32-dialogs.js';
import { acceleratorApis } from './win32-accelerators.js';
import { displayApis } from './win32-display.js';
import { iconApis } from './win32-icons.js';
import { resolveGuestPath } from './guest-paths.js';
import { closeFileHandle, fileShareConflict } from './wine-file.js';
import { touchFile, fileMetadata, FILE_PATH_NOT_FOUND } from './file-metadata.js';
import { fileMetadataApis } from './win32-file-metadata.js';
import { fileSectionApis } from './win32-sections.js';
import { nativeForwarderApis } from './win32-native-forwarders.js';
import { randomApis } from './win32-random.js';
import { guestHandleFlags } from './wine-object.js';
import { splitGuestCounter } from './guest-clock.js';
import {
  startupApis,
  startupApis2,
  startupApis3,
  startupApis4,
  startupApis5,
} from './win32-startup.js';
import { systemApis, systemApis2, systemApis3, systemApis4 } from './win32-system.js';
import { ws2Apis, WS2_NAMES } from './ws2_32.js';
import { msvcrtApis, msacmApis } from './msvcrt.js';
import { VERSIONED_CRT_EXPORT_NAMES } from './msvcrt-versioned-exports.js';
import { WINE_KERNELBASE_EXPORTS } from './wine-kernelbase-exports.js';

// This small API provider is a bootstrap shim for the imported Win32 calls.
// Once Wine guest DLLs are available, this provider can be replaced by them.
// Runtime owns the common stdcall thunk mechanics; handlers here implement API behavior.
// The versioned Visual C++ runtimes are binary-compatible supersets of msvcrt
// for the C entry points, so an application built against msvcr70..msvcr120
// resolves through the same implementation. Each alias is registered explicitly
// against the msvcrt handlers rather than rewriting the guest's import table.
export const CRT_ALIAS_DLLS = [
  'msvcr70.dll',
  'msvcr71.dll',
  'msvcr80.dll',
  'msvcr90.dll',
  'msvcr100.dll',
  'msvcr110.dll',
  'msvcr120.dll',
];

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
    'GetTickCount64',
    'Sleep',
    'Beep',
    'GetModuleHandleA',
  ],
  'user32.dll': ['MessageBoxA', 'MessageBoxW'],
};

for (const key of [
  ...Object.keys(shellFolderApis),
  ...Object.keys(lzApis),
  ...Object.keys(legacyUiApis),
  ...Object.keys(dpiApis),
  ...Object.keys(pathApis),
  ...Object.keys(processApis),
  ...Object.keys(fileMetadataApis),
  ...Object.keys(fileSectionApis),
  ...Object.keys(syncApis),
  ...Object.keys(threadApis),
  ...Object.keys(duplicateApis),
  ...Object.keys(audioApis),
  ...Object.keys(gdiApis),
  ...Object.keys(windowApis),
  ...Object.keys(menuApis),
  ...Object.keys(imeApis),
  ...Object.keys(comDlgApis),
  ...Object.keys(serialApis),
  ...Object.keys(imeExtraApis),
  ...Object.keys(dialogExtraApis),
  ...Object.keys(dialogApis),
  ...Object.keys(acceleratorApis),
  ...Object.keys(displayApis),
  ...Object.keys(iconApis),
  ...Object.keys(formatApis),
  ...Object.keys(nativeForwarderApis),
  ...Object.keys(randomApis),
  ...Object.keys(startupApis),
  ...Object.keys(startupApis2),
  ...Object.keys(startupApis3),
  ...Object.keys(startupApis4),
  ...Object.keys(startupApis5),
  ...Object.keys(systemApis),
  ...Object.keys(systemApis2),
  ...Object.keys(systemApis3),
  ...Object.keys(systemApis4),
  ...Object.keys(ws2Apis),
  ...Object.keys(msvcrtApis),
  ...Object.keys(msacmApis),
  ...Object.keys(registryApis),
  ...Object.keys(comApis),
  ...Object.keys(d3d9Apis),
  ...Object.keys(vulkanApis),
  ...Object.keys(paintApis),
  ...Object.keys(dinput8Apis),
  ...Object.keys(d3d12Apis),
  ...Object.keys(d3d10Apis),
  ...Object.keys(openglApis),
  ...Object.keys(d3dCompilerApis),
  ...Object.keys(dxgiApis),
]) {
  const [dll, name] = key.split('!');
  API_NAMES[dll] ??= [];
  if (!API_NAMES[dll].includes(name)) API_NAMES[dll].push(name);
}

export const importKey = (dll, name) => `${dll.toLowerCase()}!${name}`;

// Share implemented services within Wine's actual KernelBase export boundary.
// Unknown APIs and native-only forwarders remain absent. Supplied/source-built
// KernelBase images retain normal DLL search precedence.
const kernelbaseAliases = new Map();
for (const dll of ['kernel32.dll', 'advapi32.dll', 'user32.dll'])
  for (const symbol of API_NAMES[dll] ?? []) {
    const key = importKey(dll, symbol);
    if (WINE_KERNELBASE_EXPORTS.has(symbol) && !nativeForwarderApis[key])
      kernelbaseAliases.set(symbol, key);
  }
API_NAMES['kernelbase.dll'] = [...kernelbaseAliases.keys()];

// The versioned CRT names belong to the module graph's DLL table, which is read
// before any Runtime exists, so publish the full union here at module load. The
// handler map is filled by createWin32ApiProvider from the same name list.
for (const alias of CRT_ALIAS_DLLS) {
  if (API_NAMES[alias]?.length) continue;
  API_NAMES[alias] = [...new Set([...API_NAMES['msvcrt.dll'], ...VERSIONED_CRT_EXPORT_NAMES])];
}

// The alias name lists are populated as soon as the provider map exists, which
// happens below at module load: the module graph consults API_NAMES before any
// runtime is constructed, so a lazily registered alias would be reported as a
// missing DLL.
export function registerCrtAliases(provider, names) {
  for (const alias of CRT_ALIAS_DLLS) {
    for (const symbol of names[alias] ?? []) {
      const key = `${alias}!${symbol}`;
      if (provider.has(key)) continue;
      const handler = provider.get(`msvcrt.dll!${symbol}`);
      if (handler) provider.set(key, handler);
    }
  }
}

function success(result = 0, argc = 0) {
  return { result, argc };
}

function failure(runtime, error, argc = 0) {
  runtime.lastError = error;
  return success(0, argc);
}

async function exitProcess(runtime, argument) {
  const code = argument(0);
  runtime.exitCode = code;
  await runtime.shutdownProcess();
  runtime.threads.terminateProcess(code);
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

function getTickCount(runtime) {
  return success(Number((runtime.performanceClock.read() / 1_000_000n) & 0xffffffffn));
}

function getModuleHandle(runtime, argument) {
  if (argument(0)) throw Error('Named module resolution is not implemented');
  return success(runtime.pe.imageBase, 1);
}

async function sleep(runtime, argument) {
  const milliseconds = argument(0);
  if (milliseconds > 10000) throw Error('Sleep exceeds prototype 10-second limit');
  await runtime.threads.delay(milliseconds);
  return success(0, 1);
}

async function beep(runtime, argument) {
  const frequency = argument(0);
  const duration = argument(1);
  if (frequency < 37 || frequency > 32767 || duration > 10000) return failure(runtime, 87, 2);
  return success(await runtime.request('beep', { frequency, duration }), 2);
}

// MB_* flags, from winuser.h. The button set and icon are the parts that
// change the dialog; modality, foreground, topmost, right-align and RTL hints
// describe placement the browser desktop already controls, so they are accepted
// and simply carried through for the caller to ignore.
const MB_ICONS = new Set([0, 0x10, 0x20, 0x30, 0x40]),
  // Modality, foreground, topmost, right-align and RTL are placement hints the
  // browser desktop already controls; MB_SERVICE_NOTIFICATION appears in
  // ordinary MessageBoxA calls from CRT and installer code.
  MB_STYLE =
    0x1000 | 0x2000 | 0x4000 | 0x8000 | 0x10000 | 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x200000;
async function messageBox(runtime, argument, wide = false) {
  const owner = argument(0);
  const options = argument(3);
  const buttons = options & 7,
    icon = options & 0x70,
    defButton = options & 0xf00,
    style = options & MB_STYLE;
  if (
    options & ~(7 | 0x70 | 0xf00 | MB_STYLE) ||
    buttons !== 0 ||
    !MB_ICONS.has(icon) ||
    defButton > 0x300
  )
    throw Error(
      'MessageBox flags 0x' +
        options.toString(16) +
        ' unsupported: only MB_OK with a standard icon is rendered',
    );
  const window = owner ? runtime.windows.windows.get(owner) : null;
  if (owner && !window) return failure(runtime, 1400, 4);
  const detail = {
    owner,
    icon: { 16: 'error', 32: 'question', 48: 'warning', 64: 'information' }[icon] ?? null,
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

// CreateFileA(FileName, DesiredAccess, ShareMode, SecurityAttributes,
//             CreationDisposition, FlagsAndAttributes, TemplateFile).
// Generic read/write (0x80000000/0x40000000) cover the ordinary cases; the
// file-specific rights (FILE_READ_DATA 0x1, FILE_WRITE_DATA 0x2, ...) are
// translated to them because the virtual filesystem has no security model.
const FILE_GENERIC_READ = 0x80000000,
  FILE_GENERIC_WRITE = 0x40000000,
  ACCESS_MASK_READ = 0x0001 | 0x0008 | 0x0020 | 0x0080,
  ACCESS_MASK_WRITE = 0x0002 | 0x0004 | 0x0010 | 0x0100,
  CREATE_DISPOSITION = new Set([1, 2, 3, 4, 5]);
function createFile(runtime, argument, wide = false) {
  const requested = argument(1);
  const share = argument(2);
  const mode = argument(4);
  const flags = argument(5);
  // SECURITY_ATTRIBUTES only describes handle inheritance; the runtime tracks
  // that per handle, so a supplied structure is validated but not stored here.
  if (argument(3)) {
    try {
      runtime.check(argument(3), 12);
    } catch {
      throw Error('CreateFile SECURITY_ATTRIBUTES is outside guest memory');
    }
  }
  if (share > 7 || argument(6) || !CREATE_DISPOSITION.has(mode))
    throw Error(
      'Unsupported CreateFile share/disposition/template: ' +
        [argument(2), mode, argument(6)].join(','),
    );
  // The flags word mixes FILE_ATTRIBUTE_* with FILE_FLAG_* hints about caching,
  // access pattern and reparse behaviour. The virtual filesystem is
  // memory-backed, so those hints describe nothing to do and are accepted.
  // FILE_FLAG_OVERLAPPED is the one exception: the read/write entry points
  // reject any OVERLAPPED structure, so accepting the flag would be a lie.
  if (flags & 0x40000000) throw Error('Overlapped CreateFile is unsupported');
  let access = 0;
  if (requested & (FILE_GENERIC_READ | ACCESS_MASK_READ)) access |= FILE_GENERIC_READ;
  if (requested & (FILE_GENERIC_WRITE | ACCESS_MASK_WRITE)) access |= FILE_GENERIC_WRITE;
  if (!access && requested) throw Error('Unsupported CreateFile access mask');
  if (!access) access = FILE_GENERIC_READ;

  let path;
  try {
    path = resolveGuestPath(
      wide ? runtime.wideString(argument(0)) : runtime.string(argument(0)),
      runtime.cwd,
    );
  } catch {
    runtime.lastError = 123;
    return success(0xffffffff, 7);
  }

  const metadata = fileMetadata(runtime, path);
  if (metadata.directory || metadata.status === FILE_PATH_NOT_FOUND) {
    runtime.lastError = metadata.directory ? 5 : 3;
    return success(0xffffffff, 7);
  }
  const exists = runtime.files.has(path);
  // CREATE_NEW (1) fails when the file exists; OPEN_EXISTING (3) and
  // TRUNCATE_EXISTING (5) fail when it does not.
  if (mode === 1 && exists) {
    runtime.lastError = 80; // ERROR_FILE_EXISTS
    return success(0xffffffff, 7);
  }
  if ((mode === 3 || mode === 5) && !exists) {
    runtime.lastError = 2;
    return success(0xffffffff, 7);
  }
  if (fileShareConflict(runtime, path, access, share)) {
    runtime.lastError = 32;
    return success(0xffffffff, 7);
  }
  if (runtime.handles.size >= 4096) throw Error('Open handle limit exceeded');
  if (!runtime.files.has(path) && runtime.files.size >= 4096)
    throw Error('Virtual file count limit exceeded');
  // CREATE_NEW (1) creates a file that does not exist yet, CREATE_ALWAYS (2)
  // and OPEN_ALWAYS (4) create a missing file, and TRUNCATE_EXISTING (5) empties
  // one. All of them need write access. CREATE_NEW was missing from this set, so
  // its newly opened file was never added to the filesystem: the handle was real
  // but the first WriteFile through it failed.
  if (mode === 1 || mode === 2 || mode === 4 || mode === 5) {
    const mustCreate = mode === 1 || mode === 2 || (mode === 4 && !exists);
    const mustTruncate = mode === 2 || mode === 5;
    if ((mustCreate || mustTruncate) && !(access & 0x40000000)) {
      runtime.lastError = 5;
      return success(0xffffffff, 7);
    }
    if (mustTruncate && exists && runtime.fileSections?.canResize(path, 0) === false) {
      runtime.lastError = 1224; // ERROR_USER_MAPPED_FILE
      return success(0xffffffff, 7);
    }
    // A created file is a real (empty) entry in the virtual filesystem, not
    // just a timestamp: everything that reads the tree (FindFirstFile,
    // GetFileAttributes) and every later read/write resolves through this map.
    if (mustCreate) {
      touchFile(runtime, path, { created: true, write: true });
      runtime.files.set(path, new Uint8Array());
      runtime.fileSections?.fileChanged(path);
      runtime.dirty.add(path);
    }
    if (mustTruncate) {
      runtime.files.set(path, new Uint8Array());
      runtime.fileSections?.fileChanged(path);
      runtime.dirty.add(path);
    }
  }

  const handle = runtime.nextHandle++;
  runtime.handles.set(handle, { path, position: 0, access, share });
  return success(handle, 7);
}

function readFile(runtime, argument) {
  if (argument(4)) throw Error('Overlapped I/O unsupported');
  const handle = runtime.handles.get(argument(0));
  if (!handle || !(handle.access & 0x80000000)) return failure(runtime, 6, 5);

  const bytes = runtime.files.get(handle.path);
  if (fileLockConflict(runtime, argument(0), handle.position, argument(2)))
    return failure(runtime, 33, 5);
  const count = Math.min(argument(2), Math.max(0, bytes.length - handle.position));
  const address = argument(1);
  runtime.check(address, count, true);
  runtime.data.set(bytes.subarray(handle.position, handle.position + count), address);
  handle.position += count;
  if (count) touchFile(runtime, handle.path, { read: true });
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
    if (runtime.closedStandardOutputs?.has(handleValue)) return failure(runtime, 6, 5);
    runtime.stdoutBytes = (runtime.stdoutBytes || 0) + count;
    if (runtime.stdoutBytes > 1024 * 1024) throw Error('Console output limit exceeded');
    runtime.emit({ type: 'stdout', text: new TextDecoder('windows-1252').decode(bytes) });
  } else {
    const handle = runtime.handles.get(handleValue);
    if (!handle || !(handle.access & 0x40000000)) return failure(runtime, 6, 5);
    if (fileLockConflict(runtime, handleValue, handle.position, count, true))
      return failure(runtime, 33, 5);
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
    runtime.fileSections?.fileChanged(handle.path);
    if (count) touchFile(runtime, handle.path, { write: true });
    handle.position += count;
    runtime.dirty.add(handle.path);
  }

  runtime.write32(argument(3), count);
  return success(1, 5);
}

function closeHandle(runtime, argument) {
  if ((guestHandleFlags(runtime, argument(0)) ?? 0) & 2) return failure(runtime, 6, 1);
  const sectionStatus = runtime.fileSections?.close(argument(0)) ?? null;
  if (sectionStatus !== null) return sectionStatus ? failure(runtime, 6, 1) : success(1, 1);
  const status = runtime.syncObjects?.close(argument(0)) ?? null;
  if (status !== null) return status ? failure(runtime, 6, 1) : success(1, 1);
  const fileStatus = closeFileHandle(runtime, argument(0));
  if (fileStatus !== null) return fileStatus ? failure(runtime, 6, 1) : success(1, 1);
  releaseHandleLocks(runtime, argument(0));
  return runtime.handles.delete(argument(0)) ? success(1, 1) : failure(runtime, 6, 1);
}

/** Provide the explicitly supported Win32 imports for a single Runtime. */
export function createWin32ApiProvider() {
  const provider = new Map([
    ...Object.entries(shellFolderApis),
    ...Object.entries(lzApis),
    ...Object.entries(legacyUiApis),
    ...Object.entries(dpiApis),
    ...Object.entries(pathApis),
    ...Object.entries(processApis),
    ...Object.entries(fileMetadataApis),
    ...Object.entries(fileSectionApis),
    ...Object.entries(syncApis),
    ...Object.entries(threadApis),
    ...Object.entries(duplicateApis),
    ...Object.entries(audioApis),
    ...Object.entries(gdiApis),
    ...Object.entries(windowApis),
    ...Object.entries(menuApis),
    ...Object.entries(imeApis),
    ...Object.entries(comDlgApis),
    ...Object.entries(serialApis),
    ...Object.entries(imeExtraApis),
    ...Object.entries(dialogExtraApis),
    ...Object.entries(dialogApis),
    ...Object.entries(acceleratorApis),
    ...Object.entries(displayApis),
    ...Object.entries(iconApis),
    ...Object.entries(msvcrtApis),
    ...Object.entries(formatApis),
    ...Object.entries(nativeForwarderApis),
    ...Object.entries(randomApis),
    ...Object.entries(registryApis),
    ...Object.entries(comApis),
    ...Object.entries(d3d9Apis),
    ...Object.entries(vulkanApis),
    ...Object.entries(paintApis),
    ...Object.entries(dinput8Apis),
    ...Object.entries(d3d12Apis),
    ...Object.entries(d3d10Apis),
    ...Object.entries(openglApis),
    ...Object.entries(d3dCompilerApis),
    ...Object.entries(dxgiApis),
    ...Object.entries(startupApis),
    ...Object.entries(startupApis2),
    ...Object.entries(startupApis3),
    ...Object.entries(startupApis4),
    ...Object.entries(startupApis5),
    ...Object.entries(systemApis),
    ...Object.entries(systemApis2),
    ...Object.entries(systemApis3),
    ...Object.entries(systemApis4),
    ...Object.entries(ws2Apis),
    ...Object.entries(msacmApis),
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
    [
      'kernel32.dll!GetTickCount64',
      (r) => {
        const { low, high } = splitGuestCounter(r.performanceClock.read() / 1_000_000n);
        return { result: low, resultHigh: high, argc: 0 };
      },
    ],
    ['kernel32.dll!Sleep', sleep],
    ['kernel32.dll!Beep', beep],
    ['user32.dll!MessageBoxA', messageBox],
    ['user32.dll!MessageBoxW', (r, a) => messageBox(r, a, true)],
  ]);
  registerCrtAliases(provider, API_NAMES);
  for (const [symbol, source] of kernelbaseAliases)
    if (provider.has(source))
      provider.set(importKey('kernelbase.dll', symbol), provider.get(source));
  return provider;
}
