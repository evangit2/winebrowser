// Bounded, single-process subset of the Windows virtual-address allocator.
const PAGE_SIZE = 0x1000;
const ALLOCATION_GRANULARITY = 0x10000;
const ARENA_START = 0x02000000;
const ARENA_END = 0x02e00000;

export const VirtualMemoryConstants = Object.freeze({
  pageSize: PAGE_SIZE,
  allocationGranularity: ALLOCATION_GRANULARITY,
  arenaStart: ARENA_START,
  arenaEnd: ARENA_END,
  MEM_COMMIT: 0x1000,
  MEM_RESERVE: 0x2000,
  MEM_DECOMMIT: 0x4000,
  MEM_RELEASE: 0x8000,
  PAGE_NOACCESS: 0x01,
  PAGE_READONLY: 0x02,
  PAGE_READWRITE: 0x04,
});

export const NTSTATUS = Object.freeze({
  SUCCESS: 0x00000000,
  INVALID_PARAMETER: 0xc000000d,
  NO_MEMORY: 0xc0000017,
  CONFLICTING_ADDRESSES: 0xc0000018,
  INVALID_PAGE_PROTECTION: 0xc0000045,
  MEMORY_NOT_ALLOCATED: 0xc00000a0,
});

const alignDown = (value, alignment) => Math.floor(value / alignment) * alignment;
const alignUp = (value, alignment) => Math.ceil(value / alignment) * alignment;
const ok = (base, size) => ({ status: NTSTATUS.SUCCESS, base, size });

/**
 * A page-granular allocator over [0x02000000, 0x02e00000). It exposes one
 * `kind: 'virtual'` region for each contiguous run of pages with equal access.
 * Reserve pages are represented as unreadable/unwritable. Executable
 * protections and shared-memory concurrency are intentionally unsupported.
 */
export class VirtualMemory {
  constructor(memory, regions) {
    if (!(memory instanceof WebAssembly.Memory))
      throw Error('VirtualMemory requires WebAssembly.Memory');
    if (!Array.isArray(regions)) throw Error('VirtualMemory requires a shared regions array');
    this.memory = memory;
    this.bytes = new Uint8Array(memory.buffer);
    this.regions = regions;
    this.reservations = new Map();
    this.managedRegions = new Set();
  }

  allocate(base, size, type, protect) {
    if (!this.validInput(base, size) || ![0x1000, 0x2000, 0x3000].includes(type))
      return { status: NTSTATUS.INVALID_PARAMETER, base, size };
    if (![1, 2, 4].includes(protect))
      return { status: NTSTATUS.INVALID_PAGE_PROTECTION, base, size };

    if (type & 0x2000 || base === 0) return this.reserve(base, size, type, protect);
    return this.commit(base, size, protect);
  }

  free(base, size, type) {
    if (!this.validInput(base, size) || ![0x4000, 0x8000].includes(type))
      return { status: NTSTATUS.INVALID_PARAMETER, base, size };

    if (type === 0x8000) {
      const reservation = this.reservations.get(base);
      if (!reservation || size !== 0) return { status: NTSTATUS.MEMORY_NOT_ALLOCATED, base, size };
      const releasedSize = reservation.end - reservation.base;
      this.reservations.delete(base);
      this.syncRegions();
      return ok(base, releasedSize);
    }

    let start, end;
    if (size === 0) {
      const reservation = this.reservations.get(base);
      if (!reservation) return { status: NTSTATUS.MEMORY_NOT_ALLOCATED, base, size };
      start = reservation.base;
      end = reservation.end;
    } else {
      const requestedEnd = base + size;
      if (requestedEnd > 0x100000000) return { status: NTSTATUS.INVALID_PARAMETER, base, size };
      start = alignDown(base, PAGE_SIZE);
      end = alignUp(requestedEnd, PAGE_SIZE);
    }

    const reservation = this.containingReservation(start, end);
    if (!reservation) return { status: NTSTATUS.MEMORY_NOT_ALLOCATED, base, size };
    for (let page = start; page < end; page += PAGE_SIZE) reservation.pages.set(page, null);
    this.syncRegions();
    return ok(start, end - start);
  }

