import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRootSignatureDescriptor,
  parseVersionedRootSignatureDescriptor,
} from '../src/d3d12-descriptors.js';
import { canonicalBindings, decodeRootSignatureWords, planRootSignature, resolveDescriptorPlacement } from '../src/d3d12-bindings.js';

// A tiny guest-memory model with the same accessors the real runtime supplies,
// so the parser is exercised through its documented interface rather than by
// reaching into its internals.
function memory(size = 4096) {
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  let high = size;
  const check = (pointer, length, write = false) => {
    if (!Number.isInteger(pointer) || pointer < 0 || pointer + length > data.length)
      throw Error('out of bounds');
    if (write) return pointer;
    return pointer;
  };
  return {
    data,
    view,
    check,
    read32: (pointer) => view.getUint32(check(pointer, 4), true),
    readFloat32: (pointer) => view.getFloat32(check(pointer, 4), true),
    u32(pointer, value, offset = 0) {
      view.setUint32(pointer + offset, value >>> 0, true);
    },
    f32(pointer, value, offset = 0) {
      view.setFloat32(pointer + offset, value, true);
    },
    // Returns a free pointer aligned to four bytes.
    alloc(bytes) {
      high = (high - bytes) & ~3;
      return high;
    },
  };
}

const parse = (m, pointer) =>
  parseRootSignatureDescriptor({
    check: m.check,
    read32: m.read32,
    readFloat32: m.readFloat32,
    pointer,
  });

// Records are written into one contiguous block, matching D3D12's inline
// arrays of D3D12_ROOT_PARAMETER, D3D12_DESCRIPTOR_RANGE and
// D3D12_STATIC_SAMPLER_DESC (not arrays of pointers).
function writeRange(m, at, { type, descriptors, base, space = 0, offset = 0 }) {
  m.u32(at, type);
  m.u32(at, descriptors, 4);
  m.u32(at, base, 8);
  m.u32(at, space, 12);
  m.u32(at, offset, 16);
  return at + 20;
}

function writeParameter(
  m,
  at,
  { type, visibility = 0, ranges = 0, rangeCount = 0, register = 0, space = 0, valueCount = 0 },
) {
  m.u32(at, type);
  if (type === 0) {
    m.u32(at, rangeCount, 4);
    m.u32(at, ranges, 8);
  } else if (type === 1) {
    m.u32(at, register, 4);
    m.u32(at, space, 8);
    m.u32(at, valueCount, 12);
  } else {
    m.u32(at, register, 4);
    m.u32(at, space, 8);
  }
  m.u32(at, visibility, 16);
  return at + 20;
}

function writeSampler(
  m,
  at,
  {
    filter = 21,
    addressU = 3,
    addressV = 3,
    addressW = 3,
    bias = 0,
    maxAnisotropy = 1,
    comparisonFunc = 0,
    borderColour = 0,
    minLod = 0,
    maxLod = 3.4028234663852886e38,
    register = 0,
    space = 0,
    visibility = 0,
  },
) {
  m.u32(at, filter);
  m.u32(at, addressU, 4);
  m.u32(at, addressV, 8);
  m.u32(at, addressW, 12);
  m.f32(at, bias, 16);
  m.u32(at, maxAnisotropy, 20);
  m.u32(at, comparisonFunc, 24);
  m.u32(at, borderColour, 28);
  m.f32(at, minLod, 32);
  m.f32(at, maxLod, 36);
  m.u32(at, register, 40);
  m.u32(at, space, 44);
  m.u32(at, visibility, 48);
  return at + 52;
}

/**
 * Builds a guest D3D12_ROOT_SIGNATURE_DESC. `parameters` and `samplers` are
 * descriptions (plus, for tables, their own `ranges`), and every nested record
 * is laid out contiguously the way D3D12 expects.
 */
