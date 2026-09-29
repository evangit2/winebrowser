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
      u32(read32, descriptor, 36) !== 1 ||
      u32(read32, descriptor, 40) ||
      u32(read32, descriptor, 44)
    )
      return null;
    const format = u32(read32, descriptor, 32);
    if (format === 55) {
      // A D16_UNORM depth attachment: one mip, one array slice, DEPTH_WRITE
      // state and an explicit depth clear value are all required.
      if (
        u32(read32, descriptor, 48) !== 2 ||
        initialState !== 0x10 ||
        !clearValue
      )
        return null;
    } else {
      // An ordinary sampled 2D texture: R8G8B8A8_UNORM, one mip, one slice,
      // no clear value, and an initial state the renderer can copy into.
      const bpp = TEXTURE_FORMAT_BYTES[format];
      if (
        !bpp ||
        u32(read32, descriptor, 48) ||
        clearValue ||
        !SAMPLED_TEXTURE_STATES.has(initialState)
      )
        return null;
      return { kind: 'texture', width, height, format, bytesPerPixel: bpp, state: initialState };
    }
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

// D3D12_ROOT_SIGNATURE_DESC and its nested records, decoded into the flattened
// word layout the shader bridge consumes. Offsets are the 32-bit (i686) ABI:
//   root signature   NumParameters 0, pParameters 4, NumStaticSamplers 8,
//                    pStaticSamplers 12, Flags 16        (20 bytes)
//   parameter        ParameterType 0, union 4..15, ShaderVisibility 16 (20)
//   descriptor range RangeType 0, NumDescriptors 4, BaseShaderRegister 8,
//                    RegisterSpace 12, OffsetInDescriptorsFromTableStart 16 (20)
//   static sampler   Filter 0, AddressU/V/W 4/8/12, MipLODBias 16,
//                    MaxAnisotropy 20, ComparisonFunc 24, BorderColor 28,
//                    MinLOD 32, MaxLOD 36, ShaderRegister 40,
//                    RegisterSpace 44, ShaderVisibility 48    (52 bytes)
const ROOT_HEADER_WORDS = 6;
const PARAMETER_WORDS = 7;
const RANGE_WORDS = 5;
const SAMPLER_WORDS = 11;
const MAX_PARAMETERS = 64;
const MAX_RANGES = 128;
const MAX_SAMPLERS = 64;
const ROOT_PARAMETER_TYPES = 5;
const DESCRIPTOR_RANGE_TYPES = 4;
const MAX_VISIBILITY = 5;
const MAX_CONSTANT_WORDS = 64;

/**
 * Reads a guest D3D12_ROOT_SIGNATURE_DESC into the flattened layout
 * `ShaderCompiler.buildRootSignature` accepts. Returns a Uint32Array, or null
 * for a structurally invalid description (the caller reports E_INVALIDARG).
 */
// DXGI formats the D3D12 texture path models, with their bytes per pixel.
const TEXTURE_FORMAT_BYTES = { 28: 4, 87: 4, 49: 2, 61: 1 };
// A sampled texture may start in COMMON, COPY_DEST or PIXEL_SHADER_RESOURCE.
const SAMPLED_TEXTURE_STATES = new Set([0, 0x400, 0x40]);

