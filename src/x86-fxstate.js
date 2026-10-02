// Legacy i386 FXSAVE/FXRSTOR layout. The eight saved x87 values use logical
// ST order; the abridged tag bits describe physical registers.
export function transferFxState(cpu, address, restore) {
  if (address & 15) throw Error('FXSAVE/FXRSTOR requires 16-byte alignment');
  cpu.checkMemory(address, 512, !restore);
  const memory = new Uint8Array(cpu.memory.buffer);
  if (!restore) {
    const bytes = new Uint8Array(512),
      view = new DataView(bytes.buffer);
    const x87 = cpu.x87.snapshot(),
      simd = cpu.simd.snapshot();
    view.setUint16(0, x87.control, true);
    view.setUint16(2, (x87.status & ~(7 << 11)) | (x87.top << 11), true);
    for (let i = 0; i < 8; i++) {
      if (x87.tags[i] !== 3) bytes[4] |= 1 << i;
      bytes.set(x87.values[(x87.top + i) & 7], 32 + i * 16);
      for (let lane = 0; lane < 4; lane++)
        view.setUint32(160 + i * 16 + lane * 4, simd.registers[i][lane], true);
    }
    view.setUint32(24, simd.mxcsr, true);
    view.setUint32(28, 0xffff, true);
    memory.set(bytes, address);
    return;
  }
  restoreFxImage(cpu, memory.slice(address, address + 512));
}

export function restoreFxImage(cpu, bytes) {
  if (bytes.length !== 512) throw Error('Invalid FXRSTOR image size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mxcsr = view.getUint32(24, true),
    control = view.getUint16(0, true);
  if (mxcsr & ~0xffff || ((control >>> 8) & 3) === 1)
    throw Error('Unsupported FXRSTOR control state');
  const status = view.getUint16(2, true),
    top = (status >>> 11) & 7;
  const values = Array.from({ length: 8 }, () => new Uint8Array(10)),
    tags = new Uint8Array(8);
  const registers = [];
  for (let i = 0; i < 8; i++) {
    const physical = (top + i) & 7,
      raw = bytes.slice(32 + i * 16, 42 + i * 16);
    values[physical] = raw;
    const exponent = (raw[8] | (raw[9] << 8)) & 0x7fff;
    tags[physical] = !(bytes[4] & (1 << physical))
      ? 3
      : exponent === 0 && raw.slice(0, 8).every((n) => n === 0)
        ? 1
        : exponent === 0 || exponent === 0x7fff || !(raw[7] & 0x80)
          ? 2
          : 0;
    registers.push(
      Uint32Array.from({ length: 4 }, (_, lane) => view.getUint32(160 + i * 16 + lane * 4, true)),
    );
  }
  cpu.x87.restore({ control, status: status & ~(7 << 11), top, tags, values });
  cpu.simd.restore({ mxcsr, registers });
}
