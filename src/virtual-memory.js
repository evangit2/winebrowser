// Bounded, single-process subset of the Windows virtual-address allocator.
const PAGE_SIZE = 0x1000;
const ALLOCATION_GRANULARITY = 0x10000;
const ARENA_START = 0x02000000;
// The allocator scans from ARENA_START and skips anything already described by
// a region (mapped images, the TEB/heap/stack block), so the arena may extend
// well past those fixed addresses into the rest of the 256 MiB address space.
const ARENA_END = 0x0f000000;

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
  NOT_COMMITTED: 0xc000002d,
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
      return this.#logged('allocate', base, size, `type=${type}`, {
        status: NTSTATUS.INVALID_PARAMETER,
        base,
        size,
      });
    if (![1, 2, 4].includes(protect))
      return this.#logged('allocate', base, size, `type=${type}`, {
        status: NTSTATUS.INVALID_PAGE_PROTECTION,
        base,
        size,
      });

    return this.#logged(
      'allocate',
      base,
      size,
      `type=${type} protect=${protect}`,
      type & 0x2000 || base === 0
        ? this.reserve(base, size, type, protect)
        : this.commit(base, size, protect),
    );
  }

  // Bounded log of every allocator operation with its result, so an unexpected
  // reserved-but-uncommitted access can be matched to the exact call sequence.
  #logged(operation, base, size, detail, result) {
    this.ops ??= [];
    if (this.ops.length >= 2048) this.ops.shift();
    this.ops.push({
      n: (this.opCount = (this.opCount ?? 0) + 1),
      operation,
      base: (base >>> 0).toString(16),
      size: (size >>> 0).toString(16),
      detail,
      status: `0x${(result.status >>> 0).toString(16)}`,
      resultBase: (result.base >>> 0).toString(16),
      resultSize: (result.size >>> 0).toString(16),
    });
    return result;
  }

  free(base, size, type) {
    if (!this.validInput(base, size) || ![0x4000, 0x8000].includes(type))
      return { status: NTSTATUS.INVALID_PARAMETER, base, size };

    if (type === 0x8000) {
      const reservation = this.reservations.get(base);
      if (!reservation || size !== 0)
        return this.#logged('free', base, size, 'type=0x8000', {
          status: NTSTATUS.MEMORY_NOT_ALLOCATED,
          base,
          size,
        });
      const releasedSize = reservation.end - reservation.base;
      this.reservations.delete(base);
      this.syncRegions();
      return this.#logged('free', base, releasedSize, 'type=0x8000', ok(base, releasedSize));
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
    if (!reservation)
      return this.#logged('decommit', base, size, 'type=0x4000', {
        status: NTSTATUS.MEMORY_NOT_ALLOCATED,
        base,
        size,
      });
    for (let page = start; page < end; page += PAGE_SIZE) reservation.pages.set(page, null);
    this.syncRegions();
    return this.#logged('decommit', start, end - start, 'type=0x4000', ok(start, end - start));
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
      if (start === null) {
        this.lastFailure = { reason: 'arena-full', base, size };
        return { status: NTSTATUS.NO_MEMORY, base, size };
      }
      end = start + alignUp(size, PAGE_SIZE);
    } else {
      start = alignDown(base, ALLOCATION_GRANULARITY);
      end = alignUp(base + size, PAGE_SIZE);
    }
    if (start < ARENA_START || end > ARENA_END || end <= start) {
      this.lastFailure = {
        reason: 'outside-arena',
        base,
        size,
        start,
        end,
        arenaStart: ARENA_START,
        arenaEnd: ARENA_END,
      };
      return { status: NTSTATUS.NO_MEMORY, base, size };
    }
    if (!this.rangeIsFree(start, end)) {
      this.lastFailure = { reason: 'conflict', base, size, start, end };
      return { status: NTSTATUS.CONFLICTING_ADDRESSES, base, size };
    }

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
      return this.#logged('commit', base, size, `protect=${protect}`, {
        status: NTSTATUS.INVALID_PARAMETER,
        base,
        size,
      });
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
    return this.#logged('commit', start, end - start, `protect=${protect}`, ok(start, end - start));
  }

  protect(base, size, protection) {
    if (!this.validInput(base, size) || base === 0 || size === 0 || base + size > 0x100000000)
      return { status: NTSTATUS.INVALID_PARAMETER, base, size };
    if (![1, 2, 4].includes(protection))
      return { status: NTSTATUS.INVALID_PAGE_PROTECTION, base, size };
    const start = alignDown(base, PAGE_SIZE);
    const end = alignUp(base + size, PAGE_SIZE);
    const reservation = this.containingReservation(start, end);
    if (!reservation) return { status: NTSTATUS.MEMORY_NOT_ALLOCATED, base, size };
    for (let page = start; page < end; page += PAGE_SIZE)
      if (reservation.pages.get(page) == null)
        return { status: NTSTATUS.NOT_COMMITTED, base, size };

    const oldProtect = reservation.pages.get(start);
    for (let page = start; page < end; page += PAGE_SIZE) reservation.pages.set(page, protection);
    this.syncRegions();
    return { ...ok(start, end - start), oldProtect };
  }

  // Bounded diagnostic summary of the allocator's live extent.
  stats() {
    let reserved = 0,
      committed = 0;
    for (const reservation of this.reservations.values()) {
      reserved += reservation.end - reservation.base;
      for (const page of reservation.pages.values()) if (page !== null) committed += PAGE_SIZE;
    }
    const ranges = [...this.reservations.values()]
      .map((reservation) => ({
        base: reservation.base,
        end: reservation.end,
        committed:
          [...reservation.pages.values()].filter((page) => page !== null).length * PAGE_SIZE,
      }))
      .sort((a, b) => a.base - b.base);
    return {
      arenaStart: ARENA_START,
      arenaEnd: ARENA_END,
      arenaBytes: ARENA_END - ARENA_START,
      reservations: this.reservations.size,
      reservedBytes: reserved,
      committedBytes: committed,
      ranges,
      lastFailure: this.lastFailure ?? null,
    };
  }
  // Which reservation contains an address, and the committed extent around it.
  rangeFor(address) {
    for (const reservation of this.reservations.values())
      if (address >= reservation.base && address < reservation.end) {
        const committed = [];
        let run = null;
        for (let page = reservation.base; page < reservation.end; page += PAGE_SIZE) {
          if (reservation.pages.get(page) !== null) {
            if (!run) run = { base: page, end: page + PAGE_SIZE };
            else run.end = page + PAGE_SIZE;
          } else if (run) {
            committed.push(run);
            run = null;
          }
        }
        if (run) committed.push(run);
        return { base: reservation.base, end: reservation.end, committed };
      }
    return null;
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
