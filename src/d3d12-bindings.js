// Canonical D3D12 root-signature binding model.
//
// A D3D12 pipeline state references a root signature, and its shaders declare
// HLSL registers (cb#, t#, u#, s#). The signature maps those registers onto
// root parameters, and the command list binds each parameter to a descriptor
// table, a root descriptor or inline constants.
//
// WebGPU needs the opposite direction: shaders whose resources carry explicit
// @group/@binding decorations, plus one bind group per resource kind. This
// module derives that layout from the signature and the shaders' declared
// descriptors. It is pure, so the allocation rules can be tested against
// independently computed expectations.
//
// Layout choice: descriptors are grouped by kind, not by root parameter.
//   group 0  constant buffer views (uniform buffers and inline constants)
//   group 1  shader resource views and unordered access views
//   group 2  samplers
// Group 3 is reserved by the shader compiler for draw parameters (base vertex
// and base instance), which vkd3d-shader emits as a uniform there, so no
// descriptor may be placed in that group.
//
// Within a group the binding is a dense index over the pipeline's declared
// descriptors of that kind, ordered by (register space, register). The order
// comes from the shader declarations rather than from first use, so one program
// always produces the same layout and both stages of a pipeline agree.

export const CBV_GROUP = 0;
export const UAV_GROUP = 1;
export const SAMPLER_GROUP = 2;
export const DRAW_PARAMETER_GROUP = 3;

export const DESCRIPTOR_SRV = 0;
export const DESCRIPTOR_UAV = 1;
export const DESCRIPTOR_CBV = 2;
export const DESCRIPTOR_SAMPLER = 3;

export const RESOURCE_BUFFER = 1;
export const RESOURCE_TEXTURE_1D = 2;
export const RESOURCE_TEXTURE_2D = 3;
export const RESOURCE_TEXTURE_2DMS = 4;
export const RESOURCE_TEXTURE_3D = 5;
export const RESOURCE_TEXTURE_CUBE = 6;
export const RESOURCE_TEXTURE_1DARRAY = 7;
export const RESOURCE_TEXTURE_2DARRAY = 8;

export const DATA_UNORM = 1;
export const DATA_SNORM = 2;
export const DATA_INT = 3;
export const DATA_UINT = 4;
export const DATA_FLOAT = 5;
export const DATA_MIXED = 6;

// WebGPU guaranteed defaults for the stages this backend uses.
export const DEFAULT_LIMITS = Object.freeze({
  maxUniformBuffers: 12,
  maxStorageBuffers: 8,
  maxSampledTextures: 16,
  maxStorageTextures: 4,
  maxSamplers: 16,
  maxBindingsPerGroup: 1000,
});

export const STATIC_SAMPLER_RECORD_WORDS = 11;

const parameterTypes = ['descriptor-table', '32-bit-constants', 'cbv', 'srv', 'uav'];
const rangeTypes = ['srv', 'uav', 'cbv', 'sampler'];
const visibilities = ['all', 'vertex', 'hull', 'domain', 'geometry', 'pixel'];
const descriptorKindNames = ['srv', 'uav', 'cbv', 'sampler'];

function invalid(message) {
  throw new Error('Unsupported D3D12 root signature: ' + message);
}

/**
 * Decodes the word array produced by the shader bridge's
 * wb_root_signature_inspect.
 *
 *   header     [parameterCount, staticSamplerCount, flags,
 *               rootConstantWords, samplerRecordWords, reserved]
 *   parameter  [type, visibility, rangeCount, register, space, valueCount,
 *               rangeBase]
 *   range      [type, count, baseRegister, space, tableOffset]
 *   sampler    [filter, addressU, addressV, addressW, lodBiasBits,
 *               maxAnisotropy, comparisonFunc, borderColour, minLodBits,
 *               maxLodBits, packedRegisterSpaceVisibility]
 *
 * Descriptor range records are written in parameter order after the whole
 * parameter block, so the number of range records is the sum of every
 * descriptor-table parameter's declared range count. The static sampler block
 * follows them.
 */
