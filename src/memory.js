/** Bounds-checked access to the mapped PE and its guest stack/heap regions. */
export class GuestMemory {
  constructor(memory, regions) {
    this.memory = memory;
    this.regions = regions;
    this.view = new DataView(memory.buffer);
    this.data = new Uint8Array(memory.buffer);
  }

  check(address, size, write = false) {
    address >>>= 0;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      address + size > this.data.length ||
      !this.regions.some(
        (region) =>
          address >= region.start &&
          address + size <= region.end &&
          (!write || (region.write && !region.exec)),
      )
    ) {
      throw Error(
        `Guest ${write ? 'write' : 'read'} violation at 0x${address.toString(16)} (${size} bytes)`,
      );
    }
    return address;
  }

  read(address, width = 4) {
    this.check(address, width);
    if (width === 1) return this.view.getUint8(address);
    if (width === 2) return this.view.getUint16(address, true);
    if (width === 4) return this.view.getUint32(address, true);
    throw Error('Unsupported guest read width');
  }
  write(address, value, width = 4) {
    this.check(address, width, true);
    if (width === 1) this.view.setUint8(address, value);
    else if (width === 2) this.view.setUint16(address, value, true);
    else if (width === 4) this.view.setUint32(address, value >>> 0, true);
    else throw Error('Unsupported guest write width');
  }
  read32(address) {
    return this.view.getUint32(this.check(address, 4), true);
  }

  write32(address, value) {
    this.view.setUint32(this.check(address, 4, true), value >>> 0, true);
  }

  string(address) {
    if (!address) return '';
    const bytes = [];
    for (let offset = 0; offset < 32768; offset++) {
      const byte = this.data[this.check(address + offset, 1)];
      if (!byte) return new TextDecoder('windows-1252').decode(new Uint8Array(bytes));
      bytes.push(byte);
    }
    throw Error('Unterminated guest string');
  }
}