function rootSignature(m, { parameters = [], samplers = [], flags = 1 }) {
  const rangeCounts = parameters.map((p) => (p.type === 0 ? p.ranges.length : 0));
  const totalRanges = rangeCounts.reduce((a, b) => a + b, 0);
  const parameterArray = parameters.length ? m.alloc(parameters.length * 20) : 0;
  const rangeArray = totalRanges ? m.alloc(totalRanges * 20) : 0;
  const samplerArray = samplers.length ? m.alloc(samplers.length * 52) : 0;

  let rangeCursor = rangeArray;
  parameters.forEach((description, index) => {
    const ranges = description.ranges ?? [];
    for (const range of ranges) rangeCursor = writeRange(m, rangeCursor, range);
    writeParameter(m, parameterArray + index * 20, {
      ...description,
      ranges: ranges.length ? (rangeArray + (rangeCursor - rangeArray) - ranges.length * 20) : 0,
      rangeCount: ranges.length,
    });
  });
  samplers.forEach((description, index) => writeSampler(m, samplerArray + index * 52, description));

  const at = m.alloc(20);
  m.u32(at, parameters.length);
  m.u32(at, parameterArray, 4);
  m.u32(at, samplers.length, 8);
  m.u32(at, samplerArray, 12);
  m.u32(at, flags, 16);
  return at;
}

test('decodes an empty root signature description', () => {
  const m = memory();
  const words = parse(m, rootSignature(m, {}));
  assert.deepEqual(Array.from(words), [0, 0, 1, 0, 11, 0]);
  const plan = planRootSignature(decodeRootSignatureWords(words));
  assert.equal(plan.slotCount, 0);
  assert.deepEqual(plan.parameters, []);
});

// Mirrors D3D12HelloTexture's signature: one SRV descriptor table for t0 with a
// static linear/clamp sampler for s0, plus a root CBV for b0.
test('decodes a descriptor table with a static sampler and a root CBV', () => {
  const m = memory();
  const words = parse(
    m,
    rootSignature(m, {
      parameters: [
        { type: 0, visibility: 5, ranges: [{ type: 0, descriptors: 1, base: 0 }] },
        { type: 2, visibility: 1, register: 0 },
      ],
      samplers: [{ register: 0, visibility: 5 }],
    }),
  );

  const signature = planRootSignature(decodeRootSignatureWords(words));
  assert.equal(signature.parameterCount, 2);
  assert.equal(signature.staticSamplerCount, 1);
  assert.equal(signature.slotCount, 2);
  assert.deepEqual(
    signature.parameters.map((p) => [p.type, p.slot, p.slotCount]),
    [
      ['descriptor-table', 0, 1],
      ['cbv', 1, 1],
    ],
  );
  // SRV t0 comes from the table's first slot; the sampler is static, so it is
  // answered by the signature rather than by a heap slot.
  assert.deepEqual(resolveDescriptorPlacement(signature, { type: 0, space: 0, register: 0 }), {
    kind: 'table',
    parameter: 0,
    heapSlot: 0,
  });
  assert.equal(resolveDescriptorPlacement(signature, { type: 3, space: 0, register: 0 }).kind, 'static-sampler');
  // The root CBV is a root descriptor, not a heap slot.
  assert.deepEqual(resolveDescriptorPlacement(signature, { type: 2, space: 0, register: 0 }), {
    kind: 'root-descriptor',
    parameter: 1,
  });
});

test('decodes inline 32-bit constants', () => {
  const m = memory();
  const words = parse(
    m,
    rootSignature(m, { parameters: [{ type: 1, register: 0, valueCount: 16, visibility: 1 }] }),
  );
  assert.equal(words[3], 16, 'root constant total is recorded in the header');
  const signature = planRootSignature(decodeRootSignatureWords(words));
  assert.equal(signature.parameters[0].valueCount, 16);
  assert.deepEqual(resolveDescriptorPlacement(signature, { type: 2, space: 0, register: 0 }), {
    kind: 'inline-constants',
    parameter: 0,
  });
});

