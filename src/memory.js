import { GuestFault, EXCEPTION_CODE } from './seh.js';

/** Bounds-checked access to the mapped PE and its guest stack/heap regions. */
export class GuestMemory {
  constructor(memory, regions, { onCodeWrite, readOnlyViews = [] } = {}) {
    this.memory = memory;
    this.regions = regions;
    this.view = new DataView(memory.buffer);
    this.data = new Uint8Array(memory.buffer);
    this.onCodeWrite = onCodeWrite;
    this.writeObservers = [];
    // Index-validated region cache for the locality fast path.
    this.cachedRegion = undefined;
    this.cachedRegions = new Array(64);
    this.readOnlyViews = readOnlyViews.map((mapping) => {
      const { start, bytes, ranges = [[0, bytes?.length]] } = mapping;
      if (
        !(bytes instanceof Uint8Array) ||
        !bytes.length ||
        !Number.isSafeInteger(start) ||
        start < this.data.length ||
        start + bytes.length > 0x100000000 ||
        ranges.some(
          ([a, b]) =>
            !Number.isSafeInteger(a) ||
            !Number.isSafeInteger(b) ||
            a < 0 ||
            a >= b ||
            b > bytes.length,
        )
      )
        throw Error('Invalid external read-only guest mapping');
      return {
        ...mapping,
        ranges,
        end: start + bytes.length,
        view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      };
    });
    for (const [index, mapping] of this.readOnlyViews.entries())
      if (
        this.readOnlyViews
          .slice(index + 1)
          .some((other) => mapping.start < other.end && other.start < mapping.end)
      )
        throw Error('Overlapping external guest mappings');
  }

  check(address, size, write = false) {
    address >>>= 0;
    if (address < this.data.length) return this.checkLinear(address, size, write);
    const mapping = this.readOnlyViews.find((m) => address >= m.start && address < m.end);
    if (!mapping) return this.checkLinear(address, size, write);
    const offset = address - mapping.start;
    if (
      write ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !mapping.ranges.some(([start, end]) => offset >= start && offset + size <= end)
    )
      throw new GuestFault(
        `Guest ${write ? 'write' : 'read'} violation at 0x${address.toString(16)} (${size} bytes)`,
        { code: EXCEPTION_CODE.ACCESS_VIOLATION, address, write, size },
      );
    return address;
  }

