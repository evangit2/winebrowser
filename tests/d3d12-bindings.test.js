import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CBV_GROUP,
  UAV_GROUP,
  SAMPLER_GROUP,
  DRAW_PARAMETER_GROUP,
  DESCRIPTOR_SRV,
  DESCRIPTOR_UAV,
  DESCRIPTOR_CBV,
  DESCRIPTOR_SAMPLER,
  RESOURCE_BUFFER,
  RESOURCE_TEXTURE_2D,
  RESOURCE_TEXTURE_CUBE,
  DATA_FLOAT,
  DATA_UINT,
  DEFAULT_LIMITS,
  canonicalBindings,
  decodeRootSignatureWords,
  layoutEntries,
  planRootSignature,
  resolveDescriptorPlacement,
} from '../src/d3d12-bindings.js';

// Builds the word array the shader bridge emits, mirroring only the *layout*
// rules the bridge documents: a six-word header, seven words per parameter,
// five per descriptor range (in parameter order, after the whole parameter
// block) and eleven per static sampler. Callers pass parameters with the range
// records they own, so the range block order is explicit at each call site.
const VISIBILITY = 0x6; // VERTEX | FRAGMENT, matching the browser mask
const RANGE_WORDS = 5;
const PARAMETER_WORDS = 7;
const PARAMETER_BASE = 6;
const SAMPLER_WORDS = 11;

function rootSignatureWords({ parameters = [], samplers = [], flags = 1 }) {
  const totalRanges = parameters.reduce((sum, parameter) => sum + parameter.ranges.length, 0);
  const rangeBlockStart = PARAMETER_BASE + parameters.length * PARAMETER_WORDS;
  const words = [
    parameters.length,
    samplers.length,
    flags,
    parameters.reduce(
      (sum, parameter) => sum + (parameter.type === 1 ? parameter.valueCount : 0),
      0,
    ),
    SAMPLER_WORDS,
    0,
  ];
  let rangeCursor = rangeBlockStart;
  for (const parameter of parameters) {
    words.push(
      parameter.type,
      parameter.visibility ?? 0,
      parameter.ranges.length,
      parameter.register ?? 0,
      parameter.space ?? 0,
      parameter.valueCount ?? 0,
      parameter.ranges.length ? rangeCursor : 0,
    );
    rangeCursor += parameter.ranges.length * RANGE_WORDS;
  }
  for (const parameter of parameters)
    for (const range of parameter.ranges)
      words.push(range.kind, range.count, range.baseRegister, range.space ?? 0, range.tableOffset);
  for (const sampler of samplers)
    words.push(
      sampler.filter ?? 21,
      sampler.addressU ?? 3,
      sampler.addressV ?? 3,
      sampler.addressW ?? 3,
      0,
      sampler.maxAnisotropy ?? 1,
      sampler.comparisonFunc ?? 0,
      sampler.borderColour ?? 0,
      0,
      0,
      ((sampler.register ?? 0) & 0xffff) |
        (((sampler.space ?? 0) & 0xff) << 16) |
        (((sampler.visibility ?? 0) & 0xff) << 24),
    );
  assert.equal(
    words.length,
    rangeBlockStart + totalRanges * RANGE_WORDS + samplers.length * SAMPLER_WORDS,
  );
  return Uint32Array.from(words);
}

// Independently captured from the shipped Wasm: serialise a signature with one
// SRV descriptor table (pixel visibility), one 32-bit-constants parameter of 16
// DWORDs and one linear/clamp static sampler, then inspect it. This vector is
// the bridge's real output and is not produced by the builder above.
const REAL_WORDS = Uint32Array.from([
  2, 1, 1, 16, 11, 0, 0, 5, 1, 0, 0, 0, 20, 1, 0, 0, 0, 0, 16, 0, 0, 1, 0, 0, 0, 21, 3, 3, 3, 0, 1,
  0, 0, 0, 0, 83886080,
]);
assert.equal(REAL_WORDS.length, 36, 'captured inspection vector is truncated');

