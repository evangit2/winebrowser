import { blendKey, colorTarget, needsBlendFeedback, usesBlendConstant } from './d3d-blending.js';
import { rgb565Shader, alphaTestShader } from './d3d-presentation.js';
import { primitiveState, validRasterState } from './d3d-render-state.js';
import { validStencil, validAlphaTest, stencilState } from './d3d-stencil.js';
import { validFog } from './d3d-fog.js';
import { ShaderCompiler } from './shader-compiler.js';
import { MAX_DRAW_VERTICES } from './d3d-limits.js';
import { validSnapshotFormat, snapshotPixelBytes, samplingPixelBytes } from './d3d-pixel-format.js';

const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const CONSTANT_BYTES = { vertex: 256 * 16, pixel: 224 * 16 };

// A draw's sampler-register map holds one immutable texture snapshot plus the
// sampler state for each bound register.
function validTextures(textures) {
  if (textures === undefined) return true;
  if (!(textures instanceof Map) || textures.size > 16) return false;
  let bytes = 0;
  for (const [register, binding] of textures) {
    if (!integer(register, 0, 15) || !binding || typeof binding !== 'object') return false;
    const { snapshot, sampler } = binding;
    if (
      !snapshot ||
      !validSnapshotFormat(snapshot) ||
      ![undefined, '2d', '3d', 'cube'].includes(snapshot.dimension) ||
      !Array.isArray(snapshot.levels) ||
      !snapshot.levels.length ||
      snapshot.levels.some(
        (l) =>
          !integer(l.width, 1, 2048) ||
          !integer(l.height, 1, 2048) ||
          !(l.rgba instanceof Uint8Array) ||
          (snapshot.dimension === '3d' && !integer(l.depth, 1, 256)) ||
          (snapshot.dimension !== '3d' && l.depth !== undefined) ||
          l.rgba.length !==
            l.width *
              l.height *
              (snapshot.dimension === 'cube' ? 6 : (l.depth ?? 1)) *
              snapshotPixelBytes(snapshot) ||
          (snapshot.dimension === 'cube' && l.width !== l.height),
      )
    )
      return false;
    const first = snapshot.levels[0],
      dimension = snapshot.dimension ?? '2d';
    if (
      snapshot.levels.length >
      1 + Math.floor(Math.log2(Math.max(first.width, first.height, first.depth ?? 1)))
    )
      return false;
    for (const [mip, level] of snapshot.levels.entries()) {
      if (
        level.width !== Math.max(1, first.width >> mip) ||
        level.height !== Math.max(1, first.height >> mip) ||
        (dimension === '3d' &&
          (level.depth !== Math.max(1, first.depth >> mip) ||
            level.width > 256 ||
            level.height > 256))
      )
        return false;
      bytes +=
        level.width *
        level.height *
        (dimension === 'cube' ? 6 : (level.depth ?? 1)) *
        samplingPixelBytes(snapshot);
      if (bytes > 32 * 1024 * 1024) return false;
    }
    if (!sampler || typeof sampler !== 'object') return false;
    for (const key of [1, 2, 3, 5, 6, 7]) if (!integer(sampler[key], 0, 8)) return false;
  }
  return true;
}

export class D3D9ProgrammableRenderer {
  constructor(owner) {
    this.owner = owner;
    // Factory/capability probes do not need browser shader assets. Resolve
    // those URLs only when the first programmable draw actually needs them.
    this.compiler = null;
    this.pipelines = new Map();
    this.pendingPipelines = new Map();
  }

  validate(surface, command) {
    if (
      !(command.vertices instanceof Uint8Array) ||
      !integer(command.vertexCount, 3, MAX_DRAW_VERTICES) ||
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
      !validTextures(command.textures) ||
      !validRasterState(command) ||
      !validStencil(command) ||
      !validAlphaTest(command) ||
      !validFog(command.fog) ||
      typeof command.depthTest !== 'boolean' ||
      typeof command.depthWrite !== 'boolean' ||
      ((command.depthTest || command.depthWrite) && !surface.depthTexture) ||
      (stencilState(command)[52] && surface.depthFormat !== 'depth24plus-stencil8')
    )
      throw Error('Unsupported or invalid programmable D3D9 draw command');
  }