export function decodeRootSignatureWords(words) {
  if (!(words instanceof Uint32Array)) invalid('inspection words are missing');
  if (words.length < 6) invalid('header is truncated');
  const parameterCount = words[0];
  const staticSamplerCount = words[1];
  const flags = words[2];
  if (!Number.isInteger(parameterCount) || parameterCount > 64)
    invalid('parameter count is outside the inspected range');
  if (!Number.isInteger(staticSamplerCount) || staticSamplerCount > 64)
    invalid('static sampler count is outside the inspected range');
  if (words[4] !== STATIC_SAMPLER_RECORD_WORDS) invalid('unexpected static sampler record width');

  const parameterBase = 6;
  const parameterWords = 7;
  const rangeWords = 5;
  const rangeBlockStart = parameterBase + parameterCount * parameterWords;
  if (words.length < rangeBlockStart) invalid('parameter block is truncated');
  let declaredRanges = 0;
  for (let i = 0; i < parameterCount; i++) {
    const at = parameterBase + i * parameterWords;
    if (parameterTypes[words[at]] === undefined)
      invalid(`unknown root parameter type ${words[at]}`);
    if (visibilities[words[at + 1]] === undefined)
      invalid(`unknown root parameter visibility ${words[at + 1]}`);
    declaredRanges += words[at + 2];
  }
  const samplerStart = rangeBlockStart + declaredRanges * rangeWords;
  const expectedWords = samplerStart + staticSamplerCount * STATIC_SAMPLER_RECORD_WORDS;
  if (words.length !== expectedWords)
    invalid(`inspection produced ${words.length} words, expected ${expectedWords}`);

  const parameters = [];
  for (let i = 0; i < parameterCount; i++) {
    const at = parameterBase + i * parameterWords;
    parameters.push({
      index: i,
      type: parameterTypes[words[at]],
      visibility: visibilities[words[at + 1]],
      rangeCount: words[at + 2],
      register: words[at + 3],
      space: words[at + 4],
      valueCount: words[at + 5],
      rangeBase: words[at + 6],
    });
  }

  const ranges = [];
  for (const parameter of parameters) {
    if (parameter.type !== 'descriptor-table') {
      if (parameter.rangeCount) invalid('a non-table parameter declares descriptor ranges');
      continue;
    }
    for (let r = 0; r < parameter.rangeCount; r++) {
      const at = parameter.rangeBase + r * rangeWords;
      if (at + rangeWords > samplerStart) invalid('descriptor range record is truncated');
      const kind = rangeTypes[words[at]];
      if (kind === undefined) invalid(`unknown descriptor range type ${words[at]}`);
      const count = words[at + 1];
      if (!count || count > 0x100000) invalid('descriptor range count is invalid');
      ranges.push({
        parameter: parameter.index,
        index: r,
        kind,
        count,
        baseRegister: words[at + 2],
        space: words[at + 3],
        tableOffset: words[at + 4],
      });
    }
  }

  const samplers = [];
  for (let i = 0; i < staticSamplerCount; i++) {
    const at = samplerStart + i * STATIC_SAMPLER_RECORD_WORDS;
    const packed = words[at + 10];
    samplers.push({
      index: i,
      filter: words[at],
      addressU: words[at + 1],
      addressV: words[at + 2],
      addressW: words[at + 3],
      maxAnisotropy: words[at + 5],
      comparisonFunc: words[at + 6],
      borderColour: words[at + 7],
      register: packed & 0xffff,
      space: (packed >>> 16) & 0xff,
      visibility: visibilities[(packed >>> 24) & 0xff] ?? 'all',
    });
  }
  return { parameterCount, staticSamplerCount, flags, parameters, ranges, samplers };
}

/**
 * Assigns each root parameter its register-slot base. Descriptor tables claim
 * slots from their declared table offsets; root descriptors and inline
 * constants claim one slot each, in declaration order.
 */
export function planRootSignature(signature) {
  const parameters = signature.parameters.map((parameter) => {
    if (parameter.type === 'descriptor-table') {
      const ranges = signature.ranges
        .filter((range) => range.parameter === parameter.index)
        .map((range) => ({ ...range, slot: range.tableOffset }));
      if (!ranges.length) invalid('a descriptor table declares no ranges');
      let slots = 0;
      for (const range of ranges) slots = Math.max(slots, range.slot + range.count);
      return { ...parameter, ranges, slotCount: slots };
    }
    if (parameter.type === '32-bit-constants') {
      if (!parameter.valueCount || parameter.valueCount > 64)
        invalid('32-bit constants must hold 1..64 DWORDs');
      return { ...parameter, ranges: [], slotCount: 1 };
    }
    return { ...parameter, ranges: [], slotCount: 1 };
  });
  let cursor = 0;
  for (const parameter of parameters) {
    parameter.slot = cursor;
    cursor += parameter.slotCount;
  }
  if (cursor > DEFAULT_LIMITS.maxBindingsPerGroup * 4)
    invalid('the signature needs too many register slots');
  return { ...signature, parameters, slotCount: cursor };
}

function key(type, space, register) {
  return `${type}:${space}:${register}`;
}