const EMPTY_WORDS = Uint32Array.from([0, 0, 1, 0, 11, 0]);

test('decodes the empty root signature', () => {
  const signature = decodeRootSignatureWords(EMPTY_WORDS);
  assert.equal(signature.parameterCount, 0);
  assert.equal(signature.staticSamplerCount, 0);
  assert.equal(signature.flags, 1);
  assert.deepEqual(signature.parameters, []);
  assert.deepEqual(signature.ranges, []);
  assert.deepEqual(signature.samplers, []);
});

test('decodes the bridge inspection words for a table, constants and a sampler', () => {
  const signature = decodeRootSignatureWords(REAL_WORDS);
  void signature;
  assert.equal(signature.parameterCount, 2);
  assert.equal(signature.staticSamplerCount, 1);
  // The builder must agree with the captured bridge output for this shape.
  assert.deepEqual(
    Array.from(
      rootSignatureWords({
        parameters: [
          {
            type: 0,
            visibility: 5,
            ranges: [{ kind: 0, count: 1, baseRegister: 0, space: 0, tableOffset: 0 }],
          },
          { type: 1, visibility: 0, valueCount: 16, ranges: [] },
        ],
        samplers: [{ visibility: 5 }],
      }),
    ),
    Array.from(REAL_WORDS),
    'test builder diverged from the captured bridge output',
  );
  assert.deepEqual(signature.parameters[0], {
    index: 0,
    type: 'descriptor-table',
    visibility: 'pixel',
    rangeCount: 1,
    register: 0,
    space: 0,
    valueCount: 0,
    rangeBase: 20,
  });
  assert.deepEqual(signature.parameters[1], {
    index: 1,
    type: '32-bit-constants',
    visibility: 'all',
    rangeCount: 0,
    register: 0,
    space: 0,
    valueCount: 16,
    rangeBase: 0,
  });
  assert.deepEqual(signature.ranges, [
    { parameter: 0, index: 0, kind: 'srv', count: 1, baseRegister: 0, space: 0, tableOffset: 0 },
  ]);
  const [sampler] = signature.samplers;
  assert.equal(sampler.filter, 21); // MIN_MAG_MIP_LINEAR
  assert.deepEqual([sampler.addressU, sampler.addressV, sampler.addressW], [3, 3, 3]);
  assert.equal(sampler.maxAnisotropy, 1);
  assert.equal(sampler.register, 0);
  assert.equal(sampler.space, 0);
  assert.equal(sampler.visibility, 'pixel');
});

test('rejects malformed inspection input', () => {
  assert.throws(() => decodeRootSignatureWords(new Uint32Array([1, 2, 3])), /header is truncated/);
  assert.throws(() => decodeRootSignatureWords(null), /inspection words are missing/);
  assert.throws(
    () => decodeRootSignatureWords(new Uint32Array([1, 0, 1, 0, 11, 0, 9, 0, 0, 0, 0, 0, 20])),
    /unknown root parameter type/,
  );
  assert.throws(
    () => decodeRootSignatureWords(new Uint32Array([0, 0, 1, 0, 12, 0])),
    /sampler record width/,
  );
  assert.throws(
    () => decodeRootSignatureWords(new Uint32Array([0, 0, 1, 0, 11, 0, 0])),
    /produced 7 words, expected 6/,
  );
  // A non-table parameter that still declares ranges is malformed: the
  // decoder must not silently accept ranges no root parameter can own.
  assert.throws(
    () =>
      decodeRootSignatureWords(
        new Uint32Array([
          1,
          0,
          0,
          16,
          11,
          0, // header: one parameter, 16 constant DWORDs
          1,
          0,
          1,
          0,
          0,
          16,
          13, // 32-bit constants claiming one range record
          0,
          1,
          0,
          0,
          0, // the stray range record
        ]),
      ),
    /non-table parameter declares descriptor ranges/,
  );
  assert.throws(
    () => decodeRootSignatureWords(new Uint32Array([1, 0, 0, 0, 11, 0, 9, 0, 0, 0, 0, 0, 0])),
    /unknown root parameter type/,
  );
});

