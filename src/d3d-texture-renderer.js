import { validSamplerValue, validStageValue, floatState } from './d3d-texture-state.js';
const ADDRESS = { 1: 'repeat', 2: 'mirror-repeat', 3: 'clamp-to-edge' };
export function validateTexturing(t) {
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
  const first = levels[0];
  if (
    ![first.width, first.height].every((v) => Number.isInteger(v) && v > 0 && v <= 2048) ||
    levels.length > 1 + Math.floor(Math.log2(Math.max(first.width, first.height)))
  )
    throw Error('Invalid graphics texture dimensions');
  let bytes = 0;
  for (const [i, l] of levels.entries()) {
    if (
      l.width !== Math.max(1, first.width >> i) ||
      l.height !== Math.max(1, first.height >> i) ||
      !(l.rgba instanceof Uint8Array) ||
      l.rgba.length !== l.width * l.height * 4
    )
      throw Error('Invalid graphics mip level');
    bytes += l.rgba.length;
  }
  return bytes;
}
const argument = (value, texture) => {
  let expr = (value & 15) === 2 ? (texture ? 'texel' : 'input.color') : 'input.color';
  if (value & 32) expr = `vec4(${expr}.a)`;
  if (value & 16) expr = `(vec4(1.0) - ${expr})`;
  return expr;
};
function operation(op, a, b) {
  return op === 2 ? a : op === 3 ? b : op === 4 ? `(${a} * ${b})` : `min(${a} + ${b}, vec4(1.0))`;
}
export function fixedShader(command = {}) {
  const t = command.texturing,
    uv = !!(command.fvf & 0x100),
    stage = t?.stage;
  const output = t
    ? `vec4(${operation(stage[1], argument(stage[2], t.texture), argument(stage[3], t.texture))}.rgb,
    ${operation(stage[4], argument(stage[5], t.texture), argument(stage[6], t.texture))}.a)`
    : 'input.color';
  return `
struct Transforms { world: mat4x4<f32>, view: mat4x4<f32>, projection: mat4x4<f32> }
@group(0) @binding(0) var<uniform> transforms: Transforms;
${
  t
    ? `@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var imageSampler: sampler;
@group(1) @binding(2) var<uniform> lodBias: vec4<f32>;
@group(1) @binding(3) var magnificationSampler: sampler;`
    : ''
}
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32>,
  ${t ? '@location(1) uv: vec2<f32>,' : ''} }
@vertex fn vertexMain(@location(0) position: vec3<f32>, @location(1) bgra: vec4<f32>
  ${t && uv ? ', @location(2) uv: vec2<f32>' : ''}) -> VertexOut {
  var output: VertexOut;
  // D3D row-major row-vector storage is transposed when read by WGSL.
  output.position = transforms.projection * transforms.view * transforms.world * vec4(position, 1.0);
  output.color = bgra.bgra;
  ${t ? `output.uv = ${uv && stage[11] === 0 ? 'uv' : 'vec2(0.0)'};` : ''}
  return output;
}
@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4<f32> {
  ${
    !t
      ? ''
      : `
  // WebGPU chooses MAGFILTER after clamping LOD. D3D still uses MINFILTER
  // when shrinking a texture with mipmapping disabled or only one mip level.
  let dimensions = vec2<f32>(textureDimensions(image));
  let rho = max(length(dpdx(input.uv) * dimensions), length(dpdy(input.uv) * dimensions));
  let minifying = log2(max(rho, 1e-20)) + lodBias.x > 0.0;
  let small = ${t.sampler[7] ? 'textureSampleBias(image, imageSampler, input.uv, lodBias.x)' : 'textureSampleLevel(image, imageSampler, input.uv, 0.0)'};
  let large = textureSampleLevel(image, magnificationSampler, input.uv, 0.0);
  let texel = select(large, small, minifying);`
  }

  return ${output};
}`;
}
export class D3DTextureRenderer {
  constructor(owner) {
    this.owner = owner;
    this.samplers = new Map();
  }
  initialize() {
    if (this.layout) return;
    this.layout = this.owner.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.pipelineLayout = this.owner.device.createPipelineLayout({
      bindGroupLayouts: [this.owner.bindLayout, this.layout],
    });
  }
  upload(surface, slot, command) {
    const t = command.texturing;
    if (!t) {
      slot.textureUniform?.destroy();
      slot.textureUniform = null;
      slot.textureBindGroup = slot.textureView = slot.sampler = null;
      return;
    }
    this.initialize();
    const { device } = this.owner;
    surface.textures ??= new Map();
    const snapshot = t.texture;
    const key = snapshot ? `${snapshot.id}:${snapshot.revision}` : 'white';
    let cached = surface.textures.get(key);
    const levels = snapshot?.levels ?? [
      { width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]) },
    ];
    if (!cached) {
      const texture = device.createTexture({
        size: [levels[0].width, levels[0].height],
        mipLevelCount: levels.length,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      levels.forEach((l, i) =>
        device.queue.writeTexture(
          { texture, mipLevel: i },
          l.rgba,
          { bytesPerRow: l.width * 4, rowsPerImage: l.height },
          [l.width, l.height],
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
        cached.texture.createView({ baseMipLevel: base, mipLevelCount: levels.length - base }),
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
    if (
      slot.textureView === view &&
      slot.sampler === sampler &&
      slot.magnification === magnification
    )
      return;
    slot.magnification = magnification;
    slot.textureView = view;
    slot.sampler = sampler;
    slot.textureBindGroup = device.createBindGroup({
      layout: this.layout,
      entries: [
        {
          binding: 0,
          resource: view,
        },
        { binding: 1, resource: sampler },
        { binding: 3, resource: magnification },
        { binding: 2, resource: { buffer: slot.textureUniform } },
      ],
    });
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
    const used = new Set(
      commands
        .filter((c) => c.texturing)
        .map((c) => {
          const t = c.texturing.texture;
          return t ? `${t.id}:${t.revision}` : 'white';
        }),
    );
    for (const [key, value] of surface.textures ?? [])
      if (!used.has(key)) {
        value.texture.destroy();
        surface.textures.delete(key);
      }
  }
}