/**
 * Assigns a canonical (group, binding) to every descriptor declared by a
 * pipeline. `descriptors` is the union of the vertex and pixel stage scans:
 * `{ type, space, register, resourceType, dataType, count, comparison }`.
 */
export function canonicalBindings(descriptors, limits = DEFAULT_LIMITS) {
  const groups = new Map([
    [CBV_GROUP, []],
    [UAV_GROUP, []],
    [SAMPLER_GROUP, []],
  ]);
  for (const descriptor of descriptors) {
    if (
      !Number.isInteger(descriptor.type) ||
      descriptor.type < DESCRIPTOR_SRV ||
      descriptor.type > DESCRIPTOR_SAMPLER
    )
      throw Error('Invalid D3D12 shader descriptor type');
    const group =
      descriptor.type === DESCRIPTOR_CBV
        ? CBV_GROUP
        : descriptor.type === DESCRIPTOR_SAMPLER
          ? SAMPLER_GROUP
          : UAV_GROUP;
    const list = groups.get(group);
    if (
      list.some(
        (entry) =>
          entry.type === descriptor.type &&
          entry.space === descriptor.space &&
          entry.register === descriptor.register,
      )
    )
      continue; // The same register declared by both stages is one binding.
    list.push({ ...descriptor, group });
  }
  const bindings = [];
  for (const group of [CBV_GROUP, UAV_GROUP, SAMPLER_GROUP]) {
    const list = groups.get(group);
    list.sort((a, b) => a.space - b.space || a.register - b.register);
    for (const [binding, entry] of list.entries()) bindings.push({ ...entry, binding });
  }
  validateLimits(bindings, limits);
  const lookup = new Map(
    bindings.map((entry) => [key(entry.type, entry.space, entry.register), entry]),
  );
  return {
    bindings,
    lookup,
    // Lazily derived so a Node-side caller that never needs GPU descriptors
    // (or runs where GPUShaderStage is absent) can still plan bindings.
    get layouts() {
      return layoutEntries(bindings);
    },
  };
}

function validateLimits(bindings, limits) {
  const count = (predicate) => bindings.filter(predicate).length;
  const checks = [
    [count((b) => b.type === DESCRIPTOR_CBV), limits.maxUniformBuffers, 'uniform buffers'],
    [count((b) => b.type === DESCRIPTOR_UAV), limits.maxStorageBuffers, 'storage buffers'],
    [count((b) => b.type === DESCRIPTOR_SRV), limits.maxSampledTextures, 'sampled textures'],
    [count((b) => b.type === DESCRIPTOR_SAMPLER), limits.maxSamplers, 'samplers'],
    [bindings.length, limits.maxBindingsPerGroup, 'descriptors'],
  ];
  for (const [actual, allowed, label] of checks)
    if (actual > allowed)
      throw Error(
        `Unsupported D3D12 pipeline: ${actual} ${label} exceed the WebGPU limit of ${allowed}`,
      );
}

/**
 * The WebGPU bind group layout entries implied by a binding list.
 *
 * `visibility` defaults to the vertex and fragment stages this backend
 * compiles. It is a parameter so the module stays usable (and testable)
 * outside a browser, where GPUShaderStage does not exist.
 */
export function layoutEntries(bindings, visibility = defaultVisibility()) {
  return [CBV_GROUP, UAV_GROUP, SAMPLER_GROUP].map((group) => ({
    group,
    entries: bindings
      .filter((binding) => binding.group === group)
      .map((binding) => ({
        binding: binding.binding,
        visibility,
        ...resourceBindingLayout(binding),
      })),
  }));
}

function defaultVisibility() {
  const stages = globalThis.GPUShaderStage;
  if (!stages) throw Error('GPUShaderStage is unavailable; pass an explicit visibility mask');
  return stages.VERTEX | stages.FRAGMENT;
}

function resourceBindingLayout(descriptor) {
  if (descriptor.type === DESCRIPTOR_CBV) return { buffer: { type: 'uniform' } };
  if (descriptor.type === DESCRIPTOR_SAMPLER)
    return { sampler: { type: descriptor.comparison ? 'comparison' : 'filtering' } };
  if (descriptor.type === DESCRIPTOR_UAV)
    return descriptor.resourceType === RESOURCE_BUFFER
      ? { buffer: { type: 'storage' } }
      : { storageTexture: { access: 'write-only', format: 'rgba8unorm' } };
  // SRV: buffers are read-only storage, everything else is a sampled texture.
  if (descriptor.resourceType === RESOURCE_BUFFER) return { buffer: { type: 'read-only-storage' } };
  return {
    texture: {
      sampleType: sampleTypeFor(descriptor.dataType),
      ...(descriptor.resourceType === RESOURCE_TEXTURE_3D ? { viewDimension: '3d' } : {}),
    },
  };
}