test('plans register slots for a table followed by inline constants', () => {
  const signature = planRootSignature(decodeRootSignatureWords(REAL_WORDS));
  // Parameter 0 is a table claiming slot 0 (one SRV at table offset 0);
  // parameter 1 is 16 DWORDs of inline constants claiming the next slot.
  assert.equal(signature.parameters[0].slot, 0);
  assert.equal(signature.parameters[0].slotCount, 1);
  assert.equal(signature.parameters[1].slot, 1);
  assert.equal(signature.parameters[1].slotCount, 1);
  assert.equal(signature.slotCount, 2);
});

test('a table with a non-zero range offset leaves the earlier slots unclaimed', () => {
  const words = rootSignatureWords({
    parameters: [
      {
        type: 0,
        ranges: [
          { kind: 0, count: 1, baseRegister: 0, tableOffset: 4 },
          { kind: 2, count: 2, baseRegister: 3, tableOffset: 6 },
        ],
      },
    ],
  });
  const signature = planRootSignature(decodeRootSignatureWords(words));
  // The highest claimed slot is 6 + 2 = 8, so the table owns eight slots.
  assert.equal(signature.parameters[0].slotCount, 8);
  assert.deepEqual(
    signature.parameters[0].ranges.map((range) => range.slot),
    [4, 6],
  );
  assert.equal(signature.slotCount, 8);
});

test('two tables claim slots in declaration order', () => {
  const words = rootSignatureWords({
    parameters: [
      { type: 0, ranges: [{ kind: 0, count: 2, baseRegister: 0, tableOffset: 0 }] },
      { type: 0, ranges: [{ kind: 0, count: 3, baseRegister: 2, tableOffset: 0 }] },
    ],
  });
  const signature = planRootSignature(decodeRootSignatureWords(words));
  assert.deepEqual(
    signature.parameters.map((p) => p.slot),
    [0, 2],
  );
  assert.equal(signature.slotCount, 5);
});

test('places descriptors by kind into dense group bindings', () => {
  const descriptors = [
    {
      type: DESCRIPTOR_CBV,
      space: 0,
      register: 2,
      resourceType: RESOURCE_BUFFER,
      dataType: DATA_FLOAT,
      count: 1,
    },
    {
      type: DESCRIPTOR_CBV,
      space: 0,
      register: 0,
      resourceType: RESOURCE_BUFFER,
      dataType: DATA_FLOAT,
      count: 1,
    },
    {
      type: DESCRIPTOR_SRV,
      space: 0,
      register: 3,
      resourceType: RESOURCE_TEXTURE_2D,
      dataType: DATA_FLOAT,
      count: 1,
    },
    {
      type: DESCRIPTOR_SAMPLER,
      space: 0,
      register: 3,
      resourceType: 0,
      dataType: DATA_FLOAT,
      count: 1,
    },
    {
      type: DESCRIPTOR_SRV,
      space: 0,
      register: 0,
      resourceType: RESOURCE_TEXTURE_CUBE,
      dataType: DATA_FLOAT,
      count: 1,
    },
  ];
  const { bindings, lookup } = canonicalBindings(descriptors);
  assert.deepEqual(
    bindings.map((b) => [b.group, b.binding, b.register]),
    [
      [CBV_GROUP, 0, 0],
      [CBV_GROUP, 1, 2],
      [UAV_GROUP, 0, 0],
      [UAV_GROUP, 1, 3],
      [SAMPLER_GROUP, 0, 3],
    ],
  );
  assert.equal(lookup.get(`${DESCRIPTOR_SRV}:0:3`).binding, 1);
  assert.equal(lookup.get(`${DESCRIPTOR_CBV}:0:2`).binding, 1);
  assert.ok(
    bindings.every((binding) => binding.group !== DRAW_PARAMETER_GROUP),
    'no descriptor may occupy the draw-parameter group',
  );
});