test('decodes tables with gaps, multiple ranges and register spaces', () => {
  const m = memory();
  const words = parse(
    m,
    rootSignature(m, {
      parameters: [
        {
          type: 0,
          ranges: [
            { type: 0, descriptors: 3, base: 0, space: 0, offset: 0 },
            { type: 2, descriptors: 2, base: 5, space: 1, offset: 4 },
          ],
        },
      ],
    }),
  );
  const signature = planRootSignature(decodeRootSignatureWords(words));
  // Highest claimed slot is 4 + 2 = 6.
  assert.equal(signature.parameters[0].slotCount, 6);
  assert.deepEqual(
    signature.parameters[0].ranges.map((range) => [range.kind, range.slot, range.count]),
    [
      ['srv', 0, 3],
      ['cbv', 4, 2],
    ],
  );
  // Space 1 register 5 is the second CBV in the second range.
  assert.deepEqual(resolveDescriptorPlacement(signature, { type: 2, space: 1, register: 5 }), {
    kind: 'table',
    parameter: 0,
    heapSlot: 4,
  });
});

test('preserves static sampler filter, address modes and LOD bounds', () => {
  const m = memory();
  const words = parse(
    m,
    rootSignature(m, {
      samplers: [
        {
          filter: 85, // anisotropic
          addressU: 1, // wrap
          addressV: 2, // mirror
          addressW: 4, // border
          bias: -0.5,
          maxAnisotropy: 8,
          comparisonFunc: 3,
          borderColour: 1,
          minLod: 1.5,
          maxLod: 9.25,
          register: 3,
          space: 2,
          visibility: 5,
        },
      ],
    }),
  );
  const [decoded] = decodeRootSignatureWords(words).samplers;
  assert.equal(decoded.filter, 85);
  assert.deepEqual([decoded.addressU, decoded.addressV, decoded.addressW], [1, 2, 4]);
  assert.equal(decoded.maxAnisotropy, 8);
  assert.equal(decoded.comparisonFunc, 3);
  assert.equal(decoded.borderColour, 1);
  assert.equal(decoded.register, 3);
  assert.equal(decoded.space, 2);
  assert.equal(decoded.visibility, 'pixel');
});

test('rejects structurally invalid descriptions', () => {
  // Each case builds and parses inside one memory so pointers are meaningful.
  const invalid = (build) => {
    const m = memory();
    return parse(m, rootSignature(m, build));
  };
  const m0 = memory();
  assert.equal(parse(m0, 0), null);
  // A descriptor table with no ranges.
  assert.equal(invalid({ parameters: [{ type: 0, ranges: [] }] }), null);
  // An unknown parameter type.
  assert.equal(invalid({ parameters: [{ type: 7 }] }), null);
  // A visibility outside D3D12_SHADER_VISIBILITY.
  assert.equal(invalid({ parameters: [{ type: 2, register: 0, visibility: 9 }] }), null);
  // Zero-length 32-bit constants.
  assert.equal(invalid({ parameters: [{ type: 1, register: 0, valueCount: 0 }] }), null);
  // A range with zero descriptors.
  assert.equal(
    invalid({ parameters: [{ type: 0, ranges: [{ type: 0, descriptors: 0, base: 0 }] }] }),
    null,
  );
  // Too many parameters for the bounded bridge.
  assert.equal(
    invalid({ parameters: Array.from({ length: 65 }, () => ({ type: 2, register: 0 })) }),
    null,
  );
  // Flags beyond the documented root-signature bits.
  assert.equal(invalid({ flags: 0x80 }), null);
});