  // Raw linear-buffer consumers must use this check, never accept an external
  // address and then silently index an unrelated/empty TypedArray slice.
  //
  // Guest access is locality-heavy, so the region that satisfied the previous
  // check is cached, with a small page-indexed cache for alternating stack,
  // heap and image accesses. Each entry is validated by identity against the shared
  // regions array on every use, so a protection change, split, unmap or reload
  // (all of which replace or remove region objects) makes the entry stale and
  // the exact scan below runs instead. No invalidation hook is required.
  checkLinear(address, size, write = false) {
    address >>>= 0;
    const end = address + size;
    const regions = this.regions;
    const validSize = Number.isSafeInteger(size) && size >= 0;
    let cached = this.cachedRegion;
    if (
      cached === undefined ||
      regions[cached.index] !== cached.region ||
      address < cached.region.start ||
      end > cached.region.end
    )
      cached = this.cachedRegions[(address >>> 12) & 63];
    if (
      cached !== undefined &&
      regions[cached.index] === cached.region &&
      validSize &&
      size > 0 &&
      address >= cached.region.start &&
      address < cached.region.end &&
      end <= cached.region.end &&
      cached.region.read !== false &&
      (!write || (cached.region.write && (!cached.region.exec || this.onCodeWrite)))
    ) {
      this.cachedRegion = cached;
      if (write && cached.region.exec) this.onCodeWrite(address, size);
      if (write && this.writeObservers.length) this.noteDataWrite(address, size);
      return address;
    }
    let cursor = address;
    if (validSize && size > 0 && end <= this.data.length) {
      while (cursor < end) {
        let covered = cursor;
        for (let i = 0; i < regions.length; i++) {
          const region = regions[i];
          if (
            region.read !== false &&
            (!write || (region.write && (!region.exec || this.onCodeWrite))) &&
            cursor >= region.start &&
            cursor < region.end
          )
            covered = Math.max(covered, Math.min(end, region.end));
        }
        if (covered === cursor) break;
        cursor = covered;
      }
    }
    let coverIndex = -1;
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      if (region.read === false || (write && !(region.write && (!region.exec || this.onCodeWrite))))
        continue;
      if (
        (size > 0 && address >= region.start && address < region.end && end <= region.end) ||
        (size === 0 && address >= region.start && address <= region.end)
      ) {
        coverIndex = i;
        break;
      }
    }
    if (
      !validSize ||
      size < 0 ||
      end > this.data.length ||
      (size > 0 ? cursor !== end : coverIndex < 0)
    ) {
      throw new GuestFault(
        `Guest ${write ? 'write' : 'read'} violation at 0x${address.toString(16)} (${size} bytes)`,
        { code: EXCEPTION_CODE.ACCESS_VIOLATION, address, write, size },
      );
    }
    if (size > 0 && coverIndex >= 0) {
      this.cachedRegion = { index: coverIndex, region: regions[coverIndex] };
      this.cachedRegions[(address >>> 12) & 63] = this.cachedRegion;
    }
    if (write && size && this.onCodeWrite && regions[coverIndex]?.exec)
      this.onCodeWrite(address, size);
    if (write && this.writeObservers.length) this.noteDataWrite(address, size);
    return address;
  }
  // Notifications precede a validated write. Consumers defer reading its
  // bytes until the next API boundary, so both scalar stores and checked bulk
  // copies can cheaply invalidate derived data such as a shared DIB image.
  observeWrites(start, size, callback) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(size) ||
      start < 0 ||
      size <= 0 ||
      start + size > this.data.length ||
      typeof callback !== 'function'
    )
      throw Error('Invalid guest write observer');
    const observer = { start, end: start + size, callback };
    this.writeObservers.push(observer);
    this.writeObservers.sort((a, b) => a.start - b.start);
    this.updateObserverBounds();
    return () => {
      const index = this.writeObservers.indexOf(observer);
      if (index >= 0) this.writeObservers.splice(index, 1);
      this.updateObserverBounds();
    };
  }
  updateObserverBounds() {
    this.observerStart = this.writeObservers[0]?.start ?? Infinity;
    this.observerEnd = this.writeObservers.reduce(
      (end, observer) => Math.max(end, observer.end),
      0,
    );
  }
  noteDataWrite(address, size) {
    if (!size || address >= this.observerEnd || address + size <= this.observerStart) return;
    const end = address + size;
    for (const observer of this.writeObservers) {
      if (observer.start >= end) break;
      if (observer.end > address)
        observer.callback(Math.max(address, observer.start), Math.min(end, observer.end));
    }
  }
  read(address, width = 4) {
    address >>>= 0;
    if (![1, 2, 4].includes(width)) throw Error('Unsupported guest read width');
    this.check(address, width);
    const mapping =
      address < this.data.length
        ? null
        : this.readOnlyViews.find((m) => address >= m.start && address < m.end);
    const offset = mapping ? address - mapping.start : address;
    if (mapping) mapping.refresh?.(offset, width);
    const view = mapping?.view ?? this.view;
    if (width === 1) return view.getUint8(offset);
    if (width === 2) return view.getUint16(offset, true);
    if (width === 4) return view.getUint32(offset, true);
    throw Error('Unsupported guest read width');
  }
  readBytes(address, size) {
    address >>>= 0;
    this.check(address, size);
    const mapping =
      address < this.data.length
        ? null
        : this.readOnlyViews.find((m) => address >= m.start && address < m.end);
    if (!mapping) return this.data.slice(address, address + size);
    const offset = address - mapping.start;
    mapping.refresh?.(offset, size);
    return mapping.bytes.slice(offset, offset + size);
  }
  /**
   * Applies the runtime's code-write rule to a byte range a bulk operation is
   * about to overwrite in place.
   *
   * memcpy/memmove/memset, heap reallocation and page commits write through
   * `data` directly (that is what makes them fast), so they never pass through
   * checkLinear and would otherwise leave translated blocks for the old bytes
   * cached. A packed or self-decrypting image rewrites its own code exactly
   * this way, so the omission is observable as execution of stale translation.
   */
  noteCodeWrite(address, size) {
    address >>>= 0;
    size >>>= 0;
    if (this.writeObservers.length) this.noteDataWrite(address, size);
    if (!size || !this.onCodeWrite) return;
    const end = address + size;
    for (const region of this.regions) {
      if (!region.exec || !region.write) continue;
      if (region.start < end && region.end > address)
        this.onCodeWrite(
          Math.max(address, region.start),
          Math.min(end, region.end) - Math.max(address, region.start),
        );
    }
  }

  write(address, value, width = 4) {
    // A watch records the writer before the access is validated, so a write the
    // memory model rejects is still attributed to the instruction that made it
    // rather than failing with no evidence of who reached the address.
    if (this.watchAnyRange || this.watchValue !== undefined) this.#noteWrite(address, value, width);
    this.check(address, width, true);
    if (width === 1) this.view.setUint8(address, value);
    else if (width === 2) this.view.setUint16(address, value, true);
    else if (width === 4) this.view.setUint32(address, value >>> 0, true);
    else throw Error('Unsupported guest write width');
  }
  // A watch range with no value records every writer into that window, which
  // identifies who fills a structure rather than who writes one value.
  #noteWrite(address, value, width) {
    if (this.watchAnyRange && address >= this.watchAnyRange[0] && address < this.watchAnyRange[1])
      this.watchAny(() => ({ address: address >>> 0, width, value: value >>> 0 }));
    else if (this.watchValue !== undefined && value >>> 0 === this.watchValue)
      this.#noteWatch(address, width);
  }
  watchAny(entry) {
    this.watchEntries ??= [];
    const instructions = this.watchInstructions?.() ?? null;
    if (instructions < (this.watchAfterInstructions ?? 0)) return;
    if (this.watchEntries.length >= 128) this.watchEntries.shift();
    const ip = this.watchIp?.() ?? null;
    const value = entry();
    this.watchEntries.push({
      ...value,
      ip,
      instructions,
      registers: this.watchRegisters?.() ?? null,
      context: this.watchCallStack?.(value.address),
    });
  }
  #noteWatch(address, width) {
    if (this.watchRange && (address < this.watchRange[0] || address >= this.watchRange[1])) return;
    this.watchHits ??= [];
    if (this.watchHits.length >= 64) return;
    // Capture the first write per instruction address to keep the log compact
    // and point at the highest-level producer.
    const ip = this.watchIp?.() ?? null;
    if (this.watchHits.some((hit) => hit.ip === ip)) return;
    this.watchHits.push({
      address: address >>> 0,
      width,
      ip,
      instructions: this.watchInstructions?.() ?? null,
      registers: this.watchRegisters?.() ?? null,
      callStack: this.watchCallStack?.(address) ?? null,
    });
  }
  read32(address) {
    address >>>= 0;
    if (address < this.data.length) return this.view.getUint32(this.checkLinear(address, 4), true);
    return this.read(address, 4);
  }

  write32(address, value) {
    if (this.watchAnyRange || this.watchValue !== undefined) this.#noteWrite(address, value, 4);
    this.view.setUint32(this.check(address, 4, true), value >>> 0, true);
  }

  string(address) {
    if (!address) return '';
    const bytes = [];
    for (let offset = 0; offset < 32768; offset++) {
      const byte = this.read(address + offset, 1);
      if (!byte) return new TextDecoder('windows-1252').decode(new Uint8Array(bytes));
      bytes.push(byte);
    }
    throw Error('Unterminated guest string');
  }
}