test('the same register declared by both stages is one binding', () => {
  const vertex = {
    type: DESCRIPTOR_CBV,
    space: 0,
    register: 0,
    resourceType: RESOURCE_BUFFER,
    dataType: DATA_FLOAT,
    count: 1,
  };
  const pixel = { ...vertex, visibility: 'pixel' };
  const { bindings } = canonicalBindings([vertex, pixel]);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].binding, 0);
});

test('register spaces sort before register numbers', () => {
  const { bindings } = canonicalBindings([
    {
      type: DESCRIPTOR_CBV,
      space: 1,
      register: 0,
      resourceType: RESOURCE_BUFFER,
      dataType: DATA_FLOAT,
      count: 1,
    },
    {
      type: DESCRIPTOR_CBV,
      space: 0,
      register: 5,
      resourceType: RESOURCE_BUFFER,
      dataType: DATA_FLOAT,
      count: 1,
    },
  ]);
  assert.deepEqual(
    bindings.map((b) => [b.space, b.register]),
    [
      [0, 5],
      [1, 0],
    ],
  );
});

test('descriptor counts are checked against the WebGPU limits', () => {
  const many = Array.from({ length: 17 }, (_, register) => ({
    type: DESCRIPTOR_SRV,
    space: 0,
    register,
    resourceType: RESOURCE_TEXTURE_2D,
    dataType: DATA_FLOAT,
    count: 1,
  }));
  assert.throws(() => canonicalBindings(many), /17 sampled textures exceed the WebGPU limit of 16/);
  const atLimit = many.slice(0, DEFAULT_LIMITS.maxSampledTextures);
  assert.equal(canonicalBindings(atLimit).bindings.length, DEFAULT_LIMITS.maxSampledTextures);
});

test('rejects unknown descriptor types instead of substituting a binding', () => {
  assert.throws(
    () => canonicalBindings([{ type: 9, space: 0, register: 0 }]),
    /Invalid D3D12 shader descriptor type/,
  );
});

test('layout entries describe the group each binding lives in', () => {
  const { bindings } = canonicalBindings([
    {
      type: DESCRIPTOR_CBV,
      space: 0,
      register: 0,
      resourceType: RESOURCE_BUFFER,
      dataType: DATA_FLOAT,
      count: 1,
    },
    {
      type: DESCRIPTOR_SRV,
      space: 0,
      register: 0,
      resourceType: RESOURCE_BUFFER,
      dataType: DATA_FLOAT,
      count: 1,
    },
    {
      type: DESCRIPTOR_SRV,
      space: 0,
      register: 1,
      resourceType: RESOURCE_TEXTURE_2D,
      dataType: DATA_FLOAT,
      count: 1,
    },
    {
      type: DESCRIPTOR_SRV,
      space: 0,
      register: 2,
      resourceType: RESOURCE_TEXTURE_2D,
      dataType: DATA_UINT,
      count: 1,
    },
    {
      type: DESCRIPTOR_SAMPLER,
      space: 0,
      register: 0,
      resourceType: 0,
      dataType: DATA_FLOAT,
      count: 1,
    },
  ]);
  const layouts = layoutEntries(bindings, VISIBILITY);
  assert.deepEqual(
    layouts.map((layout) => layout.group),
    [CBV_GROUP, UAV_GROUP, SAMPLER_GROUP],
  );
  assert.deepEqual(layouts[0].entries[0].buffer, { type: 'uniform' });
  assert.deepEqual(
    layouts[1].entries.map((entry) => entry.buffer ?? entry.texture),
    [{ type: 'read-only-storage' }, { sampleType: 'float' }, { sampleType: 'uint' }],
  );
  assert.deepEqual(layouts[2].entries[0].sampler, { type: 'filtering' });
});

