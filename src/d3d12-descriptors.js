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
// The per-vertex formats the backend can feed a shader location, with the
// number of 32-bit components each supplies.
const INPUT_FORMATS = {
  2: { components: 4, format: 'float32x4' }, // R32G32B32A32_FLOAT
  6: { components: 3, format: 'float32x3' }, // R32G32B32_FLOAT
  16: { components: 2, format: 'float32x2' }, // R32G32_FLOAT
  41: { components: 4, format: 'sint32x4' }, // R32G32B32A32_SINT
  42: { components: 4, format: 'uint32x4' }, // R32G32B32A32_UINT
};

/**
 * Parses a D3D12_INPUT_LAYOUT_DESC. Semantic names and indices are reported as
 * the application declared them; the caller matches them against the vertex
 * shader's input signature and assigns WebGPU shader locations.
 */
export function parseInputLayout({ check, read32, readString, pointer, count }) {
  if (!count) return { attributes: [], stride: 0 };
  check(pointer, count * 28);
  let minOffset = Infinity,
    maxEnd = 0;
  const attributes = [];
  const seen = new Set();
  for (let index = 0; index < count; index++) {
    const element = pointer + index * 28;
    const semanticName = readString(u32(read32, element));
    const semanticIndex = u32(read32, element, 4);
    const format = u32(read32, element, 8);
    const inputSlot = u32(read32, element, 12);
    const offset = u32(read32, element, 16);
    const classification = u32(read32, element, 20);
    const stepRate = u32(read32, element, 24);
    const described = INPUT_FORMATS[format];
    const key = `${semanticName.toUpperCase()}\0${semanticIndex}`;
    if (!described || !semanticName || inputSlot || classification || stepRate || seen.has(key))
      throw Error(
        'Unsupported D3D12 input layout element ' +
          JSON.stringify({
            semantic: semanticName,
            index: semanticIndex,
            format,
            inputSlot,
            offset,
            classification,
            stepRate,
          }),
      );
    seen.add(key);
    minOffset = Math.min(minOffset, offset);
    maxEnd = Math.max(maxEnd, offset + described.components * 4);
    attributes.push({
      semanticName,
      semanticIndex,
      format: described.format,
      components: described.components,
      offset,
    });
  }
  if (minOffset) throw Error('Unsupported D3D12 input layout base offset');
  return { attributes, stride: maxEnd };
}

// D3D12_BLEND factors the backend can express as a WebGPU blend factor. The
// dual-source (SRC1_*) and alpha-factor operands have no single-source WebGPU
// equivalent and are rejected rather than silently substituted.
const BLEND_FACTORS = {
  1: 'zero',
  2: 'one',
  3: 'src',
  4: 'one-minus-src',
  5: 'src-alpha',
  6: 'one-minus-src-alpha',
  7: 'dst-alpha',
  8: 'one-minus-dst-alpha',
  9: 'dst',
  10: 'one-minus-dst',
  11: 'src-alpha-saturated',
  14: 'constant',
  15: 'one-minus-constant',
};
const BLEND_OPERATIONS = {
  1: 'add',
  2: 'subtract',
  3: 'reverse-subtract',
  4: 'min',
  5: 'max',
};

// D3D12_COMPARISON_FUNC maps one-to-one onto WebGPU's compare functions.
const DEPTH_COMPARE = {
  1: 'never',
  2: 'less',
  3: 'equal',
  4: 'less-equal',
  5: 'greater',
  6: 'not-equal',
  7: 'greater-equal',
  8: 'always',
};