function sampleTypeFor(dataType) {
  if (dataType === DATA_UINT) return 'uint';
  if (dataType === DATA_INT) return 'sint';
  // Float, UNORM, SNORM and mixed-type views are all filterable floats in the
  // formats this backend models.
  return 'float';
}

/**
 * Resolves where a shader descriptor's data comes from for a bound root
 * signature. Returns one of:
 *   { kind: 'static-sampler', sampler }
 *   { kind: 'table', parameter, heapSlot }   slot index inside the bound heap
 *   { kind: 'root-descriptor', parameter }
 *   { kind: 'inline-constants', parameter }  constant registers 0..n
 *   null                                     not produced by this signature
 */
export function resolveDescriptorPlacement(plan, descriptor) {
  const kind = descriptorKindNames[descriptor.type];
  for (const sampler of plan.samplers)
    if (
      kind === 'sampler' &&
      sampler.space === descriptor.space &&
      sampler.register === descriptor.register
    )
      return { kind: 'static-sampler', sampler };
  for (const parameter of plan.parameters) {
    if (parameter.type === 'descriptor-table') {
      for (const range of parameter.ranges) {
        if (
          range.kind === kind &&
          range.space === descriptor.space &&
          descriptor.register >= range.baseRegister &&
          descriptor.register < range.baseRegister + range.count
        )
          return {
            kind: 'table',
            parameter: parameter.index,
            heapSlot: range.slot + (descriptor.register - range.baseRegister),
          };
      }
      continue;
    }
    if (kind === 'cbv' && parameter.type === '32-bit-constants') {
      if (parameter.space === 0 && descriptor.register === 0)
        return { kind: 'inline-constants', parameter: parameter.index };
      continue;
    }
    if (kind !== 'sampler' && parameter.type === kind) {
      if (parameter.space === descriptor.space && parameter.register === descriptor.register)
        return { kind: 'root-descriptor', parameter: parameter.index };
    }
  }
  return null;
}

/**
 * Resolves every canonical binding of a pipeline to the data the command list
 * has bound for it. `bindings` is the pipeline's canonical binding list, `plan`
 * the root signature plan, and `bound` the list's recorded root-parameter
 * bindings (index -> { kind, ... }).
 *
 * `resolve` maps a placement to a concrete binding entry:
 *   table            -> { heapSlot, ... } read from the bound descriptor heap
 *   root-descriptor  -> the buffer the GPU address resolved to
 *   inline-constants -> the staged 32-bit constant words
 *   static-sampler   -> the sampler the signature declares
 *
 * Returns one `{ binding, group, placement, value }` per canonical binding, or
 * throws when a register's data was never bound. Every canonical binding must
 * be resolvable: a shader register with no backing root binding would read
 * nothing, so it is an error rather than a silently empty input.
 */
export function resolveDrawBindings({ bindings, plan, bound, resolve }) {
  if (!Array.isArray(bindings)) throw Error('Invalid D3D12 binding list');
  if (!plan) throw Error('D3D12 draw requires a planned root signature');
  return bindings.map((binding) => {
    const placement = resolveDescriptorPlacement(plan, binding);
    if (!placement)
      throw Error(
        `D3D12 root signature does not declare register ${binding.register} ` +
          `(space ${binding.space}) of type ${binding.type}`,
      );
    if (placement.kind === 'static-sampler')
      return { binding, placement, value: placement.sampler };
    const entry = bound.get(placement.parameter);
    if (!entry) throw Error('D3D12 root parameter was never bound before the draw');
    if (placement.kind === 'table') {
      if (entry.kind !== 'table') throw Error('D3D12 root parameter is not bound as a table');
      return { binding, placement, value: resolve.table(entry, placement.heapSlot) };
    }
    if (placement.kind === 'root-descriptor') {
      if (entry.kind !== 'root-descriptor')
        throw Error('D3D12 root parameter is not bound as a root descriptor');
      // A root descriptor names a GPU virtual address inside the bound buffer,
      // so both the resource and the address reach the caller.
      return {
        binding,
        placement,
        value: { resource: entry.resource, address: entry.address },
      };
    }
    // inline-constants
    if (entry.kind !== 'constants') throw Error('D3D12 root parameter is not bound as constants');
    return { binding, placement, value: entry.values ?? [] };
  });
}