export function parseRootSignatureDescriptor({ check, read32, readFloat32, pointer }) {
  const u32 = (at) => read32(at) >>> 0;
  if (!pointer) return null;
  check(pointer, 20);
  const parameterCount = u32(pointer);
  const parameters = u32(pointer + 4);
  const samplerCount = u32(pointer + 8);
  const samplers = u32(pointer + 12);
  const flags = u32(pointer + 16);
  if (parameterCount > MAX_PARAMETERS || samplerCount > MAX_SAMPLERS) return null;
  if (flags & ~0x7f) return null;
  if (parameterCount && !parameters) return null;
  if (samplerCount && !samplers) return null;

  const rangeBlockStart = ROOT_HEADER_WORDS + parameterCount * PARAMETER_WORDS;
  // Count ranges first: they follow the whole parameter block in one array.
  let totalRanges = 0;
  for (let i = 0; i < parameterCount; i++) {
    const at = parameters + i * 20;
    check(at, 20);
    if (u32(at) === 0) {
      const count = u32(at + 4);
      if (count > MAX_RANGES) return null;
      totalRanges += count;
    }
  }
  if (totalRanges > MAX_RANGES) return null;
  const samplerStart = rangeBlockStart + totalRanges * RANGE_WORDS;
  const words = new Uint32Array(samplerStart + samplerCount * SAMPLER_WORDS);
  words[0] = parameterCount;
  words[1] = samplerCount;
  words[2] = flags;
  words[4] = SAMPLER_WORDS;

  let rangeCursor = rangeBlockStart;
  for (let i = 0; i < parameterCount; i++) {
    const at = parameters + i * 20;
    const type = u32(at);
    const visibility = u32(at + 16);
    if (type >= ROOT_PARAMETER_TYPES || visibility > MAX_VISIBILITY) return null;
    const base = ROOT_HEADER_WORDS + i * PARAMETER_WORDS;
    words[base] = type;
    words[base + 1] = visibility;
    if (type === 0) {
      const count = u32(at + 4);
      const ranges = u32(at + 8);
      // D3D12 requires at least one range per descriptor table.
      if (!count || count > MAX_RANGES) return null;
      words[base + 2] = count;
      if (!ranges) return null;
      for (let r = 0; r < count; r++) {
        const record = ranges + r * 20;
        check(record, 20);
        const rangeType = u32(record);
        const descriptors = u32(record + 4);
        const source = rangeCursor + r * RANGE_WORDS;
        if (rangeType >= DESCRIPTOR_RANGE_TYPES || !descriptors) return null;
        words[base + 6] = rangeCursor; // absolute index of this table's first range
        words[source] = rangeType;
        words[source + 1] = descriptors;
        words[source + 2] = u32(record + 8);
        words[source + 3] = u32(record + 12);
        words[source + 4] = u32(record + 16);
      }
      rangeCursor += count * RANGE_WORDS;
    } else if (type === 1) {
      const shaderRegister = u32(at + 4);
      const registerSpace = u32(at + 8);
      const valueCount = u32(at + 12);
      if (!valueCount || valueCount > MAX_CONSTANT_WORDS) return null;
      words[base + 3] = shaderRegister;
      words[base + 4] = registerSpace;
      words[base + 5] = valueCount;
      words[3] += valueCount;
    } else {
      words[base + 3] = u32(at + 4);
      words[base + 4] = u32(at + 8);
    }
  }

  for (let i = 0; i < samplerCount; i++) {
    const at = samplers + i * 52;
    check(at, 52);
    const visibility = u32(at + 48);
    if (visibility > MAX_VISIBILITY) return null;
    const base = samplerStart + i * SAMPLER_WORDS;
    words[base] = u32(at);
    words[base + 1] = u32(at + 4);
    words[base + 2] = u32(at + 8);
    words[base + 3] = u32(at + 12);
    const bias = readFloat32(at + 16);
    const minLod = readFloat32(at + 32);
    const maxLod = readFloat32(at + 36);
    const view = new DataView(new ArrayBuffer(4));
    const bits = (value) => {
      view.setFloat32(0, value, true);
      return view.getUint32(0, true);
    };
    words[base + 4] = bits(bias);
    words[base + 5] = u32(at + 20);
    words[base + 6] = u32(at + 24);
    words[base + 7] = u32(at + 28);
    words[base + 8] = bits(minLod);
    words[base + 9] = bits(maxLod);
    words[base + 10] =
      (u32(at + 40) & 0xffff) | ((u32(at + 44) & 0xff) << 16) | ((visibility & 0xff) << 24);
  }
  return words;
}
