import { NTSTATUS, VirtualMemoryConstants as VM } from './virtual-memory.js';

const MAX_SECTION_VIEWS = 256;
const MAX_MAPPED_BYTES = VM.arenaEnd - VM.arenaStart;

export const SectionViewStatus = Object.freeze({
  SUCCESS: NTSTATUS.SUCCESS,
  INVALID_PARAMETER: NTSTATUS.INVALID_PARAMETER,
  NO_MEMORY: NTSTATUS.NO_MEMORY,
  CONFLICTING_ADDRESSES: NTSTATUS.CONFLICTING_ADDRESSES,
  NOT_MAPPED_VIEW: 0xc0000019,
});

const alignUp = (value, alignment) => Math.ceil(value / alignment) * alignment;

function asBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input))
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/**
 * Maps byte snapshots as read-only, non-executable page regions in
 * the VM arena. These views are intentionally separate from MEM_RESERVE
 * reservations and therefore have their own unmap lifetime.
 * NLS snapshots remain immutable; FileSections refreshes its own file-backed
 * aliases when an ordinary file write changes their backing data.
 */
export class SectionViews {
  constructor(memory, regions, virtualMemory) {
    if (!(memory instanceof WebAssembly.Memory))
      throw Error('SectionViews requires WebAssembly.Memory');
    if (!Array.isArray(regions)) throw Error('SectionViews requires a shared regions array');
    if (
      !virtualMemory ||
      virtualMemory.memory !== memory ||
      typeof virtualMemory.findFreeReservation !== 'function' ||
      typeof virtualMemory.rangeIsFree !== 'function'
    )
      throw Error('SectionViews requires its process VirtualMemory allocator');
    this.memory = memory;
    this.regions = regions;
    this.virtualMemory = virtualMemory;
    this.views = new Map();
    this.mappedBytes = 0;
  }

  map(input, { name, base: requestedBase = 0, onUnmap } = {}) {
    const source = asBytes(input);
    if (
      !source ||
      source.byteLength === 0 ||
      (name !== undefined && typeof name !== 'string') ||
      !Number.isSafeInteger(requestedBase) ||
      requestedBase < 0 ||
      requestedBase > 0xffffffff ||
      requestedBase % VM.allocationGranularity ||
      (onUnmap !== undefined && typeof onUnmap !== 'function')
    )
      return { status: SectionViewStatus.INVALID_PARAMETER, base: 0, size: 0 };
    if (this.views.size >= MAX_SECTION_VIEWS)
      return { status: SectionViewStatus.NO_MEMORY, base: 0, size: 0 };

    const size = source.byteLength;
    const viewSize = alignUp(size, VM.pageSize);
    if (
      !Number.isSafeInteger(size) ||
      viewSize < size ||
      viewSize > MAX_MAPPED_BYTES ||
      this.mappedBytes + viewSize > MAX_MAPPED_BYTES ||
      viewSize > new Uint8Array(this.memory.buffer).byteLength
    )
      return { status: SectionViewStatus.NO_MEMORY, base: 0, size: 0 };

    if (
      requestedBase &&
      (requestedBase < VM.arenaStart ||
        requestedBase + viewSize > VM.arenaEnd ||
        !this.virtualMemory.rangeIsFree(requestedBase, requestedBase + viewSize))
    )
      return { status: SectionViewStatus.CONFLICTING_ADDRESSES, base: 0, size: 0 };
    const base = requestedBase || this.virtualMemory.findFreeReservation(viewSize);
    if (base === null || !this.virtualMemory.rangeIsFree(base, base + viewSize))
      return { status: SectionViewStatus.NO_MEMORY, base: 0, size: 0 };

    // Snapshot before mapping, and clear the full final page so section tail
    // bytes are deterministic zero-fill rather than old arena contents.
    const snapshot = source.slice();
    const memoryBytes = new Uint8Array(this.memory.buffer);
    if (base + viewSize > memoryBytes.byteLength)
      return { status: SectionViewStatus.NO_MEMORY, base: 0, size: 0 };
    memoryBytes.fill(0, base, base + viewSize);
    memoryBytes.set(snapshot, base);

    const region = {
      start: base,
      end: base + viewSize,
      read: true,
      write: false,
      exec: false,
      kind: 'section-view',
    };
    this.regions.push(region);
    this.views.set(base, { base, end: base + viewSize, size, viewSize, name, region, onUnmap });
    this.mappedBytes += viewSize;
    return { status: SectionViewStatus.SUCCESS, base, size, mappedSize: viewSize };
  }

  /** Unmap the complete section view containing any supplied interior address. */
  unmap(address) {
    if (!Number.isSafeInteger(address) || address < 0 || address > 0xffffffff)
      return SectionViewStatus.NOT_MAPPED_VIEW;
    const view = [...this.views.values()].find(
      (candidate) => address >= candidate.base && address < candidate.end,
    );
    if (!view) return SectionViewStatus.NOT_MAPPED_VIEW;

    new Uint8Array(this.memory.buffer).fill(0, view.base, view.end);
    const regionIndex = this.regions.indexOf(view.region);
    if (regionIndex !== -1) this.regions.splice(regionIndex, 1);
    this.views.delete(view.base);
    this.mappedBytes -= view.viewSize;
    view.onUnmap?.();
    return SectionViewStatus.SUCCESS;
  }
}