test('resolves table placement through the declared range offsets', () => {
  const plan = planRootSignature(
    decodeRootSignatureWords(
      rootSignatureWords({
        parameters: [
          {
            type: 0,
            ranges: [
              { kind: 0, count: 1, baseRegister: 0, tableOffset: 2 },
              { kind: 2, count: 2, baseRegister: 4, tableOffset: 5 },
            ],
          },
        ],
      }),
    ),
  );
  assert.deepEqual(
    resolveDescriptorPlacement(plan, { type: DESCRIPTOR_SRV, space: 0, register: 0 }),
    {
      kind: 'table',
      parameter: 0,
      heapSlot: 2,
    },
  );
  // The second descriptor of the CBV range is one slot further along.
  assert.deepEqual(
    resolveDescriptorPlacement(plan, { type: DESCRIPTOR_CBV, space: 0, register: 5 }),
    {
      kind: 'table',
      parameter: 0,
      heapSlot: 6,
    },
  );
  // A register outside every range is not produced by this signature.
  assert.equal(
    resolveDescriptorPlacement(plan, { type: DESCRIPTOR_SRV, space: 0, register: 7 }),
    null,
  );
});

test('resolves a root descriptor and inline constants', () => {
  const constants = planRootSignature(
    decodeRootSignatureWords(
      rootSignatureWords({
        parameters: [{ type: 1, valueCount: 8, ranges: [] }],
      }),
    ),
  );
  assert.deepEqual(
    resolveDescriptorPlacement(constants, { type: DESCRIPTOR_CBV, space: 0, register: 0 }),
    {
      kind: 'inline-constants',
      parameter: 0,
    },
  );

  const rootPlan = planRootSignature(
    decodeRootSignatureWords(
      rootSignatureWords({
        parameters: [
          { type: 2, visibility: 1, register: 1, ranges: [] },
          { type: 3, visibility: 5, register: 4, ranges: [] },
        ],
      }),
    ),
  );
  assert.deepEqual(
    resolveDescriptorPlacement(rootPlan, { type: DESCRIPTOR_CBV, space: 0, register: 1 }),
    {
      kind: 'root-descriptor',
      parameter: 0,
    },
  );
  assert.deepEqual(
    resolveDescriptorPlacement(rootPlan, { type: DESCRIPTOR_SRV, space: 0, register: 4 }),
    {
      kind: 'root-descriptor',
      parameter: 1,
    },
  );
});

test('resolves a static sampler declared by the signature', () => {
  const plan = planRootSignature(decodeRootSignatureWords(REAL_WORDS));
  const placement = resolveDescriptorPlacement(plan, {
    type: DESCRIPTOR_SAMPLER,
    space: 0,
    register: 0,
  });
  assert.equal(placement.kind, 'static-sampler');
  assert.equal(placement.sampler.addressU, 3);
  assert.equal(placement.sampler.register, 0);
});

test('a static sampler shadows a same-register dynamic sampler range', () => {
  // D3D12 gives static samplers precedence over a range covering the same
  // register, so placement must report the static sampler first.
  const plan = planRootSignature(
    decodeRootSignatureWords(
      rootSignatureWords({
        parameters: [{ type: 0, ranges: [{ kind: 3, count: 2, baseRegister: 0, tableOffset: 0 }] }],
        samplers: [{ register: 0, visibility: 0 }],
      }),
    ),
  );
  assert.equal(
    resolveDescriptorPlacement(plan, { type: DESCRIPTOR_SAMPLER, space: 0, register: 0 }).kind,
    'static-sampler',
  );
  // Register 1 is not covered by the static sampler, so it is table-bound.
  assert.deepEqual(
    resolveDescriptorPlacement(plan, { type: DESCRIPTOR_SAMPLER, space: 0, register: 1 }),
    {
      kind: 'table',
      parameter: 0,
      heapSlot: 1,
    },
  );
});

test('UAV descriptors land in the storage-buffer group', () => {
  const { bindings } = canonicalBindings([
    {
      type: DESCRIPTOR_UAV,
      space: 0,
      register: 0,
      resourceType: RESOURCE_BUFFER,
      dataType: DATA_UINT,
      count: 1,
    },
  ]);
  assert.equal(bindings[0].group, UAV_GROUP);
  const uavLayout = layoutEntries(bindings, VISIBILITY).find(
    (layout) => layout.group === UAV_GROUP,
  );
  assert.deepEqual(uavLayout.entries[0].buffer, { type: 'storage' });
});