// The decoded description must be a valid input to the shader bridge's builder,
// which is checked in the browser; here we confirm the layout the bridge
// documents (header, parameters, ranges in table order, samplers last).
test('lays the flattened words out in the documented order', () => {
  const m = memory();
  const words = parse(
    m,
    rootSignature(m, {
      parameters: [
        { type: 0, ranges: [{ type: 0, descriptors: 1, base: 0, offset: 2 }] },
        { type: 1, register: 1, valueCount: 4 },
      ],
      samplers: [{ register: 0 }],
    }),
  );
  assert.equal(words.length, 6 + 2 * 7 + 1 * 5 + 1 * 11);
  assert.equal(words[0], 2);
  assert.equal(words[1], 1);
  assert.equal(words[3], 4);
  assert.equal(words[4], 11);
  // Range records start right after the parameter block.
  assert.equal(words[6 + 6], 6 + 2 * 7, 'table points at its first range record');
  assert.equal(words[6 + 2 * 7 + 4], 2, 'range table offset is preserved');
  assert.equal(words[words.length - 11 + 10] & 0xffff, 0, 'sampler register is last');
});

// D3D12_VERSIONED_ROOT_SIGNATURE_DESC: version 1.0 and 1.1 descriptions, whose
// descriptor ranges differ only by an added flags field.
test('decodes a versioned 1.1 description with its wider range records', () => {
  const m = memory(4096);
  const rangeArray = m.alloc(24);
  m.u32(rangeArray, 0); // SRV
  m.u32(rangeArray, 1, 4);
  m.u32(rangeArray, 0, 8);
  m.u32(rangeArray, 0, 12);
  m.u32(rangeArray, 0x10000 | 0x2, 16); // Flags: descriptors + data volatile
  m.u32(rangeArray, 0, 20); // OffsetInDescriptorsFromTableStart
  const parameters = m.alloc(20);
  m.u32(parameters, 0); // descriptor table
  m.u32(parameters, 1, 4);
  m.u32(parameters, rangeArray, 8);
  m.u32(parameters, 5, 16); // pixel visibility
  const description = m.alloc(24);
  m.u32(description, 2); // D3D_ROOT_SIGNATURE_VERSION_1_1
  m.u32(description, 1, 4); // NumParameters
  m.u32(description, parameters, 8);
  m.u32(description, 0, 12); // NumStaticSamplers
  m.u32(description, 0, 16);
  m.u32(description, 1, 20); // Flags
  const words = parseVersionedRootSignatureDescriptor({
    check: m.check,
    read32: m.read32,
    readFloat32: m.readFloat32,
    pointer: description,
  });
  assert.ok(words, 'the versioned description was rejected');
  const plan = planRootSignature(decodeRootSignatureWords(words));
  assert.equal(plan.parameterCount, 1);
  assert.equal(plan.flags, 1);
  assert.deepEqual(plan.ranges.map((r) => [r.kind, r.count, r.space, r.tableOffset]), [
    ['srv', 1, 0, 0],
  ]);
});

test('rejects a malformed versioned description', () => {
  const make = (mutate) => {
    const m = memory(4096);
    const parameters = m.alloc(20);
    m.u32(parameters, 0);
    m.u32(parameters, 1, 4);
    m.u32(parameters, 0, 8); // a null range pointer
    const description = m.alloc(24);
    m.u32(description, 1);
    m.u32(description, 1, 4);
    m.u32(description, parameters, 8);
    mutate?.(m, description, parameters);
    return parseVersionedRootSignatureDescriptor({
      check: m.check,
      read32: m.read32,
      readFloat32: m.readFloat32,
      pointer: description,
    });
  };
  assert.equal(make(), null, 'a table with no range pointer must be rejected');
  // An unknown version is not a 1.0 or 1.1 description.
  assert.equal(
    make((m, description) => m.u32(description, 3)),
    null,
  );
  // A 1.1 range may not carry an unknown flag.
  assert.equal(
    make((m, description, parameters) => {
      m.u32(description, 2);
      const range = m.alloc(24);
      m.u32(range, 0);
      m.u32(range, 1, 4);
      m.u32(range, 0x20000, 16);
      m.u32(parameters, range, 8);
    }),
    null,
  );
});
