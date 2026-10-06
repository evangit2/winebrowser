const ACCESS_VIOLATION = 0xc0000005;

// MEMORY_BASIC_INFORMATION on i386: BaseAddress 0, AllocationBase 4,
// AllocationProtect 8, RegionSize 12, State 16, Protect 20, Type 24 — 28 bytes.
const MEMORY_BASIC_INFORMATION_BYTES = 28;
const MEMORY_INFORMATION_CLASS_BASIC = 0;
const PAGE_NOACCESS = 1;
const MEM_MEMBER = {
  commit: 0x1000,
  reserve: 0x2000,
  free: 0x10000,
  private: 0x20000,
  mapped: 0x40000,
  image: 0x1000000,
};
const PAGE_EXECUTE_READ = 0x20;
const PAGE_EXECUTE_READWRITE = 0x40;

/**
 * Answers MemoryBasicInformation from the runtime's own region and reservation
 * models. Wine fills the same fields from its view tree; here the page
 * protections the allocator records are the source, so a reserved-but-
 * uncommitted page reports MEM_RESERVE and a committed one reports MEM_COMMIT
 * with the protection the application asked for.
 */
export function queryVirtualMemory(runtime, argument) {
  const process = argument(0) >>> 0;
  const address = argument(1) >>> 0;
  const infoClass = argument(2) >>> 0;
  const buffer = argument(3) >>> 0;
  const length = argument(4) >>> 0;
  const returnLength = argument(5) >>> 0;
  // Only the current-process pseudo-handle is meaningful here; a real handle
  // would name a different address space the runtime does not model.
  if (process !== 0xffffffff) return 0xc0000008; // STATUS_INVALID_HANDLE.
  if (infoClass !== MEMORY_INFORMATION_CLASS_BASIC) return 0xc0000003; // STATUS_INVALID_INFO_CLASS.
  if (!buffer) return ACCESS_VIOLATION;
  if (length < MEMORY_BASIC_INFORMATION_BYTES) return 0xc0000004; // STATUS_INFO_LENGTH_MISMATCH.
  if (returnLength) {
    try {
      runtime.check(returnLength, 4, true);
    } catch {
      return ACCESS_VIOLATION;
    }
  }

  const PAGE = 0x1000;
  const base = Math.floor(address / PAGE) * PAGE;
  const reservation = [...runtime.virtualMemory.reservations.values()].find(
    (entry) => base >= entry.base && base < entry.end,
  );
  const region =
    runtime.regions.find(
      (entry) => entry.read !== false && base >= entry.start && base < entry.end,
    ) ?? runtime.regions.find((entry) => base >= entry.start && base < entry.end);

  let regionSize, state, protect, type, allocationBase, allocationProtect;
  if (reservation) {
    // The contiguous run of pages in this reservation that share a protection.
    const pages = [...reservation.pages.entries()].sort((a, b) => a[0] - b[0]);
    const current = reservation.pages.get(base);
    let end = base + PAGE;
    for (const [page, value] of pages) {
      if (page < base) continue;
      if (value !== current) break;
      end = page + PAGE;
    }
    regionSize = end - base;
    allocationBase = reservation.base;
    if (current === null) {
      state = MEM_MEMBER.reserve;
      protect = PAGE_NOACCESS;
    } else {
      state = MEM_MEMBER.commit;
      protect = current;
    }
    const committed = pages.find(([, value]) => value !== null)?.[1];
    allocationProtect = committed ?? PAGE_NOACCESS;
    type = MEM_MEMBER.private;
  } else if (region) {
    const image = runtime.regions.find(
      (entry) =>
        entry.kind === 'image-reservation' &&
        entry.module === region.module &&
        base >= entry.start &&
        base < entry.end,
    );
    regionSize = region.end - base;
    state = MEM_MEMBER.commit;
    allocationBase = image?.start ?? region.imageBase ?? region.start;
    if (image || region.kind === 'image') {
      type = MEM_MEMBER.image;
      allocationProtect = PAGE_EXECUTE_READ;
      protect = region.exec
        ? region.write
          ? PAGE_EXECUTE_READWRITE
          : PAGE_EXECUTE_READ
        : region.write
          ? 4
          : region.read !== false
            ? 2
            : PAGE_NOACCESS;
    } else if (region.kind === 'readonly' || region.kind === 'external') {
      type = MEM_MEMBER.mapped;
      allocationProtect = 2;
      protect = 2;
    } else {
      type = MEM_MEMBER.private;
      allocationProtect = region.exec
        ? PAGE_EXECUTE_READWRITE
        : region.write
          ? 4
          : region.read
            ? 2
            : PAGE_NOACCESS;
      protect = allocationProtect;
    }
  } else {
    // Nothing describes the page, so it is free.
    regionSize = PAGE;
    state = MEM_MEMBER.free;
    protect = PAGE_NOACCESS;
    allocationProtect = 0;
    allocationBase = 0;
    type = 0;
  }

  try {
    runtime.check(buffer, MEMORY_BASIC_INFORMATION_BYTES, true);
  } catch {
    return ACCESS_VIOLATION;
  }
  runtime.data.fill(0, buffer, buffer + MEMORY_BASIC_INFORMATION_BYTES);
  runtime.write32(buffer, base);
  runtime.write32(buffer + 4, allocationBase >>> 0);
  runtime.write32(buffer + 8, allocationProtect);
  runtime.write32(buffer + 12, regionSize >>> 0);
  runtime.write32(buffer + 16, state);
  runtime.write32(buffer + 20, protect);
  runtime.write32(buffer + 24, type);
  if (returnLength) runtime.write32(returnLength, MEMORY_BASIC_INFORMATION_BYTES);
  return 0;
}
