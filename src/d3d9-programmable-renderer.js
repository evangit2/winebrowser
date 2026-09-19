import { ShaderCompiler } from './shader-compiler.js';

const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const CONSTANT_BYTES = { vertex: 256 * 16, pixel: 224 * 16 };

export class D3D9ProgrammableRenderer {
  constructor(owner) {
    this.owner = owner;
    this.compiler = new ShaderCompiler();
    this.pipelines = new Map();
  }

  validate(surface, command) {
    if (
      !(command.vertices instanceof Uint8Array) ||
      !integer(command.vertexCount, 3, 65535) ||
      command.vertexCount % 3 ||
      !integer(command.stride, 4, 256) ||
      command.stride % 4 ||
      command.vertices.length !== command.vertexCount * command.stride ||
      !(command.vertexShader instanceof Uint8Array) ||
      !(command.pixelShader instanceof Uint8Array) ||
      !(command.vertexConstants instanceof Float32Array) ||
      command.vertexConstants.byteLength !== CONSTANT_BYTES.vertex ||
      !(command.pixelConstants instanceof Float32Array) ||
      command.pixelConstants.byteLength !== CONSTANT_BYTES.pixel ||
      !Array.isArray(command.attributes) ||
      !command.attributes.length ||
      command.attributes.length > 16 ||
      command.attributes.some(
        (attribute) =>
          !integer(attribute.shaderLocation, 0, 15) ||
          !integer(attribute.offset, 0, command.stride - 1) ||
          !['float32', 'float32x2', 'float32x3', 'float32x4', 'unorm8x4'].includes(
            attribute.format,
          ),
      ) ||
      command.cullMode !== 'none' ||
      typeof command.depthTest !== 'boolean' ||
      typeof command.depthWrite !== 'boolean' ||
      ((command.depthTest || command.depthWrite) && !surface.depthTexture)
    )
      throw Error('Unsupported or invalid programmable D3D9 draw command');
  }

  async pipeline(surface, command) {
    const attributes = command.attributes
      .map((attribute) => `${attribute.shaderLocation}:${attribute.offset}:${attribute.format}`)
      .join(',');
    const key = [
      command.vertexShaderId,
      command.pixelShaderId,
      attributes,
      command.stride,
      !!surface.depthTexture,
      command.depthTest,
      command.depthWrite,
    ].join('|');
    let cached = this.pipelines.get(key);
    if (cached) return cached;
    const translated = await this.compiler.compileLegacyPair(
      command.vertexShader,
      command.pixelShader,
    );
    const resources = [translated.vertex.wgsl, translated.pixel.wgsl].flatMap((wgsl) =>
      [...wgsl.matchAll(/@group\((\d+)\)\s+@binding\((\d+)\)/g)].map((match) => [
        Number(match[1]),
        Number(match[2]),
      ]),
    );
    if (resources.some(([group, binding]) => group > 1 || binding !== 0))
      throw Error('D3D9 integer, boolean, texture, and sampler shader resources are unsupported');
    const usesVertexConstants = resources.some(([group]) => group === 0);
    const usesPixelConstants = resources.some(([group]) => group === 1);
    this.owner.device.pushErrorScope('validation');
    let pipeline;
    try {
      pipeline = await this.owner.device.createRenderPipelineAsync({
        label: 'Translated D3D9 programmable pipeline',
        layout: 'auto',
        vertex: {
          module: this.owner.device.createShaderModule({ code: translated.vertex.wgsl }),
          entryPoint: 'main',
          buffers: [
            {
              arrayStride: command.stride,
              attributes: command.attributes,
            },
          ],
        },
        fragment: {
          module: this.owner.device.createShaderModule({ code: translated.pixel.wgsl }),
          entryPoint: 'main',
          targets: [{ format: this.owner.format }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        ...(surface.depthTexture
          ? {
              depthStencil: {
                format: 'depth16unorm',
                depthWriteEnabled: command.depthTest && command.depthWrite,
                depthCompare: command.depthTest ? 'less-equal' : 'always',
              },
            }
          : {}),
      });
    } catch (error) {
      await this.owner.device.popErrorScope();
      throw error;
    }
    const validation = await this.owner.device.popErrorScope();
    if (validation) throw Error('Programmable D3D9 pipeline failed: ' + validation.message);
    cached = { pipeline, usesVertexConstants, usesPixelConstants };
    this.pipelines.set(key, cached);
    return cached;
  }

  buffer(slot, field, bytes, usage) {
    const size = Math.ceil(bytes.byteLength / 4) * 4;
    if (!slot[field] || slot[field + 'Size'] !== size) {
      slot[field]?.destroy();
      slot[field] = this.owner.device.createBuffer({
        size,
        usage: usage | GPUBufferUsage.COPY_DST,
      });
      slot[field + 'Size'] = size;
    }
    this.owner.device.queue.writeBuffer(slot[field], 0, bytes);
    return slot[field];
  }

  async prepare(surface, index, command) {
    this.validate(surface, command);
    const compiled = await this.pipeline(surface, command);
    surface.programmableSlots ??= [];
    const slot = (surface.programmableSlots[index] ??= {});
    const vertex = this.buffer(slot, 'vertex', command.vertices, GPUBufferUsage.VERTEX);
    const groups = [];
    for (const [group, used, constants] of [
      [0, compiled.usesVertexConstants, command.vertexConstants],
      [1, compiled.usesPixelConstants, command.pixelConstants],
    ]) {
      if (!used) continue;
      const uniform = this.buffer(slot, `constants${group}`, constants, GPUBufferUsage.UNIFORM);
      groups.push([
        group,
        this.owner.device.createBindGroup({
          layout: compiled.pipeline.getBindGroupLayout(group),
          entries: [{ binding: 0, resource: { buffer: uniform } }],
        }),
      ]);
    }
    return { command, pipeline: compiled.pipeline, vertex, groups };
  }

  draw(pass, prepared) {
    pass.setPipeline(prepared.pipeline);
    for (const [group, bindGroup] of prepared.groups) pass.setBindGroup(group, bindGroup);
    pass.setVertexBuffer(0, prepared.vertex);
    pass.draw(prepared.command.vertexCount);
  }

  trim(surface, count) {
    if (!surface.programmableSlots) return;
    for (const slot of surface.programmableSlots.splice(count))
      for (const value of Object.values(slot)) if (value?.destroy) value.destroy();
  }

  destroySurface(surface) {
    this.trim(surface, 0);
  }

  dispose() {
    this.pipelines.clear();
  }
}
