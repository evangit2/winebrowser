import { resolveGuestPath } from './guest-paths.js';
import { fileMetadata } from './file-metadata.js';

// The guest content budget is shared by NT, Win32 and CRT writes. Imported
// packages may already exceed it; overwriting or shrinking them remains legal.
export const VOLUME_BYTES = 128 * 1024 * 1024;
export const MAX_GUEST_FILE_BYTES = 16 * 1024 * 1024;
export const SECTORS_PER_CLUSTER = 8;
export const BYTES_PER_SECTOR = 512;
export const CLUSTER_BYTES = SECTORS_PER_CLUSTER * BYTES_PER_SECTOR;

export function volumeUsage(r) {
  let used = 0;
  for (const bytes of r.files.values()) used += bytes.length;
  const totalUnits = VOLUME_BYTES / CLUSTER_BYTES;
  const availableUnits = Math.floor(Math.max(0, VOLUME_BYTES - used) / CLUSTER_BYTES);
  return {
    used,
    totalUnits,
    availableUnits,
    total: VOLUME_BYTES,
    free: availableUnits * CLUSTER_BYTES,
  };
}

export function canResizeGuestFile(r, path, length) {
  if (!Number.isSafeInteger(length) || length < 0) return false;
  const previous = r.files.get(path)?.length ?? 0;
  if (length <= previous) return true;
  return length <= MAX_GUEST_FILE_BYTES && volumeUsage(r).used + length - previous <= VOLUME_BYTES;
}

// C:\ is a volume metadata root, not an alias for the package directory.
export function isGuestVolumeRoot(input) {
  const path = input.replaceAll('\\', '/').replace(/^(?:\/\/\?\/|\/\?\?\/)/, '');
  return /^c:\/$/i.test(path);
}

export function volumePathError(r, input) {
  if (input === null || isGuestVolumeRoot(input)) return 0;
  try {
    const path = resolveGuestPath(input, r.cwd, { allowRoot: true });
    const info = fileMetadata(r, path);
    if (info.status) return info.status === 0xc0000034 ? 2 : 3;
    return info.directory ? 0 : 267; // ERROR_DIRECTORY
  } catch {
    return 3;
  }
}
