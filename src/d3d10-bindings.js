// Canonical binding plan for a Direct3D 10 pipeline.
//
// D3D10 has no root signature. Each device stage owns its own register file and
// is bound independently, which is the crucial difference from the D3D12 model:
// `VSSetConstantBuffers(0, ...)` and `PSSetConstantBuffers(0, ...)` name two
// different resources that may both be visible to one draw. The D3D12 planner
// merges a register declared by both stages into a single binding; that would
// silently make a D3D10 pixel shader read the vertex shader's buffer.
//
// This module therefore plans the two stages separately and only then merges
// them into one WebGPU layout, keeping a distinct (group, binding) for every
// (stage, register). The allocation rule mirrors the D3D12 planner so the
// shared shader bridge can position registers the same way:
//
//   group 0  constant buffers
//   group 1  shader resource views and unordered access views
//   group 2  samplers
//   group 3  reserved for the draw parameters the compiler emits
//
// Within a group a binding is a dense index ordered by (space, register,
// stage), so a program always produces the same layout and both stages agree.
import {
  CBV_GROUP,
  DATA_INT,
  DATA_UINT,
  DESCRIPTOR_CBV,
  DESCRIPTOR_SAMPLER,
  DESCRIPTOR_SRV,
  DESCRIPTOR_UAV,
  DEFAULT_LIMITS,
  RESOURCE_BUFFER,
  RESOURCE_TEXTURE_3D,
  RESOURCE_TEXTURE_CUBE,
  SAMPLER_GROUP,
  UAV_GROUP,
} from './d3d12-bindings.js';

export const STAGE_VERTEX = 0;
export const STAGE_PIXEL = 1;

const STAGE_NAMES = ['vertex', 'pixel'];

function groupFor(type) {
  if (type === DESCRIPTOR_CBV) return CBV_GROUP;
  if (type === DESCRIPTOR_SAMPLER) return SAMPLER_GROUP;
  return UAV_GROUP; // SRV and UAV share the resource group.
}

function invalid(message) {
  throw new Error('Unsupported D3D10 pipeline: ' + message);
}

/**
 * Plans the canonical bindings a D3D10 draw needs.
 *
 * `vsDescriptors` and `psDescriptors` are the descriptor scans of the two
 * shaders (`{ type, space, register, resourceType, dataType, flags, count }`,
 * as `ShaderCompiler.scanDescriptors` reports them). Returns:
 *
 *   bindings        the merged list, each carrying `stage`, `group` and
 *                   `binding`, in binding order
 *   lookup          `${stage}:${type}:${space}:${register}` -> binding record
 *   vertex/pixel    the placement records each stage is compiled against
 */
export function planStageBindings(vsDescriptors, psDescriptors) {
  const stages = [
    [STAGE_VERTEX, vsDescriptors],
    [STAGE_PIXEL, psDescriptors],
  ];
  const entries = [];
  for (const [stage, descriptors] of stages) {
    if (!Array.isArray(descriptors))
      invalid(`the ${STAGE_NAMES[stage]} descriptor scan is missing`);
    const seen = new Set();
    for (const descriptor of descriptors) {
      if (
        !Number.isInteger(descriptor.type) ||
        descriptor.type < DESCRIPTOR_SRV ||
        descriptor.type > DESCRIPTOR_SAMPLER
      )
        invalid('a shader declared an unknown descriptor type');
      const key = `${descriptor.type}:${descriptor.space}:${descriptor.register}`;
      if (seen.has(key)) invalid(`the ${STAGE_NAMES[stage]} shader declares ${key} twice`);
      seen.add(key);
      entries.push({ ...descriptor, stage, group: groupFor(descriptor.type) });
    }
  }

  const bindings = [];
  for (const group of [CBV_GROUP, UAV_GROUP, SAMPLER_GROUP]) {
    const list = entries
      .filter((entry) => entry.group === group)
      .sort((a, b) => a.space - b.space || a.register - b.register || a.stage - b.stage);
    // The binding index is dense within its own group: the flat list is split
    // back into groups when the bind group layouts are built.
    for (const [binding, entry] of list.entries()) bindings.push({ ...entry, binding });
  }
  validateLimits(bindings);

  const lookup = new Map(
    bindings.map((entry) => [
      `${entry.stage}:${entry.type}:${entry.space}:${entry.register}`,
      entry,
    ]),
  );
  const placements = (stage) =>
    bindings
      .filter((entry) => entry.stage === stage)
      .map((entry) => ({
        type: entry.type,
        space: entry.space,
        register: entry.register,
        resourceType: entry.resourceType,
        count: entry.count ?? 1,
        group: entry.group,
        binding: entry.binding,
      }));
  return {
    bindings,
    lookup,
    vertex: placements(STAGE_VERTEX),
    pixel: placements(STAGE_PIXEL),
  };
}

function validateLimits(bindings) {
  const count = (predicate) => bindings.filter(predicate).length;
  const checks = [
    [count((b) => b.type === DESCRIPTOR_CBV), DEFAULT_LIMITS.maxUniformBuffers, 'uniform buffers'],
    [count((b) => b.type === DESCRIPTOR_UAV), DEFAULT_LIMITS.maxStorageBuffers, 'storage buffers'],
    [
      count((b) => b.type === DESCRIPTOR_SRV),
      DEFAULT_LIMITS.maxSampledTextures,
      'sampled textures',
    ],
    [count((b) => b.type === DESCRIPTOR_SAMPLER), DEFAULT_LIMITS.maxSamplers, 'samplers'],
    [bindings.length, DEFAULT_LIMITS.maxBindingsPerGroup, 'descriptors'],
  ];
  for (const [actual, allowed, label] of checks)
    if (actual > allowed) invalid(`${actual} ${label} exceed the WebGPU limit of ${allowed}`);
}

/** The WebGPU bind group layouts implied by a merged D3D10 binding list. */
export function stageLayoutEntries(bindings, visibility) {
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

// Mirrors the D3D12 layout mapping so a shader compiled against either frontend
// sees the same binding shapes.
function resourceBindingLayout(descriptor) {
  if (descriptor.type === DESCRIPTOR_CBV) return { buffer: { type: 'uniform' } };
  if (descriptor.type === DESCRIPTOR_SAMPLER)
    return { sampler: { type: descriptor.comparison ? 'comparison' : 'filtering' } };
  if (descriptor.type === DESCRIPTOR_UAV)
    return descriptor.resourceType === RESOURCE_BUFFER
      ? { buffer: { type: 'storage' } }
      : { storageTexture: { access: 'write-only', format: 'rgba8unorm' } };
  if (descriptor.resourceType === RESOURCE_BUFFER) return { buffer: { type: 'read-only-storage' } };
  return {
    texture: {
      sampleType: sampleTypeFor(descriptor.dataType),
      ...(descriptor.resourceType === RESOURCE_TEXTURE_3D
        ? { viewDimension: '3d' }
        : descriptor.resourceType === RESOURCE_TEXTURE_CUBE
          ? { viewDimension: 'cube' }
          : {}),
    },
  };
}

function sampleTypeFor(dataType) {
  if (dataType === DATA_UINT) return 'uint';
  if (dataType === DATA_INT) return 'sint';
  return 'float';
}
