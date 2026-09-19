// Pure parsers for the bounded PE32 D3D12 descriptor subset. Callers provide
// memory accessors so parsing has no COM, allocation, or backend side effects.
const u32 = (read32, pointer, offset = 0) => read32(pointer + offset) >>> 0;

export function parseResourceRange({ check, read32, pointer, size }) {
  if (!pointer) return;
  check(pointer, 8);
  const begin = u32(read32, pointer),
    end = u32(read32, pointer, 4);
  if (begin > end || end > size) throw Error('Invalid D3D12 resource range');
}

export function parseInputLayout({ check, read32, readString, pointer, count }) {
  if (!count) return [];
  if (count !== 2) throw Error('Unsupported D3D12 input element count');
  check(pointer, 56);
  const expected = [
    { semantic: 'POSITION', shaderLocation: 0, offset: 0 },
    { semantic: 'COLOR', shaderLocation: 1, offset: 16 },
  ];
  return expected.map((item, index) => {
    const element = pointer + index * 28;
    if (
      readString(u32(read32, element)).toUpperCase() !== item.semantic ||
      u32(read32, element, 4) ||
      u32(read32, element, 8) !== 2 ||
      u32(read32, element, 12) ||
      u32(read32, element, 16) !== item.offset ||
      u32(read32, element, 20) ||
      u32(read32, element, 24)
    )
      throw Error('Unsupported D3D12 input layout');
    return { shaderLocation: item.shaderLocation, offset: item.offset, format: 'float32x4' };
  });
}

export function parsePipelineDescriptor({ check, data, read32, readString, pointer }) {
  check(pointer, 572);
  if (
    [20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 500, 556, 560, 564, 568].some((offset) =>
      u32(read32, pointer, offset),
    )
  )
    throw Error('Unsupported D3D12 pipeline geometry, input, cache, or node state');
  if (
    u32(read32, pointer, 504) !== 3 ||
    u32(read32, pointer, 508) !== 1 ||
    u32(read32, pointer, 512) !== 28 ||
    [516, 520, 524, 528, 532, 536, 540].some((offset) => u32(read32, pointer, offset)) ||
    ![0, 55].includes(u32(read32, pointer, 544)) ||
    u32(read32, pointer, 548) !== 1 ||
    u32(read32, pointer, 552) !== 0 ||
    u32(read32, pointer, 392) !== 0xffffffff
  )
    throw Error('Unsupported D3D12 pipeline target/topology/sampling');
  const blend = data.subarray(pointer + 64, pointer + 392);
  if (blend.some((value, offset) => value !== (offset === 44 ? 15 : 0)))
    throw Error('Unsupported D3D12 blend pipeline');
  if (
    [3, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0].some(
      (value, index) => u32(read32, pointer, 396 + index * 4) !== value,
    )
  )
    throw Error('Unsupported D3D12 rasterizer pipeline');
  let depth = null;
  if (u32(read32, pointer, 544) === 55) {
    if (
      u32(read32, pointer, 440) !== 1 ||
      ![0, 1].includes(u32(read32, pointer, 444)) ||
      u32(read32, pointer, 448) !== 4 ||
      data.subarray(pointer + 452, pointer + 492).some((value) => value !== 0)
    )
      throw Error('Unsupported D3D12 depth/stencil pipeline');
    depth = {
      format: 'depth16unorm',
      writeEnabled: !!u32(read32, pointer, 444),
      compare: 'less-equal',
    };
  } else if (data.subarray(pointer + 440, pointer + 492).some((value) => value !== 0)) {
    throw Error('D3D12 depth state requires a D16_UNORM target');
  }
  const inputLayout = parseInputLayout({
    check,
    read32,
    readString,
    pointer: u32(read32, pointer, 492),
    count: u32(read32, pointer, 496),
  });
  return {
    root: u32(read32, pointer),
    vertex: { pointer: u32(read32, pointer, 4), size: u32(read32, pointer, 8) },
    pixel: { pointer: u32(read32, pointer, 12), size: u32(read32, pointer, 16) },
    inputLayout,
    vertexStride: inputLayout.length ? 32 : 0,
    depth,
  };
}

export function parseCommittedResourceDescriptor({
  check,
  data,
  read32,
  readFloat32,
  heap,
  heapFlags,
  descriptor,
  initialState,
  clearValue,
  maxBytes,
}) {
  check(heap, 20);
  check(descriptor, 56);
  if (
    heapFlags ||
    u32(read32, heap, 4) ||
    u32(read32, heap, 8) ||
    u32(read32, heap, 12) !== 1 ||
    u32(read32, heap, 16) !== 1 ||
    u32(read32, descriptor, 8) ||
    u32(read32, descriptor, 12) ||
    u32(read32, descriptor, 20)
  )
    return null;
  const heapType = u32(read32, heap);
  const dimension = u32(read32, descriptor);
  const width = u32(read32, descriptor, 16);
  const height = u32(read32, descriptor, 24);
  if (!width || width > maxBytes) return null;
  const uint16 = (offset) => data[descriptor + offset] | (data[descriptor + offset + 1] << 8);
  if (heapType === 2) {
    if (
      dimension !== 1 ||
      height !== 1 ||
      uint16(28) !== 1 ||
      uint16(30) !== 1 ||
      u32(read32, descriptor, 32) ||
      u32(read32, descriptor, 36) !== 1 ||
      u32(read32, descriptor, 40) ||
      u32(read32, descriptor, 44) !== 1 ||
      u32(read32, descriptor, 48) ||
      initialState !== 0xac3 ||
      clearValue
    )
      return null;
    return { kind: 'buffer', size: width, state: initialState };
  }
  if (heapType === 1) {
    if (
      dimension !== 3 ||
      !height ||
      height > 2048 ||
      width > 2048 ||
      uint16(28) !== 1 ||
      uint16(30) !== 1 ||
      u32(read32, descriptor, 32) !== 55 ||
      u32(read32, descriptor, 36) !== 1 ||
      u32(read32, descriptor, 40) ||
      u32(read32, descriptor, 44) ||
      u32(read32, descriptor, 48) !== 2 ||
      initialState !== 0x10 ||
      !clearValue
    )
      return null;
    check(clearValue, 20);
    const depth = readFloat32(clearValue + 4);
    if (
      u32(read32, clearValue) !== 55 ||
      !Number.isFinite(depth) ||
      depth < 0 ||
      depth > 1 ||
      data[clearValue + 8] ||
      data.subarray(clearValue + 9, clearValue + 20).some((value) => value !== 0)
    )
      return null;
    return { kind: 'depth', width, height, format: 'depth16unorm', state: initialState };
  }
  return null;
}
