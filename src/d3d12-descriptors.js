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

// D3D12_INPUT_ELEMENT_DESC subset for the POSITION/COLOR interleaved layout the
// Microsoft samples use. `semantics` lists the accepted names in element order
// with the WebGPU location and float width each maps to.
export function parseInputLayout({ check, read32, readString, pointer, count, semantics }) {
  if (!count) return { attributes: [], stride: 0 };
  if (!semantics || count !== semantics.length)
    throw Error('Unsupported D3D12 input element count');
  check(pointer, count * 28);
  let minOffset = Infinity,
    maxEnd = 0;
  const attributes = semantics.map((expected, index) => {
    const element = pointer + index * 28;
    // DXGI_FORMAT_R32G32B32_FLOAT (6) or R32G32B32A32_FLOAT (2).
    const format = u32(read32, element, 8);
    const width = format === 6 ? 3 : format === 2 ? 4 : 0;
    if (
      readString(u32(read32, element)).toUpperCase() !== expected.semantic ||
      u32(read32, element, 4) !== expected.semanticIndex ||
      !width ||
      u32(read32, element, 12) ||
      u32(read32, element, 20) ||
      u32(read32, element, 24)
    )
      throw Error(
        'Unsupported D3D12 input layout element ' +
          JSON.stringify({
            semantic: readString(u32(read32, element)),
            index: u32(read32, element, 4),
            format,
            inputSlot: u32(read32, element, 12),
            offset: u32(read32, element, 16),
            classification: u32(read32, element, 20),
            stepRate: u32(read32, element, 24),
          }),
      );
    const offset = u32(read32, element, 16);
    minOffset = Math.min(minOffset, offset);
    maxEnd = Math.max(maxEnd, offset + width * 4);
    return {
      semantic: expected.semantic,
      semanticIndex: expected.semanticIndex,
      shaderLocation: expected.shaderLocation,
      format: width === 3 ? 'float32x3' : 'float32x4',
      offset,
      width,
    };
  });
  if (minOffset) throw Error('Unsupported D3D12 input layout base offset');
  return { attributes, stride: maxEnd };
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
  // D3D12_BLEND_DESC: two BOOLs, then 8 D3D12_RENDER_TARGET_BLEND_DESC entries
  // of 40 bytes. Each entry is {Enable, LogicOpEnable, Src, Dest, Op, SrcA,
  // DestA, OpA, LogicOp, WriteMask}. Both the all-zero CD3DX12 default and the
  // D3D12_DEFAULT desc used by the Microsoft samples are valid opaque settings.
  if (u32(read32, pointer, 64) || u32(read32, pointer, 68))
    throw Error('Unsupported D3D12 alpha-to-coverage or independent blend state');
  for (let rt = 0; rt < 8; rt++) {
    const base = pointer + 72 + rt * 40;
    const entry = [0, 4, 8, 12, 16, 20, 24, 28, 32].map((offset) => u32(read32, base, offset));
    // RenderTargetWriteMask is a single UINT8; the following bytes are padding.
    const mask = data[base + 36];
    const enabled = entry[0] >> 0;
    const logicOpDisabled = entry[8] === 0 || entry[8] === 4;
    const validDisabled =
      !enabled &&
      logicOpDisabled &&
      entry.slice(1, 8).every((value) => value === 0) &&
      (mask === 0 || mask === 15);
    // CD3DX12_BLEND_DESC(D3D12_DEFAULT): Copy=ONE, ZERO, ADD for both color
    // and alpha, LOGIC_OP_NOOP, and all write channels enabled.
    const validDefault =
      !enabled && logicOpDisabled && entry.slice(2, 8).join(',') === '2,1,1,2,1,1' && mask === 15;
    if (!validDisabled && !validDefault)
      throw Error(`Unsupported D3D12 render target ${rt} blend state: ${entry.join(',')},${mask}`);
  }
  // D3D12_RASTERIZER_DESC: FillMode, CullMode, FrontCCW, four scalars, three
  // BOOLs and ConservativeRaster. Solid fill with no/front/back culling is
  // supported; wireframe, depth bias and multisample rasterization are not.
  if (
    u32(read32, pointer, 396) !== 3 ||
    ![1, 2, 3].includes(u32(read32, pointer, 400)) ||
    ![0, 1].includes(u32(read32, pointer, 404)) ||
    u32(read32, pointer, 408) ||
    u32(read32, pointer, 412) ||
    u32(read32, pointer, 416) ||
    u32(read32, pointer, 420) !== 1 ||
    u32(read32, pointer, 424) ||
    u32(read32, pointer, 428) ||
    u32(read32, pointer, 432) ||
    u32(read32, pointer, 436)
  )
    throw Error('Unsupported D3D12 rasterizer pipeline');
  const cullMode = ['none', 'front', 'back'][u32(read32, pointer, 400) - 1];
  // D3D FrontCounterClockwise=FALSE means a clockwise winding is front facing,
  // the opposite of WebGPU's counter-clockwise default.
  const frontFace = u32(read32, pointer, 404) ? 'ccw' : 'cw';
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
  const layout = parseInputLayout({
    check,
    read32,
    readString,
    pointer: u32(read32, pointer, 492),
    count: u32(read32, pointer, 496),
    semantics: [
      { semantic: 'POSITION', semanticIndex: 0, shaderLocation: 0 },
      { semantic: 'COLOR', semanticIndex: 0, shaderLocation: 1 },
    ],
  });
  return {
    root: u32(read32, pointer),
    vertex: { pointer: u32(read32, pointer, 4), size: u32(read32, pointer, 8) },
    pixel: { pointer: u32(read32, pointer, 12), size: u32(read32, pointer, 16) },
    inputLayout: layout.attributes,
    vertexStride: layout.stride,
    depth,
    cullMode,
    frontFace,
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
  if ((heapType === 1 || heapType === 2 || heapType === 3) && dimension === 1) {
    // Upload buffers publish GENERIC_READ (0xac3) after their Map/Unmap; the
    // default heap buffers they copy into start in COMMON (0) or COPY_DEST
    // (0x400) and transition to a shader-readable state with a barrier.
    // Readback-heap buffers start in COMMON and are resolved into in-browser.
    const upload = heapType === 2;
    const readback = heapType === 3;
    const states = upload ? [0, 0xac3] : readback ? [0] : [0, 0x400];
    if (
      height !== 1 ||
      uint16(28) !== 1 ||
      uint16(30) !== 1 ||
      u32(read32, descriptor, 32) ||
      u32(read32, descriptor, 36) !== 1 ||
      u32(read32, descriptor, 40) ||
      u32(read32, descriptor, 44) !== 1 ||
      u32(read32, descriptor, 48) ||
      clearValue ||
      !states.includes(initialState)
    )
      return null;
    return { kind: 'buffer', size: width, state: initialState, upload, readback };
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
