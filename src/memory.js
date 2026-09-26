/** Bounds-checked access to the mapped PE and its guest stack/heap regions. */
export class GuestMemory {
  constructor(memory, regions, { onCodeWrite, readOnlyViews = [] } = {}) {
    this.memory = memory;
    this.regions = regions;
    this.view = new DataView(memory.buffer);
    this.data = new Uint8Array(memory.buffer);
    this.onCodeWrite = onCodeWrite;
    // Index-validated region cache for the locality fast path.
    this.cachedRegion = undefined;
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
      throw Error(
        `Guest ${write ? 'write' : 'read'} violation at 0x${address.toString(16)} (${size} bytes)`,
      );
    return address;
  }

  // Raw linear-buffer consumers must use this check, never accept an external
  // address and then silently index an unrelated/empty TypedArray slice.
  //
  // Guest access is locality-heavy, so the region that satisfied the previous
  // check is cached. The cache is validated by identity against the shared
  // regions array on every use, so a protection change, split, unmap or reload
  // (all of which replace or remove region objects) makes the entry stale and
  // the exact scan below runs instead. No invalidation hook is required.
  checkLinear(address, size, write = false) {
    address >>>= 0;
    const end = address + size;
    const regions = this.regions;
    const validSize = Number.isSafeInteger(size) && size >= 0;
    const cached = this.cachedRegion;
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
      if (write && cached.region.exec) this.onCodeWrite(address, size);
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
      throw Error(
        `Guest ${write ? 'write' : 'read'} violation at 0x${address.toString(16)} (${size} bytes)`,
      );
    }
    if (size > 0 && coverIndex >= 0)
      this.cachedRegion = { index: coverIndex, region: regions[coverIndex] };
    if (write && size && this.onCodeWrite && regions[coverIndex]?.exec)
      this.onCodeWrite(address, size);
    return address;
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
  write(address, value, width = 4) {
    this.check(address, width, true);
    if (width === 1) this.view.setUint8(address, value);
    else if (width === 2) this.view.setUint16(address, value, true);
    else if (width === 4) this.view.setUint32(address, value >>> 0, true);
    else throw Error('Unsupported guest write width');
  }
  read32(address) {
    address >>>= 0;
    if (address < this.data.length) return this.view.getUint32(this.checkLinear(address, 4), true);
    return this.read(address, 4);
  }

  write32(address, value) {
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
