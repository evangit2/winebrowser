import { systemFileTime } from './shared-user-data.js';

export const FILE_NAME_NOT_FOUND = 0xc0000034;
export const FILE_PATH_NOT_FOUND = 0xc000003a;
const initialTimes = (r) => {
  const time = r.packageFileTime;
  return { creation: time, access: time, write: time, change: time };
};
function times(r, path) {
  return r.fileTimes?.get(path) ?? initialTimes(r);
}
function directory(r, path) {
  if (!path) return true;
  if (r.virtualDirectories?.has(path + '/')) return true;
  if (r.files.has(path)) return false;
  for (const file of r.files.keys()) if (file.startsWith(path + '/')) return true;
  return false;
}

export function fileIdentity(r, path) {
  const ids = (r.fileIds ??= new Map());
  if (!ids.has(path)) ids.set(path, ids.size + 1);
  return ids.get(path);
}

// Directories are the actual parents of packaged/generated files. Queries do
// not create entries, and failed intermediate components differ from a missing
// leaf. The isolated package volume has no devices, links or host paths.
export function fileMetadata(r, path) {
  const bytes = r.files.get(path),
    isDirectory = bytes === undefined && directory(r, path);
  if (!bytes && !isDirectory) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return { status: directory(r, parent) ? FILE_NAME_NOT_FOUND : FILE_PATH_NOT_FOUND };
  }
  return {
    status: 0,
    directory: isDirectory,
    attributes: isDirectory ? 0x10 : 0x20,
    size: bytes?.length ?? 0,
    allocation: bytes ? Math.ceil(bytes.length / 4096) * 4096 : 0,
    ...times(r, path),
  };
}

export function touchFile(r, path, { created = false, write = false, read = false } = {}) {
  r.fileTimes ??= new Map();
  const now = systemFileTime(r.systemNow()),
    previous = created ? { creation: now, access: now, write: now, change: now } : times(r, path);
  r.fileTimes.set(path, {
    ...previous,
    access: read || write ? now : previous.access,
    write: write ? now : previous.write,
    change: write ? now : previous.change,
  });
  if (created) {
    let parent = path;
    do {
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
      r.fileTimes.set(parent, { ...times(r, parent), write: now, change: now });
    } while (parent);
  }
}

export function writeFileMetadata(r, pointer, info, full = false) {
  const size = full ? 56 : 40;
  r.check(pointer, size, true);
  r.data.fill(0, pointer, pointer + size);
  for (const [i, key] of ['creation', 'access', 'write', 'change'].entries())
    r.view.setBigInt64(pointer + i * 8, info[key], true);
  if (full) {
    r.view.setBigInt64(pointer + 32, BigInt(info.allocation), true);
    r.view.setBigInt64(pointer + 40, BigInt(info.size), true);
  }
  r.write32(pointer + (full ? 48 : 32), info.attributes);
}
