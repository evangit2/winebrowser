import { PROCESS_LAYOUT } from './process-layout.js';
import { packageDosPath, resolveGuestPath } from './guest-paths.js';
import { fileMetadata } from './file-metadata.js';

const CURRENT_DIRECTORY = 0x24;
function nativeParameters(r) {
  if (!r.wineProcess?.parameters) return 0;
  const pointer = r.read32(PROCESS_LAYOUT.peb + 0x10) >>> 0;
  r.check(pointer, CURRENT_DIRECTORY + 12);
  if (!(r.read32(pointer + 8) & 1)) throw Error('Unnormalized process parameters');
  return pointer;
}

// The normalized PE32 CURDIR belongs to Wine. Read its counted UTF-16 path,
// including native changes made without ever entering a host Win32 handler.
export function currentProcessDirectory(r) {
  const parameters = nativeParameters(r);
  if (!parameters) return r._cwd ?? '';
  const descriptor = parameters + CURRENT_DIRECTORY;
  const handle = r.handles.get(r.read32(descriptor + 8) >>> 0);
  if (handle?.kind === 'file-directory') {
    // Wine publishes its new CURDIR handle before copying the DOS text while
    // holding the PEB lock. The handle names the actual opened directory and
    // avoids observing an intermediate text copy if another guest thread runs.
    r._cwd = handle.path ? handle.path + '/' : '';
    return r._cwd;
  }
  const length = r.guestMemory.read(descriptor, 2),
    capacity = r.guestMemory.read(descriptor + 2, 2),
    buffer = r.read32(descriptor + 4) >>> 0;
  if (!length || length & 1 || length > capacity) throw Error('Invalid process current directory');
  const bytes = r.guestMemory.readBytes(buffer, length);
  let value = '';
  for (let at = 0; at < bytes.length; at += 2)
    value += String.fromCharCode(bytes[at] | (bytes[at + 1] << 8));
  const path = resolveGuestPath(value, '', { allowRoot: true });
  r._cwd = path ? path + '/' : '';
  return r._cwd;
}

// Return a Win32 error (zero means success). Native RtlSetCurrentDirectory_U
// owns opening/replacing/closing CURDIR handles, locks and private reference
// state. Replacing only the PEB text would leave that state inconsistent.
export async function setProcessDirectory(r, path) {
  const metadata = fileMetadata(r, path);
  if (metadata.status) return 3;
  if (!metadata.directory) return 267;
  const value = packageDosPath(path, true);
  if (value.length > 32766) return 206;
  const parameters = nativeParameters(r);
  if (parameters) {
    const capacity = r.guestMemory.read(parameters + CURRENT_DIRECTORY + 2, 2);
    if ((value.length + 1) * 2 > capacity) return 206;
    const module = r.wineProcess.module;
    const setter = module.pe.exports.find((entry) => entry.name === 'RtlSetCurrentDirectory_U');
    const convert = module.pe.exports.find((entry) => entry.name === 'RtlNtStatusToDosError');
    if (!setter || setter.forwarder || !convert || convert.forwarder) return 120;
    const descriptor = r.allocate(8 + (value.length + 1) * 2);
    try {
      r.guestMemory.write(descriptor, value.length * 2, 2);
      r.guestMemory.write(descriptor + 2, (value.length + 1) * 2, 2);
      r.write32(descriptor + 4, descriptor + 8);
      for (let i = 0; i <= value.length; i++)
        r.guestMemory.write(descriptor + 8 + i * 2, value.charCodeAt(i) || 0, 2);
      const status = (await r.callGuest(module.base + setter.rva, [descriptor])) >>> 0;
      if (status) return (await r.callGuest(module.base + convert.rva, [status])) >>> 0;
    } finally {
      r.free(descriptor);
    }
  } else if (r.bootstrapProcessParameters && r.hostCurrentDirectoryBuffer) {
    // The host-only process has its own normalized bootstrap parameters,
    // which ordinary native CRT code can also inspect directly.
    const buffer = r.allocString(value, true);
    const descriptor = r.bootstrapProcessParameters + CURRENT_DIRECTORY;
    r.guestMemory.write(descriptor, value.length * 2, 2);
    r.guestMemory.write(descriptor + 2, (value.length + 1) * 2, 2);
    r.write32(descriptor + 4, buffer);
    r.free(r.hostCurrentDirectoryBuffer);
    r.hostCurrentDirectoryBuffer = buffer;
  }
  r.cwd = path ? path + '/' : '';
  return 0;
}
