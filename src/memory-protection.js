import { NTSTATUS, VirtualMemoryConstants as VM } from './virtual-memory.js';

const NOT_SUPPORTED = 0xc00000bb;
const protection = (region) => (region.read === false ? 1 : region.write ? 4 : 2);

/** Change only committed private VM or fully mapped, non-executable PE pages.
 * Immutable section snapshots, code, process layout and image gaps retain their
 * existing access. Supporting writable code requires cache invalidation and a
 * separate executable-memory lifecycle, not just toggling region flags.
 */
export function protectMemory(runtime, base, size, newProtect) {
  const fail = (status) => ({ status, base, size });
  if (!runtime.virtualMemory.validInput(base, size) || !size || base + size > 0x100000000)
    return fail(NTSTATUS.INVALID_PARAMETER);
  if (![1, 2, 4].includes(newProtect)) return fail(NTSTATUS.INVALID_PAGE_PROTECTION);
  const start = Math.floor(base / VM.pageSize) * VM.pageSize;
  const end = Math.ceil((base + size) / VM.pageSize) * VM.pageSize;
  if (runtime.virtualMemory.containingReservation(start, end))
    return runtime.virtualMemory.protect(base, size, newProtect);
  const reservation = runtime.regions.find(
    (region) => region.kind === 'image-reservation' && start >= region.start && end <= region.end,
  );
  if (!reservation) return fail(NOT_SUPPORTED);
  const imageRegions = runtime.regions.filter(
    (region) =>
      region.module === reservation.module &&
      region.kind !== 'image-reservation' &&
      region.start < end &&
      region.end > start,
  );
  if (imageRegions.some((region) => region.exec)) return fail(NOT_SUPPORTED);
  const ordered = [...imageRegions].sort((a, b) => a.start - b.start);
  let cursor = start;
  for (const region of ordered) {
    if (region.start > cursor) break;
    cursor = Math.max(cursor, Math.min(end, region.end));
  }
  if (cursor !== end) return fail(NTSTATUS.NOT_COMMITTED);
  const oldProtect = protection(
    ordered.find((region) => region.start <= start && region.end > start),
  );
  const changed = new Set(imageRegions);
  const replacement = [];
  for (const region of runtime.regions) {
    if (!changed.has(region)) {
      replacement.push(region);
      continue;
    }
    if (region.start < start) replacement.push({ ...region, end: start });
    replacement.push({
      ...region,
      start: Math.max(start, region.start),
      end: Math.min(end, region.end),
      read: newProtect !== 1,
      write: newProtect === 4,
    });
    if (region.end > end) replacement.push({ ...region, start: end });
  }
  runtime.regions.splice(0, runtime.regions.length, ...replacement);
  return { status: NTSTATUS.SUCCESS, base: start, size: end - start, oldProtect };
}

export const memoryNtServices = {
  NtProtectVirtualMemory: {
    argc: 5,
    call(runtime, argument) {
      if (argument(0) >>> 0 !== 0xffffffff) return 0xc0000008;
      const basePointer = argument(1) >>> 0;
      const sizePointer = argument(2) >>> 0;
      const oldPointer = argument(4) >>> 0;
      try {
        runtime.check(basePointer, 4, true);
        runtime.check(sizePointer, 4, true);
        runtime.check(oldPointer, 4, true);
      } catch {
        return 0xc0000005;
      }
      const base = runtime.read32(basePointer),
        size = runtime.read32(sizePointer);
      const newProtect = argument(3) >>> 0;
      const start = Math.floor(base / VM.pageSize) * VM.pageSize;
      const end = Math.ceil((base + size) / VM.pageSize) * VM.pageSize;
      if (
        newProtect !== VM.PAGE_READWRITE &&
        [basePointer, sizePointer, oldPointer].some(
          (pointer) => pointer < end && pointer + 4 > start,
        )
      )
        return NOT_SUPPORTED; // Output writes into newly protected pages need separate semantics.
      const result = protectMemory(runtime, base, size, newProtect);
      if (!result.status) {
        runtime.write32(basePointer, result.base);
        runtime.write32(sizePointer, result.size);
        runtime.write32(oldPointer, result.oldProtect);
      } else runtime.write32(oldPointer, VM.PAGE_NOACCESS);
      return result.status;
    },
  },
};