function blendComponent(source, destination, operation) {
  // MIN/MAX ignore the factors; D3D requires them to be ONE.
  const op = BLEND_OPERATIONS[operation];
  if (!op) throw Error(`Unsupported D3D12 blend operation ${operation}`);
  const src = BLEND_FACTORS[source];
  const dst = BLEND_FACTORS[destination];
  if (!src || !dst) throw Error(`Unsupported D3D12 blend factor ${source}/${destination}`);
  if (operation >= 4 && (source !== 2 || destination !== 2))
    throw Error('D3D12 MIN/MAX blending requires ONE factors');
  return { operation: op, srcFactor: src, dstFactor: dst };
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
  // D3D12_BLEND_DESC: AlphaToCoverageEnable, IndependentBlendEnable, then 8
  // D3D12_RENDER_TARGET_BLEND_DESC entries of 40 bytes. Each entry is
  // {Enable, LogicOpEnable, Src, Dest, Op, SrcA, DestA, OpA, LogicOp, WriteMask}.
  // Render target 0 always applies; later targets only matter when independent
  // blending is enabled, so unchanged later entries are ignored.
  const alphaToCoverage = !!u32(read32, pointer, 64);
  const independentBlend = !!u32(read32, pointer, 68);
  const blend = [];
  for (let rt = 0; rt < 8; rt++) {
    const base = pointer + 72 + rt * 40;
    const entry = [0, 4, 8, 12, 16, 20, 24, 28, 32].map((offset) => u32(read32, base, offset));
    // RenderTargetWriteMask is a single UINT8; the following bytes are padding.
    const mask = data[base + 36];
    const target = { writeMask: mask, enabled: !!entry[0] };
    if (entry[1]) throw Error('Unsupported D3D12 logic-op blend target');
    // LOGIC_OP_NOOP (4) is the only logic operation an active target may name.
    if (entry[8] !== 0 && entry[8] !== 4)
      throw Error(`Unsupported D3D12 logic operation ${entry[8]}`);
    if (entry[0]) {
      if (mask & ~0xf) throw Error('Unsupported D3D12 write mask');
      target.color = blendComponent(entry[2], entry[3], entry[4]);
      target.alpha = blendComponent(entry[5], entry[6], entry[7]);
    } else if (mask & ~0xf) {
      throw Error('Unsupported D3D12 write mask');
    }
    if (rt === 0 || independentBlend) blend.push(target);
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
  // D3D12_DEPTH_STENCIL_DESC: DepthEnable, DepthWriteMask, DepthFunc,
  // StencilEnable, StencilReadMask, StencilWriteMask, then the front and back
  // D3D12_DEPTH_STENCILOP_DESC records (8 bytes each). Stencil is not modelled.
  let depth = null;
  if (u32(read32, pointer, 544) === 55) {
    if (
      ![0, 1].includes(u32(read32, pointer, 440)) ||
      ![0, 1].includes(u32(read32, pointer, 444)) ||
      !DEPTH_COMPARE[u32(read32, pointer, 448)] ||
      data[pointer + 452] ||
      data[pointer + 453] ||
      data.subarray(pointer + 456, pointer + 492).some((value) => value !== 0)
    )
      throw Error('Unsupported D3D12 depth/stencil pipeline');
    depth = {
      format: 'depth16unorm',
      // DepthEnable=FALSE means depth testing and writing are both off, which
      // WebGPU expresses as a comparison that always passes with no write.
      testEnabled: !!u32(read32, pointer, 440),
      writeEnabled: !!u32(read32, pointer, 444),
      compare: DEPTH_COMPARE[u32(read32, pointer, 448)],
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
    blend,
    alphaToCoverage,
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
      if (u32(read32, descriptor, 48) !== 2 || initialState !== 0x10 || !clearValue) return null;
    } else {
      // An ordinary 2D texture: R8G8B8A8_UNORM, one mip, one slice. It is
      // either sampled (uploaded into, no clear value) or a render target
      // (ALLOW_RENDER_TARGET plus a clear value, as the descriptor requires).
      const bpp = TEXTURE_FORMAT_BYTES[format];
      const flags = u32(read32, descriptor, 48);
      if (!bpp || flags & ~1) return null;
      if (flags & 1) {
        // D3D12 requires a clear value whenever ALLOW_RENDER_TARGET is set,
        // and the resource starts in RENDER_TARGET state when so requested.
        if (!clearValue || ![0, 4].includes(initialState)) return null;
        check(clearValue, 20);
        // A colour clear value is DXGI_FORMAT plus four FLOATs: all twenty
        // bytes are meaningful, unlike a depth/stencil clear.
        if (u32(read32, clearValue) !== format) return null;
        const colour = Array.from({ length: 4 }, (_, i) => readFloat32(clearValue + 4 + i * 4));
        if (colour.some((value) => !Number.isFinite(value))) return null;
        return {
          kind: 'render-texture',
          width,
          height,
          format,
          bytesPerPixel: bpp,
          state: initialState,
        };
      }
      if (clearValue || !SAMPLED_TEXTURE_STATES.has(initialState)) return null;
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

// D3D12_VERSIONED_ROOT_SIGNATURE_DESC and the version 1.1 records. The 1.1
// parameter and range records add a Flags field, so their sizes differ from the
// 1.0 ones; the parser accepts either version and feeds the same flattened
// layout the bridge builds.
//   versioned desc  Version 0, then the union at 4       (16 bytes, aligned 8)
//   parameter 1.0   ParameterType 0, union 4..15, Visibility 16   (20)
//   parameter 1.1   ParameterType 0, union 4..15, Visibility 16   (20)
//   range 1.0       RangeType 0, Num 4, Base 8, Space 12, Offset 16 (20)
//   range 1.1       RangeType 0, Num 4, Base 8, Space 12, Flags 16,
//                   Offset 20                                    (24)
const MAX_VERSIONED_PARAMETERS = 64;
const VERSIONED_RANGE_1_0_BYTES = 20;
const VERSIONED_RANGE_1_1_BYTES = 24;

/**
 * Reads a guest D3D12_VERSIONED_ROOT_SIGNATURE_DESC into the same flattened
 * word layout `buildRootSignature` consumes. Returns null when the description
 * is outside the bounded subset, so the caller reports E_INVALIDARG.
 */
export function parseVersionedRootSignatureDescriptor({ check, read32, readFloat32, pointer }) {
  const u32 = (at) => read32(at) >>> 0;
  if (!pointer) return null;
  check(pointer, 24);
  const version = u32(pointer);
  // D3D_ROOT_SIGNATURE_VERSION_1_0 (1) and _1_1 (2) share the parameter record
  // layout; only the descriptor ranges differ.
  if (version !== 1 && version !== 2) return null;
  // The union starts at the descriptor's natural alignment, which is 4 here:
  // Version is a 4-byte enum followed immediately by the Desc struct.
  const base = pointer + 4;
  const parameterCount = u32(base);
  const parameters = u32(base + 4);
  const samplerCount = u32(base + 8);
  const samplers = u32(base + 12);
  const flags = u32(base + 16);
  if (parameterCount > MAX_VERSIONED_PARAMETERS || samplerCount > 64) return null;
  if (flags & ~0x7f) return null;
  if (parameterCount && !parameters) return null;
  if (samplerCount && !samplers) return null;

  const rangeBytes = version === 2 ? VERSIONED_RANGE_1_1_BYTES : VERSIONED_RANGE_1_0_BYTES;
  const rangeBlockStart = 6 + parameterCount * 7;
  let totalRanges = 0;
  for (let i = 0; i < parameterCount; i++) {
    const at = parameters + i * 20;
    check(at, 20);
    if (u32(at) === 0) {
      const count = u32(at + 4);
      if (!count || count > 128) return null;
      totalRanges += count;
    }
  }
  if (totalRanges > 128) return null;
  const samplerStart = rangeBlockStart + totalRanges * 5;
  const words = new Uint32Array(samplerStart + samplerCount * 11);
  words[0] = parameterCount;
  words[1] = samplerCount;
  words[2] = flags;
  words[4] = 11;

  let rangeCursor = rangeBlockStart;
  for (let i = 0; i < parameterCount; i++) {
    const at = parameters + i * 20;
    const type = u32(at);
    const visibility = u32(at + 16);
    if (type >= 5 || visibility > 5) return null;
    const record = 6 + i * 7;
    words[record] = type;
    words[record + 1] = visibility;
    if (type === 0) {
      const count = u32(at + 4);
      const ranges = u32(at + 8);
      if (!count || !ranges) return null;
      words[record + 2] = count;
      for (let r = 0; r < count; r++) {
        const range = ranges + r * rangeBytes;
        check(range, rangeBytes);
        const rangeType = u32(range);
        const descriptors = u32(range + 4);
        if (rangeType >= 4 || !descriptors) return null;
        if (version === 2 && u32(range + 16) & ~0x1000f) return null;
        words[record + 6] = rangeCursor;
        const slot = rangeCursor + r * 5;
        words[slot] = rangeType;
        words[slot + 1] = descriptors;
        words[slot + 2] = u32(range + 8);
        words[slot + 3] = u32(range + 12);
        words[slot + 4] = version === 2 ? u32(range + 20) : u32(range + 16);
      }
      rangeCursor += count * 5;
    } else if (type === 1) {
      const valueCount = u32(at + 12);
      if (!valueCount || valueCount > 64) return null;
      words[record + 3] = u32(at + 4);
      words[record + 4] = u32(at + 8);
      words[record + 5] = valueCount;
      words[3] += valueCount;
    } else {
      words[record + 3] = u32(at + 4);
      words[record + 4] = u32(at + 8);
    }
  }

  for (let i = 0; i < samplerCount; i++) {
    const at = samplers + i * 52;
    check(at, 52);
    const visibility = u32(at + 48);
    if (visibility > 5) return null;
    const slot = samplerStart + i * 11;
    const view = new DataView(new ArrayBuffer(4));
    const bits = (value) => {
      view.setFloat32(0, value, true);
      return view.getUint32(0, true);
    };
    words[slot] = u32(at);
    words[slot + 1] = u32(at + 4);
    words[slot + 2] = u32(at + 8);
    words[slot + 3] = u32(at + 12);
    words[slot + 4] = bits(readFloat32(at + 16));
    words[slot + 5] = u32(at + 20);
    words[slot + 6] = u32(at + 24);
    words[slot + 7] = u32(at + 28);
    words[slot + 8] = bits(readFloat32(at + 32));
    words[slot + 9] = bits(readFloat32(at + 36));
    words[slot + 10] =
      (u32(at + 40) & 0xffff) | ((u32(at + 44) & 0xff) << 16) | ((visibility & 0xff) << 24);
  }
  return words;
}
