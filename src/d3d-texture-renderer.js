import { fvfLayout } from './d3d-fvf.js';
import { lightingStruct, lightingFields, lightingCode } from './d3d-lighting.js';
import { validSamplerValue, validStageValue, floatState } from './d3d-texture-state.js';
import { alphaTestCode } from './d3d-stencil.js';
import { fogCode } from './d3d-fog.js';
import {
  snapshotFormat,
  snapshotPixelBytes,
  validSnapshotFormat,
  samplingFormat,
  samplingPixelBytes,
  samplingPixels,
} from './d3d-pixel-format.js';
const ADDRESS = { 1: 'repeat', 2: 'mirror-repeat', 3: 'clamp-to-edge' };
export const textureStages = (texturing) => texturing?.stages ?? (texturing ? [texturing] : []);
export function validateTexturing(t) {
  if (t?.stages !== undefined) {
    if (
      !Array.isArray(t.stages) ||
      t.stages.length < 2 ||
      t.stages.length > 8 ||
      t.stages.some((s) => !s || s.stages !== undefined)
    )
      throw Error('Invalid graphics texture stages');
    return t.stages.reduce((bytes, stage) => bytes + validateTexturing(stage), 0);
  }
  if (!t) return 0;
  if (
    !t.stage ||
    !t.sampler ||
    !Number.isInteger(t.lod) ||
    t.lod < 0 ||
    t.lod > 11 ||
    ![1, 2, 3, 4, 5, 6, 11, 24, 28].every((k) => validStageValue(k, t.stage[k])) ||
    ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((k) => validSamplerValue(k, t.sampler[k])) ||
    t.stage[1] === 1 ||
    t.stage[4] === 1
  )
    throw Error('Invalid graphics texture state');
  if (!t.texture) return 0;
  if (!validSnapshotFormat(t.texture)) throw Error('Invalid graphics texture format');
  const { id, revision, levels } = t.texture;
  if (
    !Number.isInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Array.isArray(levels) ||
    !levels.length ||
    levels.length > 12
  )
    throw Error('Invalid graphics texture');
  const dimension = t.texture.dimension ?? '2d';
  if (!['2d', '3d', 'cube'].includes(dimension)) throw Error('Invalid graphics texture dimension');
  const first = levels[0];
  if (
    ![first.width, first.height].every((v) => Number.isInteger(v) && v > 0 && v <= 2048) ||
    levels.length >
      1 + Math.floor(Math.log2(Math.max(first.width, first.height, first.depth ?? 1))) ||
    (dimension === 'cube' && first.width !== first.height)
  )
    throw Error('Invalid graphics texture dimensions');
  let bytes = 0;
  for (const [i, l] of levels.entries()) {
    if (
      l.width !== Math.max(1, first.width >> i) ||
      l.height !== Math.max(1, first.height >> i) ||
      !(l.rgba instanceof Uint8Array) ||
      l.rgba.length !==
        l.width *
          l.height *
          (dimension === 'cube' ? 6 : (l.depth ?? 1)) *
          snapshotPixelBytes(t.texture) ||
      (dimension === '3d' &&
        (!Number.isInteger(l.depth) ||
          l.depth < 1 ||
          l.depth > 256 ||
          l.width > 256 ||
          l.height > 256 ||
          l.depth !== Math.max(1, first.depth >> i))) ||
      (dimension !== '3d' && l.depth !== undefined)
    )
      throw Error('Invalid graphics mip level');
    bytes +=
      l.width *
      l.height *
      (dimension === 'cube' ? 6 : (l.depth ?? 1)) *
      samplingPixelBytes(t.texture);
  }
  return bytes;
}
const argument = (value, texture) => {
  let expr =
    (value & 15) === 2
      ? texture
        ? 'texel'
        : 'input.color'
      : (value & 15) === 1
        ? 'current'
        : 'input.color';
  if (value & 32) expr = `vec4(${expr}.a)`;
  if (value & 16) expr = `(vec4(1.0) - ${expr})`;
  return expr;
};
function operation(op, a, b) {
  return op === 2 ? a : op === 3 ? b : op === 4 ? `(${a} * ${b})` : `min(${a} + ${b}, vec4(1.0))`;
}
export function fixedShader(command = {}) {
  const stages = textureStages(command.texturing),
    layout = fvfLayout(command.fvf);
  const coordinate = (t) => {
    const index = t.stage[11],
      uv = layout.texcoords[index],
      dimension = t.texture?.dimension ?? '2d';
    const size = dimension === '2d' ? 2 : 3,
      name = `uv${index}`;
    if (!uv) return `vec${size}<f32>(0.0)`;
    if (uv.components === 1) return size === 2 ? `vec2(${name},0.0)` : `vec3(${name},0.0,0.0)`;
    if (uv.components < size) return `vec3(${name},0.0)`;
    return `${name}.${size === 2 ? 'xy' : 'xyz'}`;
  };
  const textureDeclarations = stages
    .map(
      (
        t,
        i,
      ) => `@group(1) @binding(${4 * i}) var image${i}: texture_${t.texture?.dimension ?? '2d'}<f32>;
@group(1) @binding(${4 * i + 1}) var imageSampler${i}: sampler;
@group(1) @binding(${4 * i + 2}) var<uniform> lodBias${i}: vec4<f32>;
@group(1) @binding(${4 * i + 3}) var magnificationSampler${i}: sampler;`,
    )
    .join('\n');
  const cascade = stages
    .map((t, i) => {
      const dimension = t.texture?.dimension ?? '2d',
        stage = t.stage;
      return `{
    let dimensions = ${dimension === '3d' ? 'vec3' : 'vec2'}<f32>(textureDimensions(image${i}));
    ${
      dimension === 'cube'
        ? `let major = max(max(abs(input.uv${i}.x),abs(input.uv${i}.y)),abs(input.uv${i}.z));
    var faceUv = input.uv${i}.xy;
    if(abs(input.uv${i}.x) >= abs(input.uv${i}.y) && abs(input.uv${i}.x) >= abs(input.uv${i}.z)) { faceUv = input.uv${i}.zy; }
    else if(abs(input.uv${i}.y) >= abs(input.uv${i}.z)) { faceUv = input.uv${i}.xz; }
    let footprintUv = faceUv / max(major, 1e-20) * 0.5;`
        : `let footprintUv = input.uv${i};`
    }
    let rho = max(length(dpdx(footprintUv) * dimensions), length(dpdy(footprintUv) * dimensions));
    let minifying = log2(max(rho, 1e-20)) + lodBias${i}.x > 0.0;
    let small = ${t.sampler[7] ? `textureSampleBias(image${i}, imageSampler${i}, input.uv${i}, lodBias${i}.x)` : `textureSampleLevel(image${i}, imageSampler${i}, input.uv${i}, 0.0)`};
    let large = textureSampleLevel(image${i}, magnificationSampler${i}, input.uv${i}, 0.0);
    let texel = select(large, small, minifying);
    current = vec4(${operation(stage[1], argument(stage[2], t.texture), argument(stage[3], t.texture))}.rgb,
      ${operation(stage[4], argument(stage[5], t.texture), argument(stage[6], t.texture))}.a);
  }`;
    })
    .join('\n');
  return `
${command.lighting ? lightingStruct : ''}
struct Transforms { world: mat4x4<f32>, view: mat4x4<f32>, projection: mat4x4<f32> ${command.lighting ? lightingFields : ''} }
@group(0) @binding(0) var<uniform> transforms: Transforms;
${textureDeclarations}
${command.lighting ? lightingCode(command, layout) : ''}
${command.fog ? fogCode(command.fog).factor : ''}
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>,
  @location(2) specular: vec4<f32>,
  ${command.fog ? '@location(5) viewDepth: f32,' : ''}
  ${stages.map((t, i) => `@location(${6 + i}) uv${i}: vec${(t.texture?.dimension ?? '2d') === '2d' ? 2 : 3}<f32>,`).join('\n')} }
@vertex fn vertexMain(@location(0) position: ${layout.rhw ? 'vec4<f32>' : 'vec3<f32>'}
  ${layout.diffuse !== null ? ', @location(1) bgra: vec4<f32>' : ''}
  ${layout.specular !== null ? ', @location(4) specularBgra: vec4<f32>' : ''}
  ${layout.normal !== null ? ', @location(3) normal: vec3<f32>' : ''}
  ${stages.length ? layout.texcoords.map((uv, i) => `, @location(${i === 0 ? 2 : 5 + i}) uv${i}: ${uv.components === 1 ? 'f32' : `vec${uv.components}<f32>`}`).join('') : ''}) -> VertexOut {
  var output: VertexOut;
  ${
    layout.rhw
      ? `let clip = transforms.projection * vec4(position.xyz, 1.0);
  let w = 1.0 / position.w;
  output.position = vec4(clip.xyz * w, w);`
      : 'output.position = transforms.projection * transforms.view * transforms.world * vec4(position, 1.0);'
  }
  let color1 = ${layout.diffuse !== null ? 'bgra.bgra' : 'vec4(1.0)'};
  let color2 = ${layout.specular !== null ? 'specularBgra.bgra' : 'vec4(0.0)'};
  ${
    command.lighting
      ? `let lit=lightVertex((transforms.view*transforms.world*vec4(position,1.0)).xyz,${layout.normal !== null ? 'normal' : 'vec3(0.0)'},color1,color2);
  output.color=lit[0];output.specular=lit[1];`
      : 'output.color=color1;output.specular=color2;'
  }
  ${stages.map((t, i) => `output.uv${i} = ${coordinate(t)};`).join('\n')}
  ${command.fog ? 'output.viewDepth = output.position.w;' : ''}
  return output;
}
@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4<f32> {
  var current = input.color;
  ${cascade}
  let color = current;
  ${alphaTestCode('color.a', command)}
  let lit = ${command.specularEnable ? 'vec4(clamp(color.rgb + input.specular.rgb,vec3(0.0),vec3(1.0)),color.a)' : 'color'};
  ${
    command.fog
      ? `let fog = clamp(winebrowser_fogFactor(input.viewDepth), 0.0, 1.0);
  return vec4(mix(${fogCode(command.fog).color}, lit.rgb, fog), lit.a);`
      : 'return lit;'
  }
}`;
}
export class D3DTextureRenderer {
  constructor(owner) {
    this.owner = owner;
    this.samplers = new Map();
  }
  initialize(dimensions = ['2d']) {
    if (!Array.isArray(dimensions)) dimensions = [dimensions];
    this.layouts ??= new Map();
    const key = dimensions.join(',');
    const cached = this.layouts.get(key);
    if (cached) {
      Object.assign(this, cached);
      return;
    }
    this.layout = this.owner.device.createBindGroupLayout({
      entries: dimensions.flatMap((dimension, index) => [
        {
          binding: 4 * index,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: dimension },
        },
        {
          binding: 4 * index + 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 4 * index + 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 4 * index + 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ]),
    });
    this.pipelineLayout = this.owner.device.createPipelineLayout({
      bindGroupLayouts: [this.owner.bindLayout, this.layout],
    });
    this.layouts.set(key, { layout: this.layout, pipelineLayout: this.pipelineLayout });
  }
  releaseSlot(slot) {
    slot.textureUniform?.destroy();
    slot.textureUniform = null;
    for (const extra of slot.textureExtraSlots ?? []) extra.textureUniform?.destroy();
    slot.textureExtraSlots = [];
    slot.textureBindGroup = slot.textureView = slot.sampler = null;
    slot.textureEntries = null;
  }
  upload(surface, slot, command) {
    const stages = textureStages(command.texturing);
    if (!stages.length) {
      this.releaseSlot(slot);
      return;
    }
    slot.textureExtraSlots ??= [];
    for (const extra of slot.textureExtraSlots.splice(stages.length - 1))
      extra.textureUniform?.destroy();
    this.initialize(stages.map((t) => t.texture?.dimension ?? '2d'));
    const entries = stages.flatMap((t, index) =>
      this.uploadStage(
        surface,
        index ? (slot.textureExtraSlots[index - 1] ??= {}) : slot,
        t,
        index,
      ),
    );
    if (
      slot.textureEntries?.length === entries.length &&
      slot.textureLayout === this.layout &&
      entries.every(
        (entry, index) =>
          (entry.resource.buffer ?? entry.resource) ===
          (slot.textureEntries[index].resource.buffer ?? slot.textureEntries[index].resource),
      )
    )
      return;
    slot.textureEntries = entries;
    slot.textureLayout = this.layout;
    slot.textureBindGroup = this.owner.device.createBindGroup({ layout: this.layout, entries });
  }
  uploadStage(surface, slot, t, index) {
    const dimension = t.texture?.dimension ?? '2d';
    const { device } = this.owner;
    surface.textures ??= new Map();
    const snapshot = t.texture;
    this.validateFormat(snapshot);
    const key = snapshot ? `${snapshot.id}:${snapshot.revision}` : 'white';
    let cached = surface.textures.get(key);
    const levels = snapshot?.levels ?? [
      { width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]) },
    ];
    if (!cached) {
      const texture = device.createTexture({
        size: [
          levels[0].width,
          levels[0].height,
          dimension === 'cube' ? 6 : (levels[0].depth ?? 1),
        ],
        dimension: dimension === 'cube' ? '2d' : dimension,
        mipLevelCount: levels.length,
        format: samplingFormat(snapshot),
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      levels.forEach((l, i) =>
        device.queue.writeTexture(
          { texture, mipLevel: i },
          samplingPixels(snapshot, l),
          { bytesPerRow: l.width * samplingPixelBytes(snapshot), rowsPerImage: l.height },
          [l.width, l.height, dimension === 'cube' ? 6 : (l.depth ?? 1)],
        ),
      );
      cached = { texture, views: new Map() };
      surface.textures.set(key, cached);
    }
    const s = t.sampler;
    const base = Math.min(Math.max(t.lod, s[7] ? s[9] : 0), levels.length - 1);
    const descriptor = {
      addressModeU: ADDRESS[s[1]],
      addressModeV: ADDRESS[s[2]],
      addressModeW: ADDRESS[s[3]],
      magFilter: s[6] === 2 ? 'linear' : 'nearest',
      minFilter: s[6] === 2 ? 'linear' : 'nearest',
      mipmapFilter: s[7] === 2 ? 'linear' : 'nearest',
      lodMinClamp: 0,
      lodMaxClamp: s[7] ? levels.length - 1 - base : 0,
    };
    const sampler = this.sampler(descriptor);
    const magnification = this.sampler({
      ...descriptor,
      minFilter: s[5] === 2 ? 'linear' : 'nearest',
      magFilter: s[5] === 2 ? 'linear' : 'nearest',
    });
    if (!cached.views.has(base))
      cached.views.set(
        base,
        cached.texture.createView({
          dimension,
          baseMipLevel: base,
          mipLevelCount: levels.length - base,
        }),
      );
    const view = cached.views.get(base);
    slot.textureUniform ??= device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // WebGPU's finite bias range ends just below +16.
    device.queue.writeBuffer(
      slot.textureUniform,
      0,
      new Float32Array([Math.min(floatState(s[8]), 15.99), 0, 0, 0]),
    );
    slot.magnification = magnification;
    slot.textureView = view;
    slot.sampler = sampler;
    return [
      { binding: 4 * index, resource: view },
      { binding: 4 * index + 1, resource: sampler },
      { binding: 4 * index + 3, resource: magnification },
      { binding: 4 * index + 2, resource: { buffer: slot.textureUniform } },
    ];
  }
  // A programmable shader samples its guest textures through the same decoded
  // snapshot cache the fixed-function path uses. Legacy sampler registers map
  // one-to-one onto the vkd3d binding layout: SRV at 16 + 2*register and its
  // sampler at 17 + 2*register.
  programmableBindings(surface, textures, expected, types = new Map()) {
    // The programmable pipeline uses an automatic layout, so the entries must
    // match exactly the bindings that group declared. expected is the set of
    // binding numbers the translated shaders use.
    const entries = [];
    const view = (snapshot, type) => {
      this.validateFormat(snapshot);
      const dimension = /texture_3d</.test(type ?? '')
        ? '3d'
        : /texture_cube</.test(type ?? '')
          ? 'cube'
          : '2d';
      if (snapshot && (snapshot.dimension ?? '2d') !== dimension)
        throw Error('D3D9 sampled texture dimension does not match its shader');
      const key = snapshot ? `${snapshot.id}:${snapshot.revision}` : `white-${dimension}`;
      surface.textures ??= new Map();
      let cached = surface.textures.get(key);
      if (!cached) {
        const levels = snapshot?.levels ?? [
          { width: 1, height: 1, rgba: new Uint8Array(dimension === 'cube' ? 24 : 4).fill(255) },
        ];
        const texture = this.owner.device.createTexture({
          size: [
            levels[0].width,
            levels[0].height,
            dimension === 'cube' ? 6 : (levels[0].depth ?? 1),
          ],
          dimension: dimension === 'cube' ? '2d' : dimension,
          mipLevelCount: levels.length,
          format: samplingFormat(snapshot),
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        levels.forEach((l, i) =>
          this.owner.device.queue.writeTexture(
            { texture, mipLevel: i },
            samplingPixels(snapshot, l),
            { bytesPerRow: l.width * samplingPixelBytes(snapshot), rowsPerImage: l.height },
            [l.width, l.height, dimension === 'cube' ? 6 : (l.depth ?? 1)],
          ),
        );
        cached = { texture, views: new Map() };
        surface.textures.set(key, cached);
      }
      if (!cached.views.has(0))
        cached.views.set(
          0,
          cached.texture.createView({
            dimension,
            baseMipLevel: 0,
            mipLevelCount: snapshot?.levels.length ?? 1,
          }),
        );
      return cached.views.get(0);
    };
    for (const binding of expected) {
      const register = (binding - 16) >> 1;
      const entry = textures.get(register);
      if (binding % 2 === 0)
        entries.push({ binding, resource: view(entry?.snapshot, types.get(binding)) });
      else
        entries.push({
          binding,
          resource: this.sampler(
            this.programmableSampler(entry?.sampler ?? { 1: 1, 2: 1, 5: 1, 6: 1, 7: 0 }),
          ),
        });
    }
    return entries;
  }

  // D3D's separate minification, magnification and mip filters map directly
  // onto WebGPU's sampler fields; address modes and the LOD clamp do too.
  programmableSampler(state) {
    const descriptor = {
      addressModeU: ADDRESS[state[1]],
      addressModeV: ADDRESS[state[2]],
      addressModeW: ADDRESS[state[3] ?? 1],
      minFilter: state[5] === 2 ? 'linear' : 'nearest',
      magFilter: state[6] === 2 ? 'linear' : 'nearest',
      mipmapFilter: state[7] === 2 ? 'linear' : 'nearest',
      lodMinClamp: 0,
      lodMaxClamp: state[7] ? 16 : 0,
    };
    return descriptor;
  }

  validateFormat(snapshot) {
    if (!validSnapshotFormat(snapshot)) throw Error('Invalid graphics texture format');
    if (snapshotFormat(snapshot) === 'rgba16unorm' && !this.owner.supportsRGBA16Unorm)
      throw Error(
        'RGBA16 UNORM textures require WebGPU texture-formats-tier1 and float32-filterable',
      );
  }

  sampler(descriptor) {
    const key = JSON.stringify(descriptor);
    if (!this.samplers.has(key)) {
      if (this.samplers.size >= 32) this.samplers.delete(this.samplers.keys().next().value);
      this.samplers.set(key, this.owner.device.createSampler(descriptor));
    }
    return this.samplers.get(key);
  }
  dispose() {
    this.layout = this.pipelineLayout = null;
    this.samplers.clear();
  }
  trim(surface, commands = []) {
    // Both render paths share the cache: fixed-function draws publish a single
    // texture in texturing, programmable draws one per sampler register. A
    // snapshot missing from here would be destroyed and re-uploaded every
    // frame, which for a 512x512 mip chain dominates the frame time.
    const used = new Set(['white-2d', 'white-3d', 'white-cube']);
    const key = (snapshot) => (snapshot ? `${snapshot.id}:${snapshot.revision}` : 'white');
    for (const c of commands) {
      for (const stage of textureStages(c.texturing)) used.add(key(stage.texture));
      for (const binding of c.textures?.values() ?? []) used.add(key(binding.snapshot));
    }
    for (const [key, value] of surface.textures ?? [])
      if (!used.has(key)) {
        value.texture.destroy();
        surface.textures.delete(key);
      }
  }
}