  async pipeline(surface, command) {
    const attributes = command.attributes
      .map((attribute) => `${attribute.shaderLocation}:${attribute.offset}:${attribute.format}`)
      .join(',');
    const key = [
      blendKey(command),
      command.vertexShaderId,
      command.pixelShaderId,
      attributes,
      command.stride,
      !!surface.depthTexture,
      surface.depthFormat,
      command.depthTest,
      command.depthWrite,
      command.depthCompare ?? 'less-equal',
      command.cullMode,
      surface.colorFormat,
      surface.gpuFormat ?? this.owner.format,
      !!command.dither,
      JSON.stringify(stencilState(command)),
      JSON.stringify(command.alphaTest ?? null),
    ].join('|');
    let cached = this.pipelines.get(key);
    if (cached) return cached;
    const pending = this.pendingPipelines.get(key);
    if (pending) return pending;
    // A frame prepares hundreds of draws concurrently. Publish the promise
    // before yielding so identical draws share one translation and GPU pipeline.
    const creating = this.createPipeline(surface, command).then((compiled) => {
      this.pipelines.set(key, compiled);
      return compiled;
    });
    this.pendingPipelines.set(key, creating);
    try {
      return await creating;
    } finally {
      this.pendingPipelines.delete(key);
    }
  }

  async createPipeline(surface, command) {
    this.compiler ??= new ShaderCompiler();
    const translated = await this.compiler.compileLegacyPair(
      command.vertexShader,
      command.pixelShader,
    );
    const pixelShader = alphaTestShader(translated.pixel.wgsl, 'main', command);
    // Capture each binding's declared resource kind straight from the WGSL so
    // the bind group entries always match the automatic layout.
    const declared = [translated.vertex.wgsl, pixelShader].flatMap((wgsl) =>
      [
        ...wgsl.matchAll(
          /@group\((\d+)\)\s+@binding\((\d+)\)\s+var(?:<[^>]*>)?\s+(\w+)\s*:\s*([^;]+);/g,
        ),
      ].map((match) => ({
        group: Number(match[1]),
        binding: Number(match[2]),
        kind: match[4].trim(),
      })),
    );
    const resources = declared.map((entry) => [entry.group, entry.binding]);
    // vkd3d assigns CBVs to the register number (float=0, int=1, bool=2) and
    // textures/samplers to 16 + 2*register / 17 + 2*register in the stage's
    // group. Anything outside that layout is an unimplemented resource type.
    const constantBindings = resources.filter(([, binding]) => binding <= 2);
    if (resources.some(([group, binding]) => group > 1 || (binding > 2 && binding < 16)))
      throw Error('D3D9 unsupported programmable shader resource binding');
    const usesVertexConstants = constantBindings.some(([group]) => group === 0);
    const usesPixelConstants = constantBindings.some(([group]) => group === 1);
    const integerOrBoolean = new Set(
      constantBindings.filter(([, binding]) => binding !== 0).map(([group]) => group),
    );
    // Which groups declare image/sampler bindings; the prepare path fills them
    // from the draw's sampler registers.
    const textureGroups = new Map(),
      textureTypes = new Map();
    for (const [group, binding] of resources)
      if (binding >= 16) {
        if (binding > 31) throw Error('D3D9 shader sampler register exceeds 7');
        const groupBindings = textureGroups.get(group) ?? new Set();
        groupBindings.add(binding);
        textureGroups.set(group, groupBindings);
        const types = textureTypes.get(group) ?? new Map();
        const declaredKind = declared.find(
          (entry) => entry.group === group && entry.binding === binding,
        )?.kind;
        types.set(binding, declaredKind);
        textureTypes.set(group, types);
      }
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
          module: this.owner.device.createShaderModule({
            code:
              surface.colorFormat === 23
                ? rgb565Shader(
                    pixelShader,
                    'main',
                    command.dither,
                    needsBlendFeedback(surface, command) ? command : null,
                  )
                : pixelShader,
          }),
          entryPoint: 'main',
          targets: [colorTarget(surface, command, surface.gpuFormat ?? this.owner.format)],
        },
        primitive: primitiveState(command.cullMode),
        ...(surface.depthTexture
          ? { depthStencil: this.owner.depthStencil(surface, command) }
          : {}),
      });
    } catch (error) {
      await this.owner.device.popErrorScope();
      throw error;
    }
    const validation = await this.owner.device.popErrorScope();
    if (validation) throw Error('Programmable D3D9 pipeline failed: ' + validation.message);
    const pipelineGroupCount = Math.max(1, ...resources.map(([group]) => group + 1));
    const groupBindings = new Map();
    for (const [group, binding] of resources) {
      const set = groupBindings.get(group) ?? new Set();
      set.add(binding);
      groupBindings.set(group, set);
    }
    return {
      pipeline,
      usesVertexConstants,
      usesPixelConstants,
      integerOrBoolean,
      textureGroups,
      textureTypes,
      groupBindings,
      pipelineGroupCount,
    };
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
    // A stage's bind group holds every resource that stage declares: its CBVs
    // plus any textures and samplers. Build each group once, entries together,
    // because an automatic layout requires an exact binding-for-binding match.
    const groups = [];
    for (let group = 0; group < compiled.pipelineGroupCount; group++) {
      const entries = [];
      for (const binding of compiled.groupBindings.get(group) ?? []) {
        if (binding === 0) {
          const constants = group === 0 ? command.vertexConstants : command.pixelConstants;
          entries.push({
            binding,
            resource: {
              buffer: this.buffer(slot, `constants${group}`, constants, GPUBufferUsage.UNIFORM),
            },
          });
        } else if (binding === 1 || binding === 2) {
          // Integer and boolean constants: D3D9 programs do not write them, so
          // bind a zeroed block that satisfies the declared size.
          entries.push({
            binding,
            resource: {
              buffer: this.buffer(
                slot,
                `constants${group}_${binding}`,
                new Float32Array(256),
                GPUBufferUsage.UNIFORM,
              ),
            },
          });
        }
      }
      const textures = compiled.textureGroups.get(group);
      if (textures)
        entries.push(
          ...this.owner.textures.programmableBindings(
            surface,
            command.textures ?? new Map(),
            textures,
            compiled.textureTypes.get(group),
          ),
        );
      if (!entries.length) continue;
      this.owner.device.pushErrorScope('validation');
      const bindGroup = this.owner.device.createBindGroup({
        layout: compiled.pipeline.getBindGroupLayout(group),
        entries,
      });
      const groupError = await this.owner.device.popErrorScope();
      if (groupError)
        throw Error(
          `Programmable D3D9 bind group ${group} failed: ${groupError.message} ` +
            `(entries ${entries.map((e) => e.binding).join(',')})`,
        );
      groups.push([group, bindGroup]);
    }
    const feedback = needsBlendFeedback(surface, command);
    if (feedback) {
      // Automatic layouts have empty intervening groups when a guest shader
      // omits resources. Bind those groups so the feedback group at index 2
      // always lines up.
      for (let i = 0; i < 2; i++)
        if (!groups.some(([n]) => n === i))
          groups.push([
            i,
            this.owner.device.createBindGroup({
              layout: compiled.pipeline.getBindGroupLayout(i),
              entries: [],
            }),
          ]);
    }
    const feedbackGroup = feedback
      ? this.owner.blending.prepare(
          surface,
          slot,
          command,
          compiled.pipeline.getBindGroupLayout(2),
          usesBlendConstant(command),
        )
      : null;
    return { command, pipeline: compiled.pipeline, vertex, groups, feedbackGroup };
  }

  draw(pass, prepared, first = 0, count = prepared.command.vertexCount) {
    pass.setPipeline(prepared.pipeline);
    for (const [group, bindGroup] of prepared.groups) pass.setBindGroup(group, bindGroup);
    pass.setVertexBuffer(0, prepared.vertex);
    pass.draw(count, 1, first);
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