  validInput(base, size) {
    return (
      Number.isSafeInteger(base) &&
      base >= 0 &&
      base <= 0xffffffff &&
      Number.isSafeInteger(size) &&
      size >= 0 &&
      size <= 0xffffffff
    );
  }

  reserve(base, size, type, protect) {
    if (size === 0 || base + size > 0x100000000)
      return { status: NTSTATUS.INVALID_PARAMETER, base, size };

    let start, end;
    if (base === 0) {
      start = this.findFreeReservation(size);
      if (start === null) return { status: NTSTATUS.NO_MEMORY, base, size };
      end = start + alignUp(size, PAGE_SIZE);
    } else {
      start = alignDown(base, ALLOCATION_GRANULARITY);
      end = alignUp(base + size, PAGE_SIZE);
    }
    if (start < ARENA_START || end > ARENA_END || end <= start)
      return { status: NTSTATUS.NO_MEMORY, base, size };
    if (!this.rangeIsFree(start, end))
      return { status: NTSTATUS.CONFLICTING_ADDRESSES, base, size };

    const reservation = { base: start, end, pages: new Map() };
    for (let page = start; page < end; page += PAGE_SIZE) {
      reservation.pages.set(page, null);
      if (type & 0x1000) {
        reservation.pages.set(page, protect);
        this.bytes.fill(0, page, page + PAGE_SIZE);
      }
    }
    this.reservations.set(start, reservation);
    this.syncRegions();
    return ok(start, end - start);
  }

  commit(base, size, protect) {
    if (base === 0 || size === 0 || base + size > 0x100000000)
      return { status: NTSTATUS.INVALID_PARAMETER, base, size };
    const start = alignDown(base, PAGE_SIZE);
    const end = alignUp(base + size, PAGE_SIZE);
    const reservation = this.containingReservation(start, end);
    if (!reservation) return { status: NTSTATUS.MEMORY_NOT_ALLOCATED, base, size };

    for (let page = start; page < end; page += PAGE_SIZE) {
      const previous = reservation.pages.get(page);
      if (previous === null) this.bytes.fill(0, page, page + PAGE_SIZE);
      reservation.pages.set(page, protect);
    }
    this.syncRegions();
    return ok(start, end - start);
  }

  findFreeReservation(size) {
    const roundedSize = alignUp(size, PAGE_SIZE);
    for (let base = ARENA_START; base + roundedSize <= ARENA_END; base += ALLOCATION_GRANULARITY) {
      const end = base + roundedSize;
      if (this.rangeIsFree(base, end)) return base;
    }
    return null;
  }

  rangeIsFree(start, end) {
    if (
      [...this.reservations.values()].some(
        (reservation) => start < reservation.end && end > reservation.base,
      )
    )
      return false;
    return !this.regions.some((region) => start < region.end && end > region.start);
  }

  containingReservation(start, end) {
    for (const reservation of this.reservations.values())
      if (start >= reservation.base && end <= reservation.end) return reservation;
    return null;
  }

  syncRegions() {
    const kept = this.regions.filter((region) => !this.managedRegions.has(region));
    this.managedRegions.clear();
    const pages = [];
    for (const reservation of this.reservations.values())
      for (let page = reservation.base; page < reservation.end; page += PAGE_SIZE) {
        const protect = reservation.pages.get(page);
        pages.push({
          start: page,
          end: page + PAGE_SIZE,
          read: protect === 2 || protect === 4,
          write: protect === 4,
          exec: false,
          kind: 'virtual',
        });
      }
    pages.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const page of pages) {
      const last = merged.at(-1);
      if (last && last.end === page.start && last.read === page.read && last.write === page.write) {
        last.end = page.end;
      } else merged.push(page);
    }
    for (const region of merged) this.managedRegions.add(region);
    this.regions.splice(0, this.regions.length, ...kept, ...merged);
  }
}
