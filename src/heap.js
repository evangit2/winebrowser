/** Bounded guest heap. Windows pointers are offsets; host objects never enter guest memory. */
export class GuestHeap {
  constructor(memory, start = 0x3000000, end = 0x3c00000) {
    this.bytes = new Uint8Array(memory.buffer);
    this.freeRanges = [[start, end]];
    this.allocations = new Map();
  }
  allocate(size, zero = false) {
    if (!Number.isInteger(size) || size < 0 || size > 16 * 1024 * 1024)
      throw Error('Invalid heap allocation size');
    const count = Math.max(16, Math.ceil(size / 16) * 16),
      index = this.freeRanges.findIndex(([a, b]) => b - a >= count);
    if (index < 0) throw Error('Guest heap exhausted');
    const [address, end] = this.freeRanges[index];
    if (address + count === end) this.freeRanges.splice(index, 1);
    else this.freeRanges[index][0] += count;
    this.allocations.set(address, count);
    if (zero) this.bytes.fill(0, address, address + count);
    return address;
  }
  // Current usable size of an allocation (the rounded block, as HeapSize
  // reports). Null when the pointer is not a live allocation.
  allocationSize(address) {
    return this.allocations.get(address) ?? null;
  }
  // Grow or shrink an allocation in place when the following range is free;
  // otherwise allocate a new block, copy the live bytes and free the old one.
  reallocate(address, size, zero = false) {
    const current = this.allocations.get(address);
    if (current === undefined) return null;
    const count = Math.max(16, Math.ceil(size / 16) * 16);
    if (count === current) return address;
    if (count < current) {
      const tail = address + count;
      this.allocations.set(address, count);
      this.bytes.fill(0, tail, address + current);
      this.freeRanges.push([tail, address + current]);
      this.freeRanges.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < this.freeRanges.length;) {
        const prev = this.freeRanges[i - 1],
          next = this.freeRanges[i];
        if (prev[1] === next[0]) {
          prev[1] = next[1];
          this.freeRanges.splice(i, 1);
        } else i++;
      }
      return address;
    }
    let replacement = null;
    try {
      replacement = this.allocate(count, false);
    } catch {
      return null;
    }
    this.bytes.copyWithin(replacement, address, address + current);
    this.bytes.fill(0, replacement + current, replacement + count);
    if (zero) this.bytes.fill(0, address, address + current);
    this.free(address);
    return replacement;
  }
  free(address) {
    const count = this.allocations.get(address);
    if (count === undefined) return false;
    this.allocations.delete(address);
    this.freeRanges.push([address, address + count]);
    this.freeRanges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < this.freeRanges.length;) {
      const prev = this.freeRanges[i - 1],
        next = this.freeRanges[i];
      if (prev[1] === next[0]) {
        prev[1] = next[1];
        this.freeRanges.splice(i, 1);
      } else i++;
    }
    return true;
  }
}
