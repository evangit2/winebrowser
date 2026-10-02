// PE32 pipeline-state streams have pointer-aligned (4-byte) subobjects. Decode
// the graphics subset into the same checked classic descriptor path; omitted
// state receives documented D3D12 defaults, never application-specific values.
export function pipelineStreamDescriptor({ data, check, read32, pointer, size }) {
  if (!size || size > 65536 || size % 4) throw Error('Invalid D3D12 pipeline stream size');
  check(pointer, size);
  const result = new Uint8Array(572),
    view = new DataView(result.buffer);
  const word = (offset, value) => view.setUint32(offset, value >>> 0, true);
  word(392, 0xffffffff);
  word(396, 3);
  word(400, 3);
  word(420, 1);
  word(440, 1);
  word(444, 1);
  word(448, 2);
  word(548, 1);
  for (let i = 0; i < 8; i++) {
    const base = 72 + i * 40;
    for (const [offset, value] of [
      [8, 2],
      [12, 1],
      [16, 1],
      [20, 2],
      [24, 1],
      [28, 1],
      [32, 4],
    ])
      word(base + offset, value);
    result[base + 36] = 15;
  }
  const fields = {
    0: [4, 0],
    1: [8, 4],
    2: [8, 12],
    3: [8, 20],
    4: [8, 28],
    5: [8, 36],
    7: [20, 44],
    8: [328, 64],
    9: [4, 392],
    10: [44, 396],
    11: [52, 440],
    12: [8, 492],
    13: [4, 500],
    14: [4, 504],
    16: [4, 544],
    17: [8, 548],
    18: [4, 556],
    19: [8, 560],
    20: [4, 568],
  };
  const seen = new Set();
  for (let at = 0; at < size;) {
    const type = read32(pointer + at) >>> 0;
    if (seen.has(type)) throw Error('Duplicate D3D12 pipeline stream subobject');
    seen.add(type);
    const field = fields[type];
    const bytes = type === 15 ? 36 : field?.[0];
    if (!bytes) throw Error(`Unsupported D3D12 pipeline stream subobject ${type}`);
    if (at + 4 + bytes > size) throw Error('Truncated D3D12 pipeline stream subobject');
    const payload = pointer + at + 4;
    if (type === 15) {
      result.set(data.subarray(payload, payload + 32), 512);
      word(508, read32(payload + 32));
    } else result.set(data.subarray(payload, payload + bytes), field[1]);
    at += 4 + bytes;
  }
  if (![0, 1, 2].every((type) => seen.has(type)))
    throw Error('D3D12 graphics stream requires root, vertex and pixel shaders');
  // An omitted depth format means there is no depth attachment.
  if (!view.getUint32(544, true) && !seen.has(11)) result.fill(0, 440, 492);
  return result;
}
